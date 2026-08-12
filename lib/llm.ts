import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import {
  TriageResultSchema,
  fallbackResult,
  type SimulatedFailure,
  type TriageResult,
  type TriageSource,
} from './schema';
import { buildUserPrompt, SYSTEM_PROMPT, PROMPT_VERSION } from './prompt';
import { CONFIDENCE_REVIEW_THRESHOLD, NEEDS_HUMAN } from './taxonomy';
import { inputHash, type NormalizedMessage } from './normalize';

export type { SimulatedFailure };

/**
 * Two transports, one set of guardrails.
 *
 * The same model (claude-opus-5) is reachable either directly from Anthropic or
 * through OpenRouter. They speak different wire protocols — Anthropic has
 * `output_config.format` and `messages.parse()`, OpenRouter is OpenAI-compatible
 * and uses `response_format: {type: 'json_schema'}` — so each needs its own
 * request builder.
 *
 * What they deliberately share is everything that makes the output trustworthy:
 * schema conversion, stop-reason checks, Zod revalidation, the single repair
 * retry, and the deterministic fallback. Those live above the transport, so the
 * safety properties are a function of this file rather than of which vendor is
 * answering. That also means the reviewer can run this with whichever key they
 * happen to have.
 */
export type Provider = 'anthropic' | 'openrouter';

export function activeProvider(): Provider {
  const explicit = process.env.LLM_PROVIDER?.toLowerCase();
  if (explicit === 'anthropic' || explicit === 'openrouter') return explicit;
  // Auto-detect: prefer a direct Anthropic key, fall back to OpenRouter.
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  throw new Error(
    'No LLM credential found. Set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in .env.local.',
  );
}

/** Same underlying model; the id differs by route. */
const MODEL_IDS: Record<Provider, string> = {
  anthropic: 'claude-opus-5',
  openrouter: 'anthropic/claude-opus-5',
};

export function activeModel(provider: Provider = activeProvider()): string {
  return MODEL_IDS[provider];
}

/** Recorded as `model` so a stored row says which route produced it. */
export function modelLabel(provider: Provider = activeProvider()): string {
  return provider === 'anthropic'
    ? MODEL_IDS.anthropic
    : `${MODEL_IDS.openrouter} (via openrouter)`;
}

/** claude-opus-5 list pricing, USD per million tokens. Identical on both routes. */
const PRICE_PER_MTOK = { input: 5.0, output: 25.0 } as const;

function computeCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICE_PER_MTOK.input +
    (outputTokens / 1_000_000) * PRICE_PER_MTOK.output
  );
}

export interface TriageOptions {
  effort?: 'low' | 'medium' | 'high';
  simulate?: SimulatedFailure;
  allowRepair?: boolean;
  provider?: Provider;
}

export interface TriageOutcome {
  result: TriageResult;
  source: TriageSource;
  needs_review: boolean;
  error: string | null;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  model: string;
  provider: Provider;
  prompt_version: string;
  input_hash: string;
  attempts: Array<{ n: number; ok: boolean; detail: string }>;
}

class SchemaViolation extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
  ) {
    super(message);
    this.name = 'SchemaViolation';
  }
}

/** Transport-level failure. Not repairable by re-prompting. */
class TransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

/** What a broken model response looks like: right keys, invalid values. */
const MALFORMED_FIXTURE = {
  summary: 'Simulated malformed response.',
  category: 'very_important_client',
  priority: 'URGENT',
  next_action: '',
  confidence: 42,
  reasoning: 'Simulated invalid payload for guardrail testing.',
};

interface RawCompletion {
  /** The JSON text the model produced, or a parsed object when the SDK did it for us. */
  payload: unknown;
  input_tokens: number;
  output_tokens: number;
  /** Provider-reported cost when available (OpenRouter reports actual spend). */
  reported_cost: number | null;
}

// --------------------------------------------------------------------------
// Transport: Anthropic direct
// --------------------------------------------------------------------------

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
    anthropicClient = new Anthropic({ apiKey, maxRetries: 3, timeout: 60_000 });
  }
  return anthropicClient;
}

