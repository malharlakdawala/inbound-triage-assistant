import {
  workflow,
  node,
  trigger,
  sticky,
  newCredential,
  ifElse,
  expr,
} from '@n8n/workflow-sdk';

const NORMALIZE_CODE =
  "const b = $json.body ?? $json;\n\nconst ORG_SENTINELS = ['(individual)', '(unknown)', '(none)', 'n/a', 'unknown', ''];\nconst CORRUPTION_MARKERS = ['=?utf-8?', '=?iso-8859', 'content-type: multipart', '--- forwarded message truncated ---', 'boundary='];\n\nconst NUL = 0;\nconst REPLACEMENT = 65533;\n\nfunction cleanText(raw) {\n  const cleaned = [];\n  const src = String(raw == null ? '' : raw);\n  let hadNul = false;\n  let hadReplacement = false;\n  let hadControl = false;\n  let out = '';\n  for (let i = 0; i < src.length; i++) {\n    const ch = src[i];\n    const c = src.charCodeAt(i);\n    if (c === NUL) { hadNul = true; continue; }\n    if (c === REPLACEMENT) { hadReplacement = true; continue; }\n    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) { hadControl = true; continue; }\n    out += ch;\n  }\n  if (hadNul) cleaned.push('NUL bytes (U+0000) - rejected outright by Postgres text columns');\n  if (hadReplacement) cleaned.push('U+FFFD replacement characters - evidence of an earlier decode failure');\n  if (hadControl) cleaned.push('other C0 control characters');\n  let collapsed = '';\n  let prevSpace = false;\n  for (let j = 0; j < out.length; j++) {\n    const ch2 = out[j];\n    const isSpace = ch2 === ' ' || ch2 === '\\t';\n    if (isSpace && prevSpace) continue;\n    collapsed += isSpace ? ' ' : ch2;\n    prevSpace = isSpace;\n  }\n  return { text: collapsed.trim(), cleaned: cleaned };\n}\n\nfunction blankToNull(v) {\n  const t = String(v == null ? '' : v).trim();\n  return t.length ? t : null;\n}\n\nfunction alnumCount(s) {\n  const str = String(s == null ? '' : s);\n  let n = 0;\n  for (let i = 0; i < str.length; i++) {\n    const c = str.charCodeAt(i);\n    const isDigit = c >= 48 && c <= 57;\n    const isUpper = c >= 65 && c <= 90;\n    const isLower = c >= 97 && c <= 122;\n    const isNonAscii = c > 127;\n    if (isDigit || isUpper || isLower || isNonAscii) n++;\n  }\n  return n;\n}\n\nconst bodyClean = cleanText(b.body);\nconst subjClean = cleanText(b.subject);\nconst nameClean = cleanText(b.from_name);\n\nconst rawOrg = String(b.from_org == null ? '' : b.from_org).trim();\nconst from_org = ORG_SENTINELS.indexOf(rawOrg.toLowerCase()) !== -1 ? null : blankToNull(rawOrg);\n\nconst mimeWord = new RegExp('=\\\\?[\\\\w-]+\\\\?[bq]\\\\?', 'i');\nconst nameLooksCorrupt = mimeWord.test(nameClean.text);\nconst from_name = nameLooksCorrupt ? null : blankToNull(nameClean.text);\nconst subject = blankToNull(subjClean.text);\nconst body = bodyClean.text;\n\nconst reasons = [];\nconst chars = alnumCount(body) + alnumCount(subject);\nif (chars < 15) reasons.push('only ' + chars + ' alphanumeric characters in subject+body');\nconst lower = body.toLowerCase();\nlet firstMarker = null;\nfor (let k = 0; k < CORRUPTION_MARKERS.length; k++) {\n  if (lower.indexOf(CORRUPTION_MARKERS[k]) !== -1) { firstMarker = CORRUPTION_MARKERS[k]; break; }\n}\nif (firstMarker) reasons.push('transport corruption markers present (' + firstMarker + ')');\nif (nameLooksCorrupt) reasons.push('sender name is an undecoded MIME encoded-word');\n\nconst CATEGORIES = ['prospect', 'existing_client', 'vendor', 'recruiter', 'partner_referral', 'noise', 'unclear'];\nconst PRIORITIES = ['high', 'medium', 'low'];\n\nconst systemPrompt =\n  'You triage the shared inbox of Northwind Advisors, an alternative-investment and family-office advisory firm. Someone on the operations team reads each message and routes it. You do that first pass.\\n\\n' +\n  'Classify one message into exactly one category:\\n' +\n  '- prospect: A potential new client enquiring about services for themselves or their family. (routes to: Advisor / business development)\\n' +\n  '- existing_client: A current client making a request, asking a question, or raising a complaint. (routes to: Client service team)\\n' +\n  '- vendor: Someone selling a product or service to the firm. (routes to: Operations, usually declined)\\n' +\n  '- recruiter: Talent or recruiting outreach, including candidate and role pitches. (routes to: No action, informational)\\n' +\n  '- partner_referral: Another firm or professional proposing a referral or partnership, or introducing someone. (routes to: Partnerships / principal)\\n' +\n  '- noise: Automated mail, newsletters, marketing blasts. Nothing for a human to action. (routes to: No action, archive)\\n' +\n  '- unclear: Not enough signal to place the message in any other category. Use this instead of guessing. (routes to: Human review queue)\\n\\n' +\n  'Assign priority using these rules:\\n' +\n  '- high: Money or a mandate is at stake right now, the sender states a deadline within about 48 hours, or an existing client is unhappy.\\n' +\n  '- medium: A real opportunity or a genuine client request, but with no hard deadline.\\n' +\n  '- low: No action needed, automated, or the sender explicitly says it is not urgent.\\n\\n' +\n  'How to judge the harder cases:\\n\\n' +\n  'Urgency and value are different things. A well-qualified prospect who says there is no rush is genuinely low priority, because priority orders the work queue rather than scoring the opportunity. Do not promote a message because the sender seems valuable.\\n\\n' +\n  'An unhappy existing client is high priority even when they name no deadline. Complaints are how clients leave.\\n\\n' +\n  'A warm introduction from a named existing client carries more weight than a cold enquiry.\\n\\n' +\n  'When you cannot tell who the sender is or what they want, use unclear and set confidence below 0.5. This is the correct answer, not a failure. Guessing a plausible category for an unidentifiable sender produces a confident label that sends the message to the wrong team, which is worse than routing it to a human. Absence of an organisation means the sender is likely a private individual, not that they are suspicious.\\n\\n' +\n  'Some messages arrive corrupted by mail transport: undecoded MIME headers, truncation markers, control characters, or an effectively empty body. These are unclear with low confidence. Do not try to reconstruct what the message might have said.\\n\\n' +\n  'Field requirements:\\n\\n' +\n  'summary: one line, about 20 words, stating what the sender wants. No preamble.\\n' +\n  'next_action: the single next step, phrased as an imperative for the person who picks this up. Name the person where you know it. One action, not a plan.\\n' +\n  'confidence: your confidence in the category and priority together. Use the full range.\\n' +\n  'reasoning: one short sentence naming the specific rule or the specific words you relied on.';\n\nlet userPrompt = 'Triage this message.\\n\\n';\nuserPrompt += 'Channel: ' + (blankToNull(b.channel) || 'unknown') + '\\n';\nuserPrompt += 'Received: ' + (blankToNull(b.received_at) || new Date().toISOString()) + '\\n';\nuserPrompt += 'Sender name: ' + (from_name || '(not provided)') + '\\n';\nuserPrompt += 'Sender organisation: ' + (from_org || '(not provided)') + '\\n';\nuserPrompt += 'Subject: ' + (subject || '(no subject)') + '\\n\\n';\nuserPrompt += 'Body:\\n' + (body.length ? body : '(empty)');\nif (reasons.length) {\n  userPrompt += '\\n\\nNote from preprocessing: this message looks low-signal (' + reasons.join('; ') + ').';\n}\nif (bodyClean.cleaned.length) {\n  userPrompt += '\\nNote from preprocessing: removed ' + bodyClean.cleaned.join('; ') + '.';\n}\n\nconst jsonSchema = {\n  type: 'object',\n  additionalProperties: false,\n  required: ['summary', 'category', 'priority', 'next_action', 'confidence', 'reasoning'],\n  properties: {\n    summary: { type: 'string' },\n    category: { type: 'string', enum: CATEGORIES },\n    priority: { type: 'string', enum: PRIORITIES },\n    next_action: { type: 'string' },\n    confidence: { type: 'number' },\n    reasoning: { type: 'string' }\n  }\n};\n\nconst allCleaned = bodyClean.cleaned.concat(subjClean.cleaned).concat(nameClean.cleaned);\n\nreturn {\n  json: {\n    message_id: blankToNull(b.id) || ('n8n-' + $execution.id),\n    received_at: blankToNull(b.received_at) || new Date().toISOString(),\n    channel: blankToNull(b.channel) || 'unknown',\n    from_name: from_name,\n    from_org: from_org,\n    subject: subject,\n    body: body,\n    low_signal: reasons.length > 0,\n    low_signal_reasons: reasons,\n    cleaned: allCleaned,\n    prompt_version: 'v2-n8n',\n    model: 'anthropic/claude-opus-5',\n    llmBody: {\n      model: 'anthropic/claude-opus-5',\n      max_tokens: 2048,\n      messages: [\n        { role: 'system', content: systemPrompt },\n        { role: 'user', content: userPrompt }\n      ],\n      response_format: {\n        type: 'json_schema',\n        json_schema: { name: 'triage_result', strict: true, schema: jsonSchema }\n      },\n      reasoning: { effort: 'medium' },\n      usage: { include: true }\n    }\n  }\n};";

