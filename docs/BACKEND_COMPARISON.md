# Two backends, same pipeline

The same triage pipeline is implemented three ways: as Next.js route handlers, as an
n8n workflow calling a hosted model, and as an n8n workflow calling Ollama with no
external database at all. Both call `claude-opus-5`, both use the same taxonomy, and both
run normalise → constrained call → schema validation → one repair retry →
deterministic fallback → persist → respond.

**The Next.js implementation is the submission.** The n8n one exists because "would
you build this as code or as a workflow?" is a real question at a firm that already
runs automations, and the honest answer is "it depends on who maintains it" — which
is worth much more if you have actually built both.

| | Next.js (primary) | n8n |
|---|---|---|
| Entry point | `POST /api/try`, `scripts/triage.ts` | Webhook `POST /webhook/arootah-triage` |
| Schema enforcement | Zod → JSON Schema, one definition | Hand-written JS checks in a Code node |
| Type safety | `tsc --noEmit` in CI-able form | None — the sandbox has no TypeScript |
| Testability | `npm run eval` scores 13 labelled messages | No equivalent; would need an external harness |
| Batch runs | Bounded concurrency, hash-keyed cache | Not implemented; needs Split In Batches |
| Who can change the taxonomy | Anyone who can run `npm install` | Anyone with n8n access, no deploy |
| Observability | stdout, plus `source`/`error` columns | Per-node execution history in the UI, free |
| Failure visibility | Read the logs | See exactly which node went red |
| Cost per message | ~$0.0123 measured | Same model, same tokens — same cost |
| Nodes / files to understand | ~6 files | 12 nodes |

## The three variants

| | Next.js (primary) | n8n + OpenRouter | n8n + Ollama |
|---|---|---|---|
| File | `lib/llm.ts` | `n8n/triage-backend-workflow.json` | `n8n/triage-backend-ollama.json` |
| Model | `claude-opus-5` | `claude-opus-5` (same) | `gpt-oss:120b` (Ollama Cloud) |
| Output enforcement | schema-constrained decoding | schema-constrained decoding | **`format: json` only** |
| Storage | Supabase Postgres | Supabase Postgres | n8n Data table |
| Cost per message | ~$0.0123 | ~$0.0123 | not measured (Ollama Cloud) |
| Client data leaves the network | yes | yes | depends on the Ollama endpoint |
| Measured accuracy | 13/13 cat, 9/13 pri | same model, same prompt | **13/13 cat, 10/13 pri** |
| External dependencies | Supabase + LLM API | Supabase + LLM API | Ollama endpoint only |

## The Ollama variant, and why it is not simply "the same but free"

Two differences change the engineering, not just the bill.

**There is no schema-constrained decoding.** The Ollama node exposes
`options.format` with exactly two values, `''` and `'json'`. That guarantees the
output parses as JSON; it guarantees nothing about the shape. The hosted variants
constrain generation to the exact schema, so an invented category is close to
impossible. Here it is entirely possible.

The consequence is that `Validate Against Schema` stops being a second line of
defence and becomes **the** contract enforcement, and the repair retry moves from
a rarely-exercised safety net to a path expected to fire in normal operation. The
validator in this variant is correspondingly more defensive than its OpenRouter
twin: it checks several possible response shapes, strips markdown fences, falls
back to extracting the outermost brace pair, and coerces a numeric-looking string
confidence — all failure modes that constrained decoding made impossible upstream.

If you want the layered-guardrails argument demonstrated rather than asserted,
this is the variant to show. The layers here are load-bearing.

**Accuracy is measured now, and it is not lower.** I predicted a local/smaller model
would degrade, especially on the nuanced cases. Run over the same 13 messages with
the same ground truth:

```
model            gpt-oss:120b via Ollama Cloud, n8n backend
category         13/13   100%
priority         10/13    77%
both correct     10/13    77%
sources          llm=13   (no repairs, no fallbacks)
needs review     3
latency          p50 3.97s   p95 6.13s
```

Against the Next.js/`claude-opus-5` baseline of 13/13 category and **9/13** priority,
this is *identical* on category and **one better** on priority — and faster
(p50 3.97s vs 4.53s). My expectation was wrong, and the reason is informative:
category accuracy appears to be carried by the taxonomy and the prompt, not by model
capability. Both models place all thirteen messages correctly. What differs is the
judgement call on priority, and there the two models disagree with my labels in
almost the same places.

