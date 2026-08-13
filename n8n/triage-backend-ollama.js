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
  "const b = $json.body ?? $json;\n\nconst ORG_SENTINELS = ['(individual)', '(unknown)', '(none)', 'n/a', 'unknown', ''];\nconst CORRUPTION_MARKERS = ['=?utf-8?', '=?iso-8859', 'content-type: multipart', '--- forwarded message truncated ---', 'boundary='];\n\nconst NUL = 0;\nconst REPLACEMENT = 65533;\n\nfunction cleanText(raw) {\n  const cleaned = [];\n  const src = String(raw == null ? '' : raw);\n  let hadNul = false;\n  let hadReplacement = false;\n  let hadControl = false;\n  let out = '';\n  for (let i = 0; i < src.length; i++) {\n    const ch = src[i];\n    const c = src.charCodeAt(i);\n    if (c === NUL) { hadNul = true; continue; }\n    if (c === REPLACEMENT) { hadReplacement = true; continue; }\n    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) { hadControl = true; continue; }\n    out += ch;\n  }\n  if (hadNul) cleaned.push('NUL bytes (U+0000)');\n  if (hadReplacement) cleaned.push('U+FFFD replacement characters - evidence of an earlier decode failure');\n  if (hadControl) cleaned.push('other C0 control characters');\n  let collapsed = '';\n  let prevSpace = false;\n  for (let j = 0; j < out.length; j++) {\n    const ch2 = out[j];\n    const isSpace = ch2 === ' ' || ch2 === '\\t';\n    if (isSpace && prevSpace) continue;\n    collapsed += isSpace ? ' ' : ch2;\n    prevSpace = isSpace;\n  }\n  return { text: collapsed.trim(), cleaned: cleaned };\n}\n\nfunction blankToNull(v) {\n  const t = String(v == null ? '' : v).trim();\n  return t.length ? t : null;\n}\n\nfunction alnumCount(s) {\n  const str = String(s == null ? '' : s);\n  let n = 0;\n  for (let i = 0; i < str.length; i++) {\n    const c = str.charCodeAt(i);\n    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c > 127) n++;\n  }\n  return n;\n}\n\nconst bodyClean = cleanText(b.body);\nconst subjClean = cleanText(b.subject);\nconst nameClean = cleanText(b.from_name);\n\nconst rawOrg = String(b.from_org == null ? '' : b.from_org).trim();\nconst from_org = ORG_SENTINELS.indexOf(rawOrg.toLowerCase()) !== -1 ? null : blankToNull(rawOrg);\n\nconst mimeWord = new RegExp('=\\\\?[\\\\w-]+\\\\?[bq]\\\\?', 'i');\nconst nameLooksCorrupt = mimeWord.test(nameClean.text);\nconst from_name = nameLooksCorrupt ? null : blankToNull(nameClean.text);\nconst subject = blankToNull(subjClean.text);\nconst body = bodyClean.text;\n\nconst reasons = [];\nconst chars = alnumCount(body) + alnumCount(subject);\nif (chars < 15) reasons.push('only ' + chars + ' alphanumeric characters in subject+body');\nconst lower = body.toLowerCase();\nlet firstMarker = null;\nfor (let k = 0; k < CORRUPTION_MARKERS.length; k++) {\n  if (lower.indexOf(CORRUPTION_MARKERS[k]) !== -1) { firstMarker = CORRUPTION_MARKERS[k]; break; }\n}\nif (firstMarker) reasons.push('transport corruption markers present (' + firstMarker + ')');\nif (nameLooksCorrupt) reasons.push('sender name is an undecoded MIME encoded-word');\n\nconst systemPrompt =\n  'You triage the shared inbox of Northwind Advisors, an alternative-investment and family-office advisory firm. Someone on the operations team reads each message and routes it. You do that first pass.\\n\\n' +\n  'Reply with a single JSON object and nothing else. No markdown fence, no commentary.\\n\\n' +\n  'Required shape:\\n' +\n  '{\"summary\": string, \"category\": string, \"priority\": string, \"next_action\": string, \"confidence\": number, \"reasoning\": string}\\n\\n' +\n  'category must be exactly one of: prospect, existing_client, vendor, recruiter, partner_referral, noise, unclear\\n' +\n  '  prospect - a potential new client enquiring for themselves or their family (routes to advisor / business development)\\n' +\n  '  existing_client - a current client making a request, asking a question, or complaining (routes to client service)\\n' +\n  '  vendor - someone selling a product or service to the firm (routes to operations)\\n' +\n  '  recruiter - talent or recruiting outreach (no action)\\n' +\n  '  partner_referral - another firm proposing a referral or partnership, or introducing someone (routes to partnerships)\\n' +\n  '  noise - automated mail, newsletters, marketing blasts (no action, archive)\\n' +\n  '  unclear - not enough signal to classify. Use this rather than guessing (routes to a human)\\n\\n' +\n  'priority must be exactly one of: high, medium, low\\n' +\n  '  high - money or a mandate is at stake now, a stated deadline within about 48 hours, or an unhappy existing client\\n' +\n  '  medium - a real opportunity or genuine client request with no hard deadline\\n' +\n  '  low - no action needed, automated, or the sender says it is not urgent\\n\\n' +\n  'confidence must be a number between 0 and 1.\\n\\n' +\n  'Judgement rules:\\n' +\n  'Urgency and value are different. A well-qualified prospect who says there is no rush is low priority, because priority orders the work queue rather than scoring the opportunity.\\n' +\n  'An unhappy existing client is high priority even with no deadline. Complaints are how clients leave.\\n' +\n  'A warm introduction from a named existing client carries more weight than a cold enquiry.\\n' +\n  'If you cannot tell who the sender is or what they want, answer unclear with confidence below 0.5. That is correct, not a failure. A confident wrong label routes the message to the wrong team, which is worse than sending it to a human. A missing organisation means the sender is probably a private individual, not that they are suspicious.\\n' +\n  'Messages corrupted by mail transport - undecoded MIME headers, truncation markers, an effectively empty body - are unclear with low confidence. Do not reconstruct what they might have said.\\n\\n' +\n  'summary: one line, about 20 words, stating what the sender wants. No preamble.\\n' +\n  'next_action: the single next step as an imperative for whoever picks this up. Name the person if known.\\n' +\n  'reasoning: one short sentence naming the rule or words you relied on.';\n\nlet userPrompt = 'Triage this message.\\n\\n';\nuserPrompt += 'Channel: ' + (blankToNull(b.channel) || 'unknown') + '\\n';\nuserPrompt += 'Sender name: ' + (from_name || '(not provided)') + '\\n';\nuserPrompt += 'Sender organisation: ' + (from_org || '(not provided)') + '\\n';\nuserPrompt += 'Subject: ' + (subject || '(no subject)') + '\\n\\n';\nuserPrompt += 'Body:\\n' + (body.length ? body : '(empty)');\nif (reasons.length) {\n  userPrompt += '\\n\\nNote from preprocessing: this message looks low-signal (' + reasons.join('; ') + ').';\n}\nif (bodyClean.cleaned.length) {\n  userPrompt += '\\nNote from preprocessing: removed ' + bodyClean.cleaned.join('; ') + '.';\n}\nuserPrompt += '\\n\\nRespond with the JSON object only.';\n\nreturn {\n  json: {\n    message_id: blankToNull(b.id) || ('n8n-' + $execution.id),\n    received_at: blankToNull(b.received_at) || new Date().toISOString(),\n    channel: blankToNull(b.channel) || 'unknown',\n    from_name: from_name,\n    from_org: from_org,\n    subject: subject,\n    body: body,\n    low_signal: reasons.length > 0,\n    low_signal_reasons: reasons,\n    cleaned: bodyClean.cleaned.concat(subjClean.cleaned).concat(nameClean.cleaned),\n    prompt_version: 'v2-ollama',\n    systemPrompt: systemPrompt,\n    userPrompt: userPrompt\n  }\n};";