const VALIDATE_CODE =
  "const CATEGORIES = ['prospect', 'existing_client', 'vendor', 'recruiter', 'partner_referral', 'noise', 'unclear'];\nconst PRIORITIES = ['high', 'medium', 'low'];\nconst ALLOWED = ['summary', 'category', 'priority', 'next_action', 'confidence', 'reasoning'];\nconst CONFIDENCE_REVIEW_THRESHOLD = 0.6;\n\nconst resp = $json;\nconst choices = resp.choices || [];\nconst choice = choices.length ? choices[0] : {};\nconst usage = resp.usage || {};\nconst finish = choice.finish_reason || choice.native_finish_reason || null;\n\nconst issues = [];\nlet parsed = null;\n\nif (resp.error) {\n  issues.push('provider error: ' + (resp.error.message || 'unknown'));\n} else if (choice.message && choice.message.refusal) {\n  issues.push('model refused: ' + choice.message.refusal);\n} else if (finish === 'length') {\n  issues.push('response truncated at max_tokens');\n} else {\n  const content = choice.message ? choice.message.content : null;\n  if (!content) {\n    issues.push('empty content (finish_reason: ' + (finish || 'none') + ')');\n  } else {\n    try {\n      parsed = JSON.parse(content);\n    } catch (e) {\n      issues.push('content was not valid JSON');\n    }\n  }\n}\n\nfunction isNonEmptyString(v) {\n  return typeof v === 'string' && v.trim().length > 0;\n}\n\nif (parsed) {\n  if (!isNonEmptyString(parsed.summary)) issues.push('summary: must be a non-empty string');\n  if (!isNonEmptyString(parsed.next_action)) issues.push('next_action: must be a non-empty string');\n  if (CATEGORIES.indexOf(parsed.category) === -1) issues.push('category: invalid option, got ' + JSON.stringify(parsed.category));\n  if (PRIORITIES.indexOf(parsed.priority) === -1) issues.push('priority: invalid option, got ' + JSON.stringify(parsed.priority));\n  const conf = parsed.confidence;\n  if (typeof conf !== 'number' || isNaN(conf) || conf < 0 || conf > 1) {\n    issues.push('confidence: must be a number between 0 and 1, got ' + JSON.stringify(conf));\n  }\n  const keys = Object.keys(parsed);\n  const extra = [];\n  for (let i = 0; i < keys.length; i++) {\n    if (ALLOWED.indexOf(keys[i]) === -1) extra.push(keys[i]);\n  }\n  if (extra.length) issues.push('unexpected keys: ' + extra.join(', '));\n}\n\nconst src = $('Normalize Message').item.json;\nconst valid = issues.length === 0;\n\nconst result = valid ? parsed : {\n  summary: 'Could not be triaged automatically.',\n  category: 'unclear',\n  priority: 'low',\n  next_action: 'Review manually - automated triage did not produce a usable result.',\n  confidence: 0,\n  reasoning: 'Fallback record. ' + issues.join('; ')\n};\n\nconst needsReview = !valid ||\n  result.confidence < CONFIDENCE_REVIEW_THRESHOLD ||\n  result.category === 'unclear' ||\n  src.low_signal === true;\n\nreturn {\n  json: {\n    valid: valid,\n    issues: issues,\n    result: result,\n    needs_review: needsReview,\n    message_id: src.message_id,\n    prompt_version: src.prompt_version,\n    model: src.model,\n    low_signal: src.low_signal,\n    low_signal_reasons: src.low_signal_reasons,\n    cleaned: src.cleaned,\n    input_tokens: usage.prompt_tokens || 0,\n    output_tokens: usage.completion_tokens || 0,\n    cost_usd: typeof usage.cost === 'number' ? usage.cost : 0\n  }\n};";

