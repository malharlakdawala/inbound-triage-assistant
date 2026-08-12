# Inbound Triage Assistant

Triages a shared advisory-firm inbox with an LLM. Each message gets a one-line
summary, a category, a priority and a concrete next action, stored in Postgres and
shown in a queue ordered by what needs attention first.

Built for the Arootah AI Product Engineer take-home. All data is synthetic.

**Live:** https://inbound-triage-assistant.malharlakdawala.workers.dev
(read-only by design — see Deploying)

**The reasoning behind every choice is in [RATIONALE.md](./RATIONALE.md)** — that
is the document worth reading; this one is how to run it.

Measured on the full set: **category 13/13, priority 9/13, $0.16, p95 7.5s.**
The priority gap is the interesting part — and one of those four disagreements
turned out to be my label being wrong, not the model's.

## Quick start

```bash
git clone https://github.com/malharlakdawala/inbound-triage-assistant.git
cd inbound-triage-assistant
npm install

cp .env.example .env.local     # fill in an LLM key + the Supabase values

npm run db:migrate             # or paste supabase/migrations/0001_arootah_triage.sql into the SQL editor
npm run db:seed                # taxonomy + contacts + the 13 messages
npm run triage                 # calls the LLM, writes results (13 calls, ~$0.16)
npm run eval                   # scores the run against evals/expected.json
npm run dev                    # http://localhost:3000
```

### Which LLM

`claude-opus-5`, reachable two ways. Set **either** key and the provider
auto-detects; set both and pin `LLM_PROVIDER` to choose.

| Provider | Env | Wire protocol |
|---|---|---|
| Anthropic direct | `ANTHROPIC_API_KEY` | `output_config.format` + `messages.parse()` |
| OpenRouter | `OPENROUTER_API_KEY` | OpenAI-compatible `response_format: json_schema` |

The measured run used OpenRouter (`anthropic/claude-opus-5`) because the direct
Anthropic account hit its spend limit mid-build. The guardrails sit above the
transport, so switching route was one env var and changed none of the validation
behaviour — see [RATIONALE.md](./RATIONALE.md) §b.

`npm run triage` is cached on `sha256(message + prompt_version + model)`, so
re-running costs nothing unless something actually changed. `--force` re-triages,
`--only inb-009` does one message, `--dry-run` skips the writes.

### Showing the unhappy paths

Both failure modes the brief asks about are triggerable rather than waited for:

```bash
npm run triage -- --only inb-001 --simulate api_error   # transport failure -> fallback row
npm run triage -- --only inb-001 --simulate malformed   # invalid payload -> repair, then fallback
npm run triage -- --only inb-011                        # the genuinely corrupt message
```

`inb-010` (empty) and `inb-011` (NUL bytes, undecoded MIME header, truncated
multipart) are the real malformed inputs in the dataset and need no flag.

## How it works

```
data/inbound.json
      |
      v
lib/normalize.ts     strip NUL/control chars, resolve (individual)/(unknown) sentinels
      |              to null, flag low-signal input
      v
lib/prompt.ts        prompt assembled from lib/taxonomy.ts
      |
      v
lib/anthropic.ts     constrained generation -> stop-reason checks -> Zod revalidation
      |              -> one repair retry -> deterministic fallback
      v
arootah_triage.results       one row per (message, prompt_version, model), with provenance
      |
      v
arootah_triage.queue view -> app/page.tsx
```

## Design choices and tradeoffs

**Next.js, one app.** The API key has to stay server-side; a route handler is the
smallest thing that achieves that without a second process to explain. React
because it is what the role uses.

**Supabase, with the taxonomy as data rather than schema.** Categories and
priorities are rows in lookup tables that `results` references by foreign key.
Adding a category is an `INSERT` — no migration, no enum `ALTER`, no deploy. A
Postgres enum reads tidier and makes every taxonomy change a locking DDL
migration, which is the wrong trade for the thing most likely to change.

**Results keyed on an input hash, not on message id.** Re-running with the same
prompt is free; editing the prompt writes new rows instead of overwriting history,
so two prompt versions can be compared on the same messages. That is what makes
the eval harness worth having.

**Two Supabase keys, deliberately separated.** The deployed app holds only the
publishable key and is read-only under RLS. The service-role key bypasses RLS and
never leaves a local machine.

**The deployed app cannot call the LLM.** It reads stored results. Live re-triage
requires an admin token that is not set in production, so a public URL over a paid
API key is not an open proxy. Triage runs locally and the site serves what it
produced.

**What I deliberately did not build:** auth, Docker, CI, a test-coverage target,
telemetry, multi-user, streaming, a job queue. The brief puts these out of scope
and the tool does not need them at 13 messages. The eval harness and the cost
instrumentation earned their place because they feed the reasoning; a login screen
would not.

## Modelling this in Airtable

Four tables, mirroring the Postgres schema:

- **Messages** — the inbound record. Link to *Contacts*, link to *Categories*,
  single-select for priority, plus `Summary`, `Next action`, `Confidence`,
  `Needs review`, `Source`.
