# Two backends, same pipeline

The same triage pipeline is implemented twice: once as Next.js route handlers, once
as an n8n workflow. Both call `claude-opus-5`, both use the same taxonomy, and both
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