const REPAIR_BODY_CODE =
  "const src = $('Normalize Message').item.json;\nconst issues = $json.issues || [];\nconst body = JSON.parse(JSON.stringify(src.llmBody));\nbody.messages.push({\n  role: 'user',\n  content: 'Your previous response was rejected by schema validation: ' + issues.join('; ') +\n    '. Return only values from the allowed enums, and keep confidence between 0 and 1.'\n});\nreturn { json: { llmBody: body } };";

const inboundWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Inbound Message Webhook',
    parameters: {
      httpMethod: 'POST',
      path: 'arootah-triage',
      responseMode: 'responseNode',
    },
    position: [-880, 0],
  },
  output: [
    {
      body: {
        id: 'inb-005',
        channel: 'voicemail-transcript',
        from_name: 'Robert Ellison',
        from_org: '(individual)',
        subject: '',
        body: 'Yeah, hi, this is Bob Ellison, I am a client. I just saw a fee on my last statement I do not understand and frankly I am not happy about it. Someone needs to call me back today.',
      },
    },
  ],
});

const normalizeMessage = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Normalize Message',
    parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: NORMALIZE_CODE },
    position: [-660, 0],
  },
  output: [
    {
      message_id: 'inb-005',
      from_name: 'Robert Ellison',
      from_org: null,
      subject: null,
      body: 'Yeah, hi, this is Bob Ellison, I am a client.',
      low_signal: false,
      low_signal_reasons: [],
      cleaned: [],
      prompt_version: 'v2-n8n',
      model: 'anthropic/claude-opus-5',
      llmBody: { model: 'anthropic/claude-opus-5', max_tokens: 2048 },
    },
  ],
});

