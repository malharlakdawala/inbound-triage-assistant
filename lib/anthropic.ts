import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  TriageResultSchema,
  fallbackResult,
  type SimulatedFailure,
  type TriageResult,
  type TriageSource,
} from './schema';

export type { SimulatedFailure };
import { buildUserPrompt, SYSTEM_PROMPT, PROMPT_VERSION } from './prompt';
import { CONFIDENCE_REVIEW_THRESHOLD, NEEDS_HUMAN } from './taxonomy';
import { inputHash, type NormalizedMessage } from './normalize';

export const MODEL = 'claude-opus-5';

/** claude-opus-5 list pricing, USD per million tokens. */
const PRICE_PER_MTOK = { input: 5.0, output: 25.0 } as const;

function costUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICE_PER_MTOK.input +
    (outputTokens / 1_000_000) * PRICE_PER_MTOK.output
  );
}

export interface TriageOptions {
  effort?: 'low' | 'medium' | 'high';
  simulate?: SimulatedFailure;
  /** Set false to prove the repair path is what recovers a bad first response. */
  allowRepair?: boolean;
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
  prompt_version: string;
  input_hash: string;
  /** Every attempt, in order. Kept so the UI and the eval can explain a repair. */
  attempts: Array<{ n: number; ok: boolean; detail: string }>;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and add your key.',
      );
    }
    // The SDK already retries 408/409/429/5xx with exponential backoff. Three
    // attempts is the right shape for transport flakiness; it does NOT retry a
    // schema violation, which is a different failure needing a different fix.
    client = new Anthropic({ apiKey, maxRetries: 3, timeout: 60_000 });
  }
  return client;
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

/**
 * One constrained call. Returns a validated result or throws.
 *
 * `output_config.format` constrains the model at generation time, which removes
 * essentially all shape errors. We validate anyway, because the constraint is
 * bypassed in two real cases: a `refusal` stop reason, and `max_tokens`
 * truncation — both return HTTP 200 with content that does not match the schema.
 * Trusting the constraint alone is the bug this layer exists to prevent.
 */
async function attemptOnce(
  msg: NormalizedMessage,
  effort: 'low' | 'medium' | 'high',
  repairContext: string | null,
  simulate: SimulatedFailure,
): Promise<{ result: TriageResult; input_tokens: number; output_tokens: number }> {
  if (simulate === 'api_error') {
    // Mirrors the shape of a real overloaded_error so the caller's handling is identical.
    throw new Anthropic.APIError(
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      'Simulated: API overloaded',
      new Headers(),
    );
  }

  const client = getClient();
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    // Thinking is on by default on claude-opus-5. Kept on deliberately: the
    // ambiguous cases in this set (a "no rush" prospect, an unattributable
    // follow-up) are exactly where a little reasoning changes the label.
    // `effort` is the cost dial instead of switching thinking off, which on this
    // model has its own failure modes.
    output_config: {
      effort,
      format: zodOutputFormat(TriageResultSchema),
    },
    messages: [{ role: 'user', content: buildUserPrompt(msg, repairContext, simulate) }],
  });

  const input_tokens = response.usage.input_tokens ?? 0;
  const output_tokens = response.usage.output_tokens ?? 0;

  // Guardrail 1: the model declined. Content will not match the schema.
  if (response.stop_reason === 'refusal') {
    throw new SchemaViolation(
      `Model refused (category: ${response.stop_details?.category ?? 'unknown'})`,
      null,
    );
  }
  // Guardrail 2: truncated mid-object. `parsed_output` will be null or partial.
  if (response.stop_reason === 'max_tokens') {
    throw new SchemaViolation('Response truncated at max_tokens', null);
  }

  // Guardrail 3: revalidate with Zod. `parsed_output` is typed but can be null.
  const candidate = simulate === 'malformed' ? MALFORMED_FIXTURE : response.parsed_output;
  const parsed = TriageResultSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SchemaViolation(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      candidate,
    );
  }
  return { result: parsed.data, input_tokens, output_tokens };
}

/**
 * What a broken model response actually looks like: right keys, wrong values.
 * An invented category and an out-of-range confidence are the two failures the
 * enum/range checks in the schema are there to catch.
 */
const MALFORMED_FIXTURE = {
  summary: 'Simulated malformed response.',
  category: 'very_important_client',
  priority: 'URGENT',
  next_action: '',
  confidence: 42,
  reasoning: 'Simulated invalid payload for guardrail testing.',
};

export async function triageMessage(
  msg: NormalizedMessage,
  opts: TriageOptions = {},
): Promise<TriageOutcome> {
  const effort = opts.effort ?? 'medium';
  const simulate = opts.simulate ?? 'none';
  const allowRepair = opts.allowRepair ?? true;

  const started = Date.now();
  const attempts: TriageOutcome['attempts'] = [];
  let input_tokens = 0;
  let output_tokens = 0;

  const base = {
    model: MODEL,
    prompt_version: PROMPT_VERSION,
    input_hash: inputHash(msg, PROMPT_VERSION, MODEL),
  };

  // --- Attempt 1: constrained generation -----------------------------------
  try {
    const r = await attemptOnce(msg, effort, null, simulate);
    input_tokens += r.input_tokens;
    output_tokens += r.output_tokens;
    attempts.push({ n: 1, ok: true, detail: 'valid on first pass' });
    return finish(r.result, 'llm', null);
  } catch (err) {
    attempts.push({ n: 1, ok: false, detail: describe(err) });

    // A transport error is not repairable by re-prompting — the SDK already
    // exhausted its retries, so fall straight through to the safe record.
    if (!(err instanceof SchemaViolation) || !allowRepair) {
      return finish(fallbackResult(describe(err)), 'fallback', describe(err));
    }

    // --- Attempt 2: repair ------------------------------------------------
    // Feed the specific validation failure back. One retry only: if a
    // constrained model cannot satisfy the schema twice, the input is the
    // problem, and looping costs money without changing the outcome.
    try {
      const r = await attemptOnce(
        msg,
        effort,
        `Your previous response was rejected by schema validation: ${err.message}. ` +
          `Return only fields from the allowed enums, and keep confidence between 0 and 1.`,
        // Never re-simulate on the repair pass, or the repair can never succeed.
        simulate === 'malformed' ? 'none' : simulate,
      );
      input_tokens += r.input_tokens;
      output_tokens += r.output_tokens;
      attempts.push({ n: 2, ok: true, detail: 'valid after repair' });
      return finish(r.result, 'llm_repaired', `First pass invalid: ${err.message}`);
    } catch (err2) {
      attempts.push({ n: 2, ok: false, detail: describe(err2) });
      return finish(fallbackResult(describe(err2)), 'fallback', describe(err2));
    }
  }

  function finish(result: TriageResult, source: TriageSource, error: string | null): TriageOutcome {
    // A row is queued for a human when the model is unsure, when the category is
    // one we never auto-action, or when we had to fall back. The UI shows the
    // reason rather than hiding a low-quality answer behind a clean-looking row.
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
      cost_usd: costUsd(input_tokens, output_tokens),
      ...base,
      attempts,
    };
  }
}

function describe(err: unknown): string {
  if (err instanceof SchemaViolation) return `Schema violation - ${err.message}`;
  if (err instanceof Anthropic.APIError) {
    return `API error ${err.status ?? '?'} (${(err as { type?: string }).type ?? err.name}) - ${err.message}`;
  }
  if (err instanceof Error) return `${err.name} - ${err.message}`;
  return String(err);
}