const VALIDATE_CODE =
  "const CATEGORIES = ['prospect', 'existing_client', 'vendor', 'recruiter', 'partner_referral', 'noise', 'unclear'];\nconst PRIORITIES = ['high', 'medium', 'low'];\nconst ALLOWED = ['summary', 'category', 'priority', 'next_action', 'confidence', 'reasoning'];\nconst CONFIDENCE_REVIEW_THRESHOLD = 0.6;\n\nconst resp = $json;\nconst issues = [];\n\n// The Ollama node's output shape depends on the `simplify` setting and on the\n// model, so every plausible location is checked rather than assuming one. An\n// unrecognised shape is a validation failure, not a crash.\nlet raw = null;\nif (typeof resp === 'string') raw = resp;\nelse if (resp && resp.message && typeof resp.message.content === 'string') raw = resp.message.content;\nelse if (typeof resp.response === 'string') raw = resp.response;\nelse if (typeof resp.content === 'string') raw = resp.content;\nelse if (typeof resp.text === 'string') raw = resp.text;\nelse if (typeof resp.output === 'string') raw = resp.output;\nelse if (resp.output && typeof resp.output === 'object') raw = JSON.stringify(resp.output);\n\nif (resp && resp.error) {\n  issues.push('provider error: ' + (resp.error.message || resp.error));\n}\n\nlet parsed = null;\nif (!issues.length) {\n  if (raw == null) {\n    issues.push('could not locate model output in the response');\n  } else {\n    // Local models still wrap JSON in prose or a code fence even when asked not\n    // to, so fall back to the outermost brace pair before giving up.\n    let candidate = raw.trim();\n    if (candidate.indexOf('```') !== -1) {\n      candidate = candidate.replace(/```json/gi, '').replace(/```/g, '').trim();\n    }\n    try {\n      parsed = JSON.parse(candidate);\n    } catch (e) {\n      const start = candidate.indexOf('{');\n      const end = candidate.lastIndexOf('}');\n      if (start !== -1 && end > start) {\n        try {\n          parsed = JSON.parse(candidate.slice(start, end + 1));\n          issues.push('note: JSON had to be extracted from surrounding text');\n        } catch (e2) {\n          issues.push('content was not valid JSON');\n        }\n      } else {\n        issues.push('content was not valid JSON');\n      }\n    }\n  }\n}\n\nfunction isNonEmptyString(v) {\n  return typeof v === 'string' && v.trim().length > 0;\n}\n\n// A note is not a failure. Track hard errors separately so an extracted-JSON\n// note does not by itself trigger the repair retry.\nconst hardIssues = [];\nfor (let i = 0; i < issues.length; i++) {\n  if (issues[i].indexOf('note: ') !== 0) hardIssues.push(issues[i]);\n}\n\nif (parsed) {\n  if (!isNonEmptyString(parsed.summary)) hardIssues.push('summary: must be a non-empty string');\n  if (!isNonEmptyString(parsed.next_action)) hardIssues.push('next_action: must be a non-empty string');\n  if (CATEGORIES.indexOf(parsed.category) === -1) hardIssues.push('category: invalid option, got ' + JSON.stringify(parsed.category));\n  if (PRIORITIES.indexOf(parsed.priority) === -1) hardIssues.push('priority: invalid option, got ' + JSON.stringify(parsed.priority));\n  let conf = parsed.confidence;\n  if (typeof conf === 'string' && conf.trim() !== '' && !isNaN(Number(conf))) conf = Number(conf);\n  if (typeof conf !== 'number' || isNaN(conf) || conf < 0 || conf > 1) {\n    hardIssues.push('confidence: must be a number between 0 and 1, got ' + JSON.stringify(parsed.confidence));\n  } else {\n    parsed.confidence = conf;\n  }\n  const keys = Object.keys(parsed);\n  const extra = [];\n  for (let i = 0; i < keys.length; i++) {\n    if (ALLOWED.indexOf(keys[i]) === -1) extra.push(keys[i]);\n  }\n  if (extra.length) hardIssues.push('unexpected keys: ' + extra.join(', '));\n}\n\nconst src = $('Normalize Message').item.json;\nconst valid = hardIssues.length === 0 && parsed != null;\n\nconst result = valid ? {\n  summary: parsed.summary,\n  category: parsed.category,\n  priority: parsed.priority,\n  next_action: parsed.next_action,\n  confidence: parsed.confidence,\n  reasoning: isNonEmptyString(parsed.reasoning) ? parsed.reasoning : ''\n} : {\n  summary: 'Could not be triaged automatically.',\n  category: 'unclear',\n  priority: 'low',\n  next_action: 'Review manually - automated triage did not produce a usable result.',\n  confidence: 0,\n  reasoning: 'Fallback record. ' + hardIssues.join('; ')\n};\n\nconst needsReview = !valid ||\n  result.confidence < CONFIDENCE_REVIEW_THRESHOLD ||\n  result.category === 'unclear' ||\n  src.low_signal === true;\n\nreturn {\n  json: {\n    valid: valid,\n    issues: hardIssues,\n    notes: issues.filter(function (i) { return i.indexOf('note: ') === 0; }),\n    result: result,\n    needs_review: needsReview,\n    message_id: src.message_id,\n    prompt_version: src.prompt_version,\n    low_signal: src.low_signal,\n    low_signal_reasons: src.low_signal_reasons,\n    cleaned: src.cleaned,\n    prompt_eval_count: resp.prompt_eval_count || 0,\n    eval_count: resp.eval_count || 0\n  }\n};";

