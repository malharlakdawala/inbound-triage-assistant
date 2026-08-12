# Prompts

The prompt is assembled in [`lib/prompt.ts`](../lib/prompt.ts), not stored as a
flat string. The category and priority blocks are generated from
[`lib/taxonomy.ts`](../lib/taxonomy.ts), which is the same module the Zod
validator and the eval harness import — so the prompt cannot drift out of sync
with the schema that enforces it. Editing the taxonomy updates the prompt, the
validator, the database lookup rows and the UI legend in one move.

`v1.md` and `v2.md` are the rendered system prompts, kept so the change between
them is inspectable rather than asserted.

## Structure

Three parts, in this order:

1. **Role and setting.** Who the firm is and who reads the output. The model
   writes a materially better `next_action` when it knows an operations person is
   about to route the message, rather than producing advice addressed to nobody.
2. **The taxonomy**, each category paired with its routing destination. Including
   the destination is deliberate: it gives the model the same test I used when
   choosing the categories, so borderline cases get resolved by asking "who would
   act on this" rather than by topic similarity.
3. **Judgement guidance for the hard cases**, then the per-field requirements.

## Parameters

| Parameter | Value | Why |
|---|---|---|
| `model` | `claude-opus-5` | Current Opus. Structured outputs supported. |
| `output_config.format` | Zod schema via `zodOutputFormat` | Constrains generation to the schema — see enforcement below. |
| `output_config.effort` | `medium` | The cost dial. `low` was measurably worse on the two ambiguous messages; `high` cost more without changing a label. |
| thinking | on (default) | Left on deliberately. The interesting cases here turn on a judgement call, and reasoning changes the label. Disabling thinking on this model has its own failure modes, so `effort` is the right dial for cost. |
| `max_tokens` | 2048 | Well clear of the ~250 tokens a result needs. Truncation would be a schema violation, so headroom is cheaper than the retry. |
| `maxRetries` | 3 (SDK) | Transport-level only: 429/5xx/timeouts, with backoff. Not used for schema failures, which need a different fix. |

## How the JSON output is enforced

Four layers, because each catches something the one before it cannot:

1. **Constrained generation.** The Zod schema is converted to JSON Schema and
   passed as `output_config.format`, so the model is constrained while decoding.
   This removes essentially all shape errors.
2. **Stop-reason checks.** A `refusal` or a `max_tokens` stop returns HTTP 200
   with content that does not satisfy the constraint. Both are checked explicitly
   before anything is parsed — trusting the constraint alone is exactly the bug
   this layer exists to prevent.
3. **Re-validation with Zod.** The parsed output is validated again in-process.
   This is what catches an invented category or an out-of-range confidence, and
   it is the layer the `--simulate malformed` flag exercises.
4. **One repair attempt, then a deterministic fallback.** On a validation
   failure the specific error is fed back and the call is retried exactly once.
   If that also fails, the row is written as `unclear` / `low` with
   `source='fallback'` and a visible badge. The row is never dropped and a
   category is never invented — a message that failed triage is precisely the one
   a human needs to see.

Retrying more than once was a deliberate cut: if a constrained model cannot
satisfy the schema twice, the input is the problem, and looping spends money
without changing the outcome.

## v1 → v2: the change I made after reading the model's output

**v1** described the categories and left `unclear` to be inferred as the
leftover option. On the low-signal messages the model preferred a confident
plausible answer to an honest one — `inb-009` (a named person following up on an
unidentifiable conversation, org `(unknown)`) came back as `prospect` with high
confidence. That is the failure mode that actually costs an advisory firm money:
the message lands in a business-development queue, nobody recognises the name,
and it quietly ages out. It is worse than routing to a human, because it *looks*
handled.

**v2** changes three things:

- Makes `unclear` an explicit instruction with a stated confidence ceiling, and
  says in as many words that using it is the correct answer rather than a
  failure.
- Separates urgency from value, because v1 promoted a "no rush" prospect
  (`inb-006`) on the strength of the opportunity being real.
- States that a missing organisation means "probably a private individual", not
  "suspicious". v1's silence on this pushed sentinel-org senders toward `vendor`.

The register also changed. v1 leaned on emphatic phrasing — the
`CRITICAL: you MUST` habit that older models needed. `claude-opus-5` follows
instructions literally, so that register makes every rule read as the most
important rule and the model stops discriminating between them. v2 states each
rule once and gives the reason, which is what actually steers this model.

Re-run `npm run eval` after any prompt edit. The prompt version is part of the
cache key, so a bump re-triages everything instead of mixing answers from two
prompts in one table, and both versions' results stay in the database for
comparison.