const callModel = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Triage via OpenRouter',
    parameters: {
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.llmBody) }}'),
      options: { timeout: 90000, response: { response: { neverError: true } } },
    },
    credentials: { httpBearerAuth: newCredential('OpenRouter (personal)') },
    position: [-440, 0],
  },
  output: [
    {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1763, completion_tokens: 136, cost: 0.0122 },
    },
  ],
});

const validateResult = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Against Schema',
    parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: VALIDATE_CODE },
    position: [-220, 0],
  },
  output: [
    {
      valid: true,
      issues: [],
      result: {
        summary: 'Existing client disputes an unexplained fee and demands a callback today.',
        category: 'existing_client',
        priority: 'high',
        next_action: 'Call Bob Ellison today about the disputed fee.',
        confidence: 0.96,
        reasoning: 'Unhappy existing client with money in question.',
      },
      needs_review: false,
      message_id: 'inb-005',
      prompt_version: 'v2-n8n',
      model: 'anthropic/claude-opus-5',
      low_signal: false,
      cleaned: [],
      input_tokens: 1763,
      output_tokens: 136,
      cost_usd: 0.0122,
    },
  ],
});

const isValid = ifElse({
  version: 2.3,
  config: {
    name: 'Schema Valid?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [
          {
            id: 'valid-check',
            leftValue: expr('{{ $json.valid }}'),
            operator: { type: 'boolean', operation: 'true' },
            rightValue: '',
          },
        ],
        combinator: 'and',
      },
    },
    position: [0, 0],
  },
});

const buildRepairBody = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Repair Request',
    parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: REPAIR_BODY_CODE },
    position: [220, 220],
  },
  output: [{ llmBody: { model: 'anthropic/claude-opus-5', max_tokens: 2048 } }],
});

const callModelRepair = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Repair Attempt',
    parameters: {
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpBearerAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.llmBody) }}'),
      options: { timeout: 90000, response: { response: { neverError: true } } },
    },
    credentials: { httpBearerAuth: newCredential('OpenRouter (personal)') },
    position: [440, 220],
  },
  output: [
    {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1900, completion_tokens: 140, cost: 0.013 },
    },
  ],
});