const REPAIR_PROMPT_CODE =
  "const src = $('Normalize Message').item.json;\nconst issues = $json.issues || [];\nconst repairPrompt = src.userPrompt +\n  '\\n\\nYour previous response was rejected: ' + issues.join('; ') +\n  '. Reply with the JSON object only. Use only the allowed category and priority values, and keep confidence between 0 and 1.';\nreturn { json: { systemPrompt: src.systemPrompt, userPrompt: repairPrompt } };";

const inboundWebhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Inbound Message Webhook',
    parameters: { httpMethod: 'POST', path: 'arootah-triage', responseMode: 'responseNode' },
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
        body: 'this is Bob Ellison, I am a client. I saw a fee on my last statement I do not understand and I am not happy. Someone needs to call me back today.',
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
      body: 'this is Bob Ellison, I am a client.',
      low_signal: false,
      low_signal_reasons: [],
      cleaned: [],
      prompt_version: 'v2-ollama',
      systemPrompt: 'You triage the shared inbox of Northwind Advisors...',
      userPrompt: 'Triage this message....',
    },
  ],
});

const callOllama = node({
  type: '@n8n/n8n-nodes-langchain.ollama',
  version: 1,
  config: {
    name: 'Triage via Ollama',
    parameters: {
      resource: 'text',
      operation: 'message',
      modelId: { __rl: true, mode: 'list', value: '' },
      messages: { values: [{ role: 'user', content: expr('{{ $json.userPrompt }}') }] },
      simplify: true,
      options: {
        system: expr('{{ $json.systemPrompt }}'),
        temperature: 0.1,
        think: false,
        format: 'json',
        num_predict: 700,
        num_ctx: 8192,
      },
    },
    credentials: { ollamaApi: newCredential('Ollama') },
    onError: 'continueRegularOutput',
    position: [-440, 0],
  },
  output: [{ message: { role: 'assistant', content: '{}' }, prompt_eval_count: 900, eval_count: 120 }],
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
      notes: [],
      result: {
        summary: 'Existing client disputes an unexplained fee and wants a callback today.',
        category: 'existing_client',
        priority: 'high',
        next_action: 'Call Bob Ellison today about the disputed fee.',
        confidence: 0.9,
        reasoning: 'Unhappy existing client with money in question.',
      },
      needs_review: false,
      message_id: 'inb-005',
      prompt_version: 'v2-ollama',
      low_signal: false,
      cleaned: [],
      prompt_eval_count: 900,
      eval_count: 120,
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

const buildRepairPrompt = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Build Repair Prompt',
    parameters: { mode: 'runOnceForEachItem', language: 'javaScript', jsCode: REPAIR_PROMPT_CODE },
    position: [220, 220],
  },
  output: [{ systemPrompt: 'You triage...', userPrompt: 'Triage this message... Your previous response was rejected...' }],
});

