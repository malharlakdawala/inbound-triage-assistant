# Two backends, same pipeline

The same triage pipeline is implemented three ways: as Next.js route handlers, as an
n8n workflow calling a hosted model, and as an n8n workflow calling a **local**
model with no external database at all. Both call `claude-opus-5`, both use the same taxonomy, and both
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
| Model | `claude-opus-5` | `claude-opus-5` (same) | local, your choice |
| Output enforcement | schema-constrained decoding | schema-constrained decoding | **`format: json` only** |
| Storage | Supabase Postgres | Supabase Postgres | n8n Data table |
| Cost per message | ~$0.0123 | ~$0.0123 | **$0** |
| Client data leaves the network | yes | yes | **no** |
| Measured accuracy | 13/13 category | same model, same prompt | **unmeasured** |
| External dependencies | Supabase + LLM API | Supabase + LLM API | **none** |

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

**Accuracy is unmeasured and will be lower.** The 13/13 category figure was
measured on `claude-opus-5`. A local model has not been scored on this corpus, and
I would expect the nuanced cases to degrade first: `inb-006` (a real prospect who
says "no rush" — low urgency, high value) and `inb-009` (a named human with no
recoverable context, where the correct answer is to admit ignorance). Both require
resisting an obvious-looking wrong answer, which is exactly where smaller models
struggle.

`npm run eval` scores whatever is in the database, so the honest way to find out is
to drive the webhook over all 13 messages and score the responses — not to assume
the number transfers.

**What it buys, which is not small.** Zero marginal cost, and **no client message
ever leaves the server**. For an advisory firm this is the serious argument: real
inbound mail contains client financial details, and the hosted variants send those
to a third-party API — via OpenRouter, to a second processor. A local model removes
that entirely, and removes the data-protection conversation with it. If I were
proposing this to a compliance-conscious firm, I would lead with the local variant
and treat the accuracy gap as the thing to measure and close, not as a reason to
dismiss it.

## Running the Ollama variant

Import [`n8n/triage-backend-ollama.json`](../n8n/triage-backend-ollama.json)
(12 nodes, no credentials embedded), then three manual steps I could not do for you:

1. **Pick the model** on both `Triage via Ollama` and `Repair Attempt`. The model
   selector is left empty on purpose — I cannot enumerate what you have pulled.
   Prefer an instruction-tuned model that follows JSON instructions well; a
   reasoning-heavy model is wasted here and slower.
2. **Attach your Ollama credential** to both nodes.
3. **Create a Data table** named `arootah_triage_results`. Columns, matching the
   `Store Triage Result` node: `message_id`, `summary`, `category`, `priority`,
   `next_action`, `reasoning`, `source`, `prompt_version`, `backend`, `triaged_at`
   (all string), `confidence` (number), `needs_review`, `low_signal` (boolean).
   Do **not** add an `id` column — n8n generates row IDs.

Then activate and call it exactly as the OpenRouter variant, above. Responses carry
`backend: "n8n-ollama"` so it is unambiguous which implementation answered. Both
Ollama nodes are set to `onError: continueRegularOutput`, so an unreachable Ollama
host produces a fallback row rather than a dead execution.

Temperature is 0.1 on the first pass and 0 on the repair — low, because triage
wants consistency, and because the repair attempt should be as literal as possible
about the correction it was just given.

## What n8n is genuinely better at

**Failure localisation.** When a run breaks, n8n shows you the node that failed with
its input and output pinned. Getting that from the Next.js version means reading
logs and re-running with `--only inb-009`. For an ops team debugging at 9am, the
workflow wins outright.

**Change without deploy.** Adding a Slack escalation is a node. In the Next.js
version it is a code change, a review, and a deploy. At a firm where the person who
wants the change is not the person who can deploy, that difference is the whole
argument.

**Integrations already solved.** The Supabase and Slack nodes exist. The
`n8n/high-priority-client-escalation.json` workflow does the escalation the brief
asks about in four nodes, with retries and credential handling included.

## What it is worse at, concretely

**The schema is now written twice.** `lib/schema.ts` defines it once in Zod, and the
`Validate Against Schema` Code node re-implements the same rules by hand, because
the n8n sandbox has neither Zod nor TypeScript. Two definitions of one contract will
drift — that is not a prediction, it is what always happens. In the Next.js version
the same Zod object is used for constrained generation, for revalidation, and for
typing the eval labels; a change propagates in one edit. Here it needs two edits and
nothing tells you if you forget the second.

**No typechecking.** `npm run typecheck` catches a renamed field before it ships. In
n8n, `$json.result.summry` is a runtime `undefined` that silently writes an empty
column.

