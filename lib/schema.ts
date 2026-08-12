// zod/v4 specifically: the SDK's `zodOutputFormat` helper is typed against
// zod/v4, so the schema handed to it has to come from the same surface.
import * as z from 'zod/v4';
import { CATEGORIES, PRIORITIES } from './taxonomy';

/**
 * The single source of truth for the shape the LLM must return.
 *
 * This object is used three times, which is the point:
 *   1. converted to JSON Schema and handed to the API as `output_config.format`,
 *      so the model is constrained at generation time;
 *   2. used to validate whatever comes back, because constrained != guaranteed
 *      (refusals and max_tokens truncation both bypass the constraint);
 *   3. used by the eval harness to type the ground-truth labels.
 *
 * One schema, three consumers — so the contract cannot drift between the prompt,
 * the parser, and the tests.
 */
export const TriageResultSchema = z
  .object({
    summary: z
      .string()
      .min(1)
      .max(200)
      .describe('One line, max ~20 words, describing what the sender wants. No preamble.'),
    category: z.enum(CATEGORIES).describe('Exactly one category from the allowed list.'),
    priority: z.enum(PRIORITIES).describe('Priority per the stated rules.'),
    next_action: z
      .string()
      .min(1)
      .max(200)
      .describe('The single concrete next step, phrased as an imperative. No hedging.'),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('0-1. How confident you are in the category and priority together.'),
    reasoning: z
      .string()
      .max(300)
      .describe('One short sentence citing the specific rule or evidence used.'),
  })
  .strict();

export type TriageResult = z.infer<typeof TriageResultSchema>;

/** How a given row was produced — surfaced in the UI so failures are never silent. */
export const TriageSourceSchema = z.enum([
  'llm', // clean first pass
  'llm_repaired', // model returned something invalid; second constrained attempt succeeded
  'fallback', // both attempts failed, or the API errored — deterministic placeholder
]);
export type TriageSource = z.infer<typeof TriageSourceSchema>;

/**
 * Deliberately injectable failure modes.
 *
 * The brief requires the tool to survive a malformed message and an API error,
 * and the Loom has to *show* one. Waiting for a real 529 on camera is not a plan,
 * so both paths are triggerable on demand. This scaffolding exercises the real
 * error handling rather than mocking past it.
 *
 * Lives here rather than in anthropic.ts because both the prompt builder and the
 * client need it, and importing it from the client would create a cycle.
 */
export type SimulatedFailure = 'none' | 'api_error' | 'malformed' | 'refusal';

export interface TriageRecord {
  message_id: string;
  result: TriageResult;
  source: TriageSource;
  needs_review: boolean;
  /** Populated when source is `fallback` or `llm_repaired`, so the UI can explain itself. */
  error: string | null;
  prompt_version: string;
  model: string;
  input_hash: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/**
 * The record we store when the model cannot give us a usable answer.
 *
 * Chosen deliberately: `unclear` + `low` + an explicit human next_action. The tool
 * must never invent a category to fill a hole, and it must never drop the row —
 * a message that fails triage is exactly the message a human needs to see, so it
 * stays in the queue wearing a visible failure badge.
 */
export function fallbackResult(reason: string): TriageResult {
  return {
    summary: 'Could not be triaged automatically.',
    category: 'unclear',
    priority: 'low',
    next_action: 'Review manually — automated triage did not produce a usable result.',
    confidence: 0,
    reasoning: `Fallback record. ${reason}`,
  };
}