const callOllamaRepair = node({
  type: '@n8n/n8n-nodes-langchain.ollama',
  version: 1,
  config: {
    name: 'Repair Attempt',
    parameters: {
      resource: 'text',
      operation: 'message',
      modelId: { __rl: true, mode: 'list', value: '' },
      messages: { values: [{ role: 'user', content: expr('{{ $json.userPrompt }}') }] },
      simplify: true,
      options: {
        system: expr('{{ $json.systemPrompt }}'),
        temperature: 0,
        think: false,
        format: 'json',
        num_predict: 700,
        num_ctx: 8192,
      },
    },
    credentials: { ollamaApi: newCredential('Ollama') },
    onError: 'continueRegularOutput',
    position: [440, 220],
  },
  output: [{ message: { role: 'assistant', content: '{}' }, prompt_eval_count: 950, eval_count: 130 }],
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
      notes: [],
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
      prompt_version: 'v2-ollama',
      low_signal: false,
      cleaned: [],
      prompt_eval_count: 950,
      eval_count: 130,
    },
  ],
});

const storeResult = node({
  type: 'n8n-nodes-base.dataTable',
  version: 1.1,
  config: {
    name: 'Store Triage Result',
    parameters: {
      resource: 'row',
      operation: 'insert',
      dataTableId: { __rl: true, mode: 'name', value: 'arootah_triage_results' },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          message_id: expr('{{ $json.message_id }}'),
          summary: expr('{{ $json.result.summary }}'),
          category: expr('{{ $json.result.category }}'),
          priority: expr('{{ $json.result.priority }}'),
          next_action: expr('{{ $json.result.next_action }}'),
          confidence: expr('{{ $json.result.confidence }}'),
          reasoning: expr('{{ $json.result.reasoning }}'),
          source: expr('{{ $json.valid ? "llm" : "fallback" }}'),
          needs_review: expr('{{ $json.needs_review }}'),
          low_signal: expr('{{ $json.low_signal }}'),
          prompt_version: expr('{{ $json.prompt_version }}'),
          backend: 'n8n-ollama',
          triaged_at: expr('{{ $now.toISO() }}'),
        },
        schema: [
          { id: 'message_id', displayName: 'message_id', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'summary', displayName: 'summary', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'category', displayName: 'category', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'priority', displayName: 'priority', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'next_action', displayName: 'next_action', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'confidence', displayName: 'confidence', required: false, defaultMatch: false, display: true, type: 'number', canBeUsedToMatch: true },
          { id: 'reasoning', displayName: 'reasoning', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'source', displayName: 'source', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'needs_review', displayName: 'needs_review', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: true },
          { id: 'low_signal', displayName: 'low_signal', required: false, defaultMatch: false, display: true, type: 'boolean', canBeUsedToMatch: true },
          { id: 'prompt_version', displayName: 'prompt_version', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'backend', displayName: 'backend', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
          { id: 'triaged_at', displayName: 'triaged_at', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        ],
      },
    },
    onError: 'continueRegularOutput',
    position: [220, -160],
  },
  output: [{ id: 1, createdAt: '2026-08-13T10:00:00.000Z', updatedAt: '2026-08-13T10:00:00.000Z' }],
});