- **Contacts** — `Name`, `Org`, `Existing client?`, and a **self-link
  `Referred by` → Contacts**. This is the one linked relationship worth having:
  `inb-013` ("Referred by Dana Whitfield") points at the sender of `inb-002`, so
  the referral edge becomes queryable — *"which of our clients send us business"*
  is a rollup rather than a manual read. A flat table loses it entirely.
- **Categories** — `Slug`, `Definition`, `Routes to`, `Active`. Same reasoning as
  the lookup table: a new category is a record, not a schema change.
- **Runs** — one record per triage run with model, prompt version, token counts
  and cost, so spend stays attributable.

The practical difference from Postgres: Airtable gives non-engineers a usable
review queue for free, which for an ops team is worth more than the query
flexibility it costs. I would reach for it if the reviewers were the advisors
themselves.

## One n8n automation I would add

**Trigger:** Supabase row inserted into `arootah_triage.results` where
`priority = 'high'` AND `category = 'existing_client'`.

**Action:** post to the client-service Slack channel with the summary, the next
action, the sender, and a link to the row; then create a task assigned to the
owning advisor with a 4-hour due date.

Chosen because it is the case where latency costs the most: `inb-005` is a client
disputing a fee and asking for a callback *today*, and the difference between
seeing that in four minutes and four hours is a retention event. The workflow is
in [`n8n/high-priority-client-escalation.json`](./n8n/high-priority-client-escalation.json).

Deliberately narrow: it fires on the one intersection where a false positive is
cheap (an extra Slack message) and a false negative is expensive. Escalating every
`high` would include prospects and page people at 2am for a newsletter that got
mislabelled.

## How I used AI

Claude Code wrote most of this, and I directed it. The parts I decided rather than
accepted:

- **The taxonomy and the priority rules.** Categories are chosen by *who acts on
  the message*, and priority is defined by explicit rules rather than adjectives.
  Both are judgement calls about an advisory firm's workflow, and I made them
  before any code existed.
- **Where I overrode the model.** The first prompt (`prompts/v1.md`) contained
  *"If in doubt, pick the most likely category"*. That made `inb-009` — a sender
  nobody can identify — come back as `prospect` with high confidence. A confident
  wrong label looks handled, so it routes to business development and ages out
  silently; that is worse than routing to a human. I rewrote the prompt to make
  `unclear` an explicit instruction with a confidence ceiling. It worked: on the
  measured run `inb-009` is `unclear` at 0.32 confidence.
- **Where the eval overrode *me*.** I predicted `inb-009` would still be the
  mis-triage. It wasn't — category accuracy came out 13/13. What the harness found
  instead was that all four priority disagreements ran one way (the model
  under-escalating), and on `inb-002` **the model was right and my label was
  wrong**: "by this Friday" is four days out, and my own `high` rule says "inside
  ~48 hours". The model applied the rule I wrote; my label encoded what I meant.
  I left the measurement honest rather than tuning the prompt until it agreed with
  me, which is how you overfit a 13-row eval. Full write-up in RATIONALE §c.
- **Turning down the emphasis.** The first draft was full of
  `CRITICAL:` / `You MUST`. That register is a habit from older models; the current
  one follows instructions literally, so marking everything critical stops it
  discriminating. Cutting it changed behaviour.
- **Refusing the deployment shortcut.** The obvious way to ship a public demo is
  to put the service-role key and the Anthropic key in the hosting environment. I
  split the keys and made production read-only instead.

## Environment

Two files, and the split is a **deployment-safety boundary rather than a
convention**:

| File | Loaded by | Ends up in the Worker? | Contents |
|---|---|---|---|
| `.env.local` | Next.js (auto) | **Yes** | Read-path Supabase values only |
| `.env.secrets` | `lib/load-env.ts` only | No | LLM keys, service-role key, admin token |

`@opennextjs/cloudflare` serialises everything Next.js loads into
`.open-next/cloudflare/next-env.mjs` and bundles it into the deployed Worker —
irrespective of the `NEXT_PUBLIC_` prefix. Putting a secret in `.env.local`
therefore publishes it. This is not hypothetical: it happened during this build
and baked four live credentials into the artifact.

`npm run check:bundle` scans the built Worker for the values in `.env.secrets`,
for known credential patterns, and for a `service_role` claim inside any decoded
JWT. It is wired into `cf:build`, so an unsafe artifact cannot be produced
silently. See [`.env.example`](./.env.example) for the full list.

## Deploying

```bash
npx wrangler login       # once
npm run cf:build         # builds, then refuses to pass if a secret leaked
npm run cf:deploy
```

**No Cloudflare configuration is required.** The two read-path Supabase values
are in `.env.local`, so the build embeds them — which is correct, because the
publishable key is public by design and RLS restricts it to `SELECT`. Everything
secret lives in `.env.secrets`, which the build never reads.

Verified against the live deployment: `POST /api/triage` returns

```
501  {"error":"Live triage is disabled in this environment."}
```

for both a missing token and a guessed one, and grepping the served HTML and every
JS chunk for `sk-ant-api`, `sk-or-v1`, `service_role` and `TRIAGE_ADMIN` returns
zero hits. The deployment is structurally incapable of calling a paid API or
writing to the database: it holds no credential that would let it.