const validateRepair = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Validate Repair',
    parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: VALIDATE_CODE },
    position: [660, 220],
  },
  output: [
    {
      valid: true,
      issues: [],
      result: {
        summary: 'Could not be triaged automatically.',
        category: 'unclear',
        priority: 'low',
        next_action: 'Review manually.',
        confidence: 0.3,
        reasoning: 'Recovered after schema repair.',
      },
      needs_review: true,
      message_id: 'inb-005',
      input_tokens: 1900,
      output_tokens: 140,
      cost_usd: 0.013,
    },
  ],
});

const storeResult = node({
  type: 'n8n-nodes-base.supabase',
  version: 1,
  config: {
    name: 'Store Triage Result',
    parameters: {
      resource: 'row',
      operation: 'create',
      useCustomSchema: true,
      schema: 'arootah_triage',
      tableId: 'results',
      dataToSend: 'defineBelow',
      fieldsUi: {
        fieldValues: [
          { fieldId: 'message_id', fieldValue: expr('{{ $json.message_id }}') },
          { fieldId: 'summary', fieldValue: expr('{{ $json.result.summary }}') },
          { fieldId: 'category', fieldValue: expr('{{ $json.result.category }}') },
          { fieldId: 'priority', fieldValue: expr('{{ $json.result.priority }}') },
          { fieldId: 'next_action', fieldValue: expr('{{ $json.result.next_action }}') },
          { fieldId: 'confidence', fieldValue: expr('{{ $json.result.confidence }}') },
          { fieldId: 'reasoning', fieldValue: expr('{{ $json.result.reasoning }}') },
          { fieldId: 'source', fieldValue: 'llm' },
          { fieldId: 'needs_review', fieldValue: expr('{{ $json.needs_review }}') },
          { fieldId: 'prompt_version', fieldValue: expr('{{ $json.prompt_version }}') },
          { fieldId: 'model', fieldValue: expr('{{ $json.model }}') },
          { fieldId: 'input_hash', fieldValue: expr('{{ $json.message_id }}-{{ $execution.id }}') },
          { fieldId: 'input_tokens', fieldValue: expr('{{ $json.input_tokens }}') },
          { fieldId: 'output_tokens', fieldValue: expr('{{ $json.output_tokens }}') },
          { fieldId: 'cost_usd', fieldValue: expr('{{ $json.cost_usd }}') },
        ],
      },
    },
    credentials: { supabaseApi: newCredential('Arootah Triage Supabase (personal)') },
    onError: 'continueRegularOutput',
    position: [220, -160],
  },
  output: [{ created_at: '2026-08-13T10:00:00.000Z' }],
});

const respondSuccess = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond With Triage',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ message_id: $("Validate Against Schema").item.json.message_id, result: $("Validate Against Schema").item.json.result, source: "llm", needs_review: $("Validate Against Schema").item.json.needs_review, low_signal: $("Validate Against Schema").item.json.low_signal, cleaned: $("Validate Against Schema").item.json.cleaned, backend: "n8n" }) }}'),
      options: { responseCode: 200 },
    },
    position: [440, -160],
  },
});

const respondRepaired = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond After Repair',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ message_id: $json.message_id, result: $json.result, source: $json.valid ? "llm_repaired" : "fallback", needs_review: $json.needs_review, recovered_from: $("Validate Against Schema").item.json.issues, backend: "n8n" }) }}'),
      options: { responseCode: 200 },
    },
    position: [880, 220],
  },
});

const explainer = sticky(
  '## n8n backend for the Inbound Triage Assistant\n\nSame pipeline as the Next.js implementation, expressed as a workflow: normalise, constrained LLM call, schema validation, one repair retry, deterministic fallback, persist, respond.\n\nThe two Code nodes are the interesting part. Normalize Message is a port of lib/normalize.ts and Validate Against Schema is a hand-written port of the Zod schema, because the n8n sandbox has neither Zod nor TypeScript. That duplication is the real cost of this approach and is documented in docs/BACKEND_COMPARISON.md.\n\nCredentials are placeholders on purpose. Populate them with your own OpenRouter key and your own Supabase project, not shared company credentials.',
  [normalizeMessage, callModel, validateResult],
  { color: 4 },
);

export default workflow('arootah-triage-n8n', 'Arootah Inbound Triage - n8n backend')
  .add(inboundWebhook)
  .to(normalizeMessage)
  .to(callModel)
  .to(validateResult)
  .to(
    isValid
      .onTrue(storeResult.to(respondSuccess))
      .onFalse(buildRepairBody.to(callModelRepair.to(validateRepair.to(respondRepaired)))),
  )
  .add(explainer);