const respondSuccess = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Respond With Triage',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ message_id: $("Validate Against Schema").item.json.message_id, result: $("Validate Against Schema").item.json.result, source: "llm", needs_review: $("Validate Against Schema").item.json.needs_review, low_signal: $("Validate Against Schema").item.json.low_signal, cleaned: $("Validate Against Schema").item.json.cleaned, notes: $("Validate Against Schema").item.json.notes, backend: "n8n-ollama" }) }}'),
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
      responseBody: expr('{{ JSON.stringify({ message_id: $json.message_id, result: $json.result, source: $json.valid ? "llm_repaired" : "fallback", needs_review: $json.needs_review, recovered_from: $("Validate Against Schema").item.json.issues, backend: "n8n-ollama" }) }}'),
      options: { responseCode: 200 },
    },
    position: [880, 220],
  },
});

const explainer = sticky(
  '## n8n backend - Ollama + Data table\n\nSelf-contained: a local Ollama model does the triage and an n8n Data table stores the result, so nothing leaves this server and there is no per-call cost. For a firm handling client financial data that is the strongest argument for this variant.\n\n**Two things differ from the Next.js implementation, and both matter.** Ollama offers format:json only, not schema-constrained decoding - so Validate Against Schema is the actual contract enforcement here, not a second line of defence, and the repair retry is expected to fire in normal use. And the model is local, so accuracy is not the measured claude-opus-5 figure.\n\n**Before running:** pick your model on both Ollama nodes, attach your Ollama credential, and create a Data table named arootah_triage_results. See docs/BACKEND_COMPARISON.md.',
  [normalizeMessage, callOllama, validateResult],
  { color: 4 },
);

export default workflow('arootah-triage-n8n-ollama', 'Arootah Inbound Triage - n8n + Ollama')
  .add(inboundWebhook)
  .to(normalizeMessage)
  .to(callOllama)
  .to(validateResult)
  .to(
    isValid
      .onTrue(storeResult.to(respondSuccess))
      .onFalse(buildRepairPrompt.to(callOllamaRepair.to(validateRepair.to(respondRepaired)))),
  )
  .add(explainer);