**The repair retry did not fire, which also contradicts what I wrote.** I said that
without schema-constrained decoding the repair path would be "expected to fire in
normal operation." Across 13 messages it fired zero times: `format: json` plus a
capable model produced schema-valid output every time. The layer is still justified —
it is the only thing standing between an invalid payload and the database on this
transport — but I should not have asserted a failure rate I had not measured.

**The cross-model finding is the useful one.** The systematic under-escalation from
RATIONALE §c reproduces here. Both models, from different labs, on different
transports, disagree with my priority labels in the same direction and on
overlapping cases:

| id | my label | claude-opus-5 | gpt-oss:120b |
|---|---|---|---|
| inb-001 | high | medium | **low** |
| inb-002 | high | medium | **high** ✓ |
| inb-009 | medium (contested) | low | low |
| inb-013 | high | medium | medium |

Two independent models declining to escalate the same messages is much stronger
evidence that my priority rules under-specify than one model doing it. A single
model disagreeing is a model problem; two agreeing with each other and not with me
is a specification problem. This is the sort of corroboration a second
implementation buys, and it is the main reason building it was worth the time.

**What it buys depends entirely on where Ollama runs, and I got this wrong first
time.** I wrote that this variant costs nothing and keeps client data on the
server. That is true of a *self-hosted* Ollama. It is not true of the credential
this workflow actually uses: every model failure came back as
`<model> was retired at <date>`, which is hosted-service language - local models
are not retired - and another workflow on the same instance calls
`https://ollama.com/v1/chat/completions` directly. So this is Ollama's hosted
service: there is a cost, and message bodies do leave the network.

The privacy argument is still the strongest reason to want this shape, but it only
holds with Ollama pointed at your own hardware. If that is the goal, point the
credential at a self-hosted endpoint and the claim becomes real. Stated plainly
because it is the kind of assumption that would be embarrassing to assert in an
interview and be wrong about.

**A finding worth acting on separately.** Every Ollama model referenced anywhere on
this n8n instance is retired: `ministral-3:14b` and `ministral-3:8b` (2026-07-15),
`qwen3-next:80b`, `qwen3-vl:235b` and `cogito-2.1:671b` (2026-06-16). That is
roughly twenty workflows that will fail the moment they run. Nothing to do with
this take-home, but it surfaced while testing and is worth fixing.

## Running the Ollama variant

Import [`n8n/triage-backend-ollama.json`](../n8n/triage-backend-ollama.json)
(14 nodes). Two manual steps:

1. **Set the model** on both `Ollama Model` nodes. Left empty deliberately: every
   model previously used on this instance is retired, so any value I filled in
   would look configured and fail. Pick a currently-available one.
2. **Create a Data table** named `arootah_triage_results` with the columns in the
   `Store Triage Result` node - all `string` except `confidence` (number) and
   `needs_review` / `low_signal` (boolean). Do not add an `id` column; n8n
   generates row IDs. The public API returns 403 on `/data-tables`, so this cannot
   be scripted with an API key - it is a UI step.

Then activate and POST to `https://n8n.srv1333076.hstgr.cloud/webhook/arootah-triage`
with the same body shape as the OpenRouter variant. Responses carry
`backend: "n8n-ollama"`.

### Two traps this variant hit, both worth knowing

**The main-flow `ollama` node did not work on this host.** It returned a generic
"Your request is invalid or could not be processed by the service" for every model
and option combination tried. Switching to `chainLlm` + the `lmChatOllama`
sub-node - the pattern every working Ollama workflow on this instance already uses -
produced real, specific provider errors immediately. When a node returns a generic
error and a sibling node returns a precise one, believe the precise one.

**`chainLlm` renders prompts through a LangChain prompt template, where `{` opens a
variable.** The original system prompt contained a literal JSON skeleton
(`{"summary": ...}`) and inbound message bodies are arbitrary text. Both break
template parsing. The fix: the system prompt describes the required keys as a list
with no braces, and `Normalize Message` doubles braces in the user prompt, which is
how LangChain renders a literal brace. Without it, any client message containing a
brace kills the run - a failure that would not appear on the 13 sample messages and
would surface in production.