async function callAnthropic(
  prompt: string,
  effort: 'low' | 'medium' | 'high',
): Promise<RawCompletion> {
  const client = getAnthropic();
  let response;
  try {
    response = await client.messages.parse({
      model: MODEL_IDS.anthropic,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      output_config: { effort, format: zodOutputFormat(TriageResultSchema) },
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      throw new TransportError(
        `API error ${err.status ?? '?'} (${(err as { type?: string }).type ?? err.name}) - ${err.message}`,
      );
    }
    throw new TransportError(err instanceof Error ? err.message : String(err));
  }

  // The schema constraint is bypassed by both of these, which return HTTP 200.
  if (response.stop_reason === 'refusal') {
    throw new SchemaViolation(
      `Model refused (category: ${response.stop_details?.category ?? 'unknown'})`,
      null,
    );
  }
  if (response.stop_reason === 'max_tokens') {
    throw new SchemaViolation('Response truncated at max_tokens', null);
  }

  return {
    payload: response.parsed_output,
    input_tokens: response.usage.input_tokens ?? 0,
    output_tokens: response.usage.output_tokens ?? 0,
    reported_cost: null,
  };
}

// --------------------------------------------------------------------------
// Transport: OpenRouter (OpenAI-compatible)
// --------------------------------------------------------------------------

/**
 * Cached because converting the Zod schema on every call is pure waste, and
 * because a stable schema object keeps the request bytes identical between
 * calls, which is what lets any upstream prompt cache actually hit.
 */
/**
 * Constraints the constrained-decoding layer cannot express, and therefore
 * rejects outright: `output_config.format.schema: For 'number' type, properties
 * maximum, minimum are not supported`.
 *
 * The Anthropic SDK's `zodOutputFormat` strips these for us on the direct path.
 * The OpenRouter path builds its own JSON Schema, so it has to do the same.
 *
 * This is the concrete reason the Zod revalidation layer is not redundant with
 * constrained generation: the provider enforces the *shape* and the enums, and
 * `confidence` being within 0..1 is enforced only in-process. If we trusted the
 * constraint alone, a confidence of 42 would reach the database.
 */
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
] as const;

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((UNSUPPORTED_SCHEMA_KEYWORDS as readonly string[]).includes(key)) continue;
    out[key] = stripUnsupported(value);
  }
  return out;
}

let cachedJsonSchema: Record<string, unknown> | null = null;
function triageJsonSchema(): Record<string, unknown> {
  if (!cachedJsonSchema) {
    const generated = z.toJSONSchema(TriageResultSchema, { target: 'draft-7' }) as Record<
      string,
      unknown
    >;
    delete generated['$schema'];
    const cleaned = stripUnsupported(generated) as Record<string, unknown>;
    // OpenAI-style strict mode requires this explicitly, and it is the whole
    // point of `.strict()` on the Zod object: an extra key is a failure, not a
    // silently-ignored field.
    cleaned['additionalProperties'] = false;
    cachedJsonSchema = cleaned;
  }
  return cachedJsonSchema;
}

async function callOpenRouter(
  prompt: string,
  effort: 'low' | 'medium' | 'high',
): Promise<RawCompletion> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.');

  const body = {
    model: MODEL_IDS.openrouter,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'triage_result', strict: true, schema: triageJsonSchema() },
    },
    reasoning: { effort },
    // Ask for real spend rather than inferring it from token counts.
    usage: { include: true },
  };

  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter uses these for attribution; harmless and good manners.
        'HTTP-Referer': 'https://github.com/malharlakdawala/inbound-triage-assistant',
        'X-Title': 'Inbound Triage Assistant',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new TransportError(
      `network error - ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TransportError(`API error ${res.status} - ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string | null; refusal?: string | null };
      finish_reason?: string;
      native_finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string };
  };

  if (json.error) throw new TransportError(`provider error - ${json.error.message ?? 'unknown'}`);

  const choice = json.choices?.[0];
  const input_tokens = json.usage?.prompt_tokens ?? 0;
  const output_tokens = json.usage?.completion_tokens ?? 0;
  const reported_cost = typeof json.usage?.cost === 'number' ? json.usage.cost : null;

  // Same two constraint-bypassing cases as the Anthropic path, different names.
  if (choice?.message?.refusal) {
    throw new SchemaViolation(`Model refused - ${choice.message.refusal}`, null);
  }
  const finish = choice?.finish_reason ?? choice?.native_finish_reason;
  if (finish === 'length') {
    throw new SchemaViolation('Response truncated at max_tokens', null);
  }

  const content = choice?.message?.content;
  if (!content) {
    throw new SchemaViolation(`Empty content (finish_reason: ${finish ?? 'none'})`, json);
  }

  // Unlike the Anthropic SDK there is no parse helper, so JSON.parse failure is
  // a distinct and expected error mode here rather than an impossible one.
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    payload = { __unparseable: content.slice(0, 200) };
  }

  return { payload, input_tokens, output_tokens, reported_cost };
}