**No eval harness.** The strongest thing in `RATIONALE.md` is that scoring 13
labelled messages caught a bug in my own priority spec. Reproducing that against the
workflow means driving the webhook from an external script and scoring the
responses — at which point the test harness is code again, and only the pipeline is
visual.

**The prompt is duplicated too.** In Next.js the prompt is generated from
`lib/taxonomy.ts`, so the prompt, the validator, the database lookup rows and the UI
legend cannot disagree. The n8n copy is a literal string inside a Code node. Add a
category in one place and the other is quietly wrong.

**Retry control flow costs five nodes.** In code, the repair retry is one `catch`
block that re-prompts with the validation error. Here it is Build Repair Request →
Repair Attempt → Validate Repair → a second IF → a second responder. Same
behaviour, five times the surface, and each branch is one more thing to keep in
sync.

**Version control is weaker.** The repo holds
`n8n/triage-backend-workflow.js` as the source of truth, but the deployed workflow
can be edited in the UI without touching it. That divergence is invisible until
someone diffs them.

## What I would actually recommend

**Code for the pipeline, n8n for the edges.** The triage step has a schema
contract, needs a test harness, and changes rarely — that belongs in typed code
where the contract is enforced once. Escalation, notification and routing change
often, are owned by operations, and benefit from visible per-run history — those
belong in n8n.

That is precisely the split the repo ships: `lib/llm.ts` does the triage, and
`n8n/high-priority-client-escalation.json` reacts to a stored result by paging the
client-service channel. The full n8n backend in
`n8n/triage-backend-workflow.js` is the demonstration that I tried it the other way
and can say why I did not keep it.

**Where I would flip that judgement:** if the people maintaining this were
operations staff rather than engineers, I would put the whole thing in n8n and
accept the duplicated schema, because a pipeline nobody on the team can safely edit
is worse than one with a drift risk you have written down. That is an organisational
call, not a technical one.

## Running the n8n version

The workflow ships as import-ready JSON in
[`n8n/triage-backend-workflow.json`](../n8n/triage-backend-workflow.json) (12 nodes,
no credentials embedded). `n8n/triage-backend-workflow.js` is the SDK source it is
generated from; the JSON is what you import.

**1. Import**

In n8n: *Workflows -> Import from File* -> select
`n8n/triage-backend-workflow.json`.

**2. Attach credentials.** They are intentionally empty, so nothing is wired to a
shared or inherited credential by accident. Create two and attach them:

| Credential | Type | Attach to |
|---|---|---|
| OpenRouter | HTTP Bearer Auth | `Triage via OpenRouter`, `Repair Attempt` |
| Supabase | Supabase API | `Store Triage Result` |

The Supabase credential needs host `https://pdwotzqfdnnmdspzlqjr.supabase.co` and
the service-role key. The `arootah_triage` schema is already exposed to the REST API,
which is what makes `useCustomSchema` work.

**3. Activate, then call it**

```bash
curl -X POST https://n8n.srv1333076.hstgr.cloud/webhook/arootah-triage \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "inb-005",
    "channel": "voicemail-transcript",
    "from_name": "Robert Ellison",
    "from_org": "(individual)",
    "subject": "",
    "body": "this is Bob Ellison, I am a client. I saw a fee on my last statement I do not understand and I am not happy. Someone needs to call me back today."
  }'
```

Expect `existing_client` / `high`, with `backend: "n8n"` in the response so it is
unambiguous which implementation answered. Two more worth trying:

```bash
# corrupted transport -> unclear, low confidence, flagged for review
-d '{"from_name":"=?utf-8?B?","from_org":"(unknown)","subject":"FWD: RE:",
     "body":"--- forwarded message truncated --- Content-Type: multipart/alternative; boundary=00042"}'

# unattributable follow-up -> unclear rather than a confident guess
-d '{"from_name":"Chris","from_org":"(unknown)","subject":"circling back",
     "body":"Hey, any update on that thing we discussed? Thanks"}'
```

Before activating, note that an active n8n webhook is **unauthenticated and
publicly reachable**, and this one spends money on every call. The Cloudflare
deployment guards its equivalent endpoint with a per-IP limit, a daily cap and an
input-length cap. This workflow has none of those: n8n's webhook node offers header
or basic auth, and for anything beyond a demo you would want that plus a cap. It is
the same lesson as the Next.js side — an unauthenticated endpoint over a paid API is
an API-key proxy — and it is easier to forget here, because the workflow does not
make you write the endpoint.

**Self-hosted, deliberately.** This runs on `n8n.srv1333076.hstgr.cloud`, a personal
instance, rather than an employer's tooling. A take-home artifact for another firm
does not belong in a company's n8n, and neither do that company's API credits. An
earlier version of this workflow lived in a Kitsch instance and has been archived.