// --------------------------------------------------------------------------
// Guardrails: identical for both transports
// --------------------------------------------------------------------------

async function attemptOnce(
  msg: NormalizedMessage,
  provider: Provider,
  effort: 'low' | 'medium' | 'high',
  repairContext: string | null,
  simulate: SimulatedFailure,
): Promise<{ result: TriageResult } & Omit<RawCompletion, 'payload'>> {
  if (simulate === 'api_error') {
    throw new TransportError('API error 529 (overloaded_error) - Simulated: API overloaded');
  }

  const prompt = buildUserPrompt(msg, repairContext, simulate);
  const raw =
    provider === 'anthropic' ? await callAnthropic(prompt, effort) : await callOpenRouter(prompt, effort);

  const candidate = simulate === 'malformed' ? MALFORMED_FIXTURE : raw.payload;
  const parsed = TriageResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SchemaViolation(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      candidate,
    );
  }

  return {
    result: parsed.data,
    input_tokens: raw.input_tokens,
    output_tokens: raw.output_tokens,
    reported_cost: raw.reported_cost,
  };
}

export async function triageMessage(
  msg: NormalizedMessage,
  opts: TriageOptions = {},
): Promise<TriageOutcome> {
  const provider = opts.provider ?? activeProvider();
  const effort = opts.effort ?? 'medium';
  const simulate = opts.simulate ?? 'none';
  const allowRepair = opts.allowRepair ?? true;

  const started = Date.now();
  const attempts: TriageOutcome['attempts'] = [];
  let input_tokens = 0;
  let output_tokens = 0;
  let reported_cost: number | null = null;

  const model = modelLabel(provider);
  const base = {
    model,
    provider,
    prompt_version: PROMPT_VERSION,
    input_hash: inputHash(msg, PROMPT_VERSION, model),
  };

  try {
    const r = await attemptOnce(msg, provider, effort, null, simulate);
    input_tokens += r.input_tokens;
    output_tokens += r.output_tokens;
    reported_cost = r.reported_cost;
    attempts.push({ n: 1, ok: true, detail: 'valid on first pass' });
    return finish(r.result, 'llm', null);
  } catch (err) {
    attempts.push({ n: 1, ok: false, detail: describe(err) });

    // Only a schema failure is worth re-prompting. A transport error means the
    // SDK/fetch already exhausted its retries, so asking again just burns time.
    if (!(err instanceof SchemaViolation) || !allowRepair) {
      return finish(fallbackResult(describe(err)), 'fallback', describe(err));
    }

    try {
      const r = await attemptOnce(
        msg,
        provider,
        effort,
        `Your previous response was rejected by schema validation: ${err.message}. ` +
          `Return only values from the allowed enums, and keep confidence between 0 and 1.`,
        simulate === 'malformed' ? 'none' : simulate,
      );
      input_tokens += r.input_tokens;
      output_tokens += r.output_tokens;
      reported_cost = r.reported_cost;
      attempts.push({ n: 2, ok: true, detail: 'valid after repair' });
      return finish(r.result, 'llm_repaired', `First pass invalid: ${err.message}`);
    } catch (err2) {
      attempts.push({ n: 2, ok: false, detail: describe(err2) });
      return finish(fallbackResult(describe(err2)), 'fallback', describe(err2));
    }
  }

  function finish(result: TriageResult, source: TriageSource, error: string | null): TriageOutcome {
    const needs_review =
      source === 'fallback' ||
      result.confidence < CONFIDENCE_REVIEW_THRESHOLD ||
      NEEDS_HUMAN.includes(result.category) ||
      msg.lowSignal;

    return {
      result,
      source,
      needs_review,
      error,
      latency_ms: Date.now() - started,
      input_tokens,
      output_tokens,
      cost_usd: reported_cost ?? computeCost(input_tokens, output_tokens),
      ...base,
      attempts,
    };
  }
}

function describe(err: unknown): string {
  if (err instanceof SchemaViolation) return `Schema violation - ${err.message}`;
  if (err instanceof TransportError) return err.message;
  if (err instanceof Error) return `${err.name} - ${err.message}`;
  return String(err);
}
