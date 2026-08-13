# Engineering Rationale

Measured on a full run of all 13 messages: `claude-opus-5` (reached via OpenRouter),
prompt `v2`, effort `medium`, 2026-08-13.

```
category accuracy    13/13   100%
priority accuracy     9/13    69%
both correct          9/13    69%
sources              llm=13  (no repairs, no fallbacks)
tokens               22,875 in / 1,811 out
cost                 $0.1596 total   $0.01228 per message
latency              p50 4.5s   p95 7.5s   wall clock 18.2s at concurrency 4
confidence           0.81 mean when correct   0.72 mean when wrong
real messages silently dropped to a no-action bucket    0
```

Reproduce with `npm run triage -- --force && npm run eval`.

---

## a. Data & taxonomy

**Categories are chosen by who acts on the message, not by what it is about.**
The set is `prospect`, `existing_client`, `vendor`, `recruiter`,
`partner_referral`, `noise`, `unclear`. The test each one had to pass: does
anybody route it differently? `recruiter` and `vendor` are both "someone selling
to us" and could be merged, but at an advisory firm a vendor pitch goes to
operations for a decision while recruiter mail goes nowhere — different
destinations, so they stay separate. A category that shares a destination with
another and never changes a decision has no reason to exist, and I would cut it.

`unclear` is not a leftover bucket. It is the one category with a *behavioural*
meaning: it routes to a human and is never auto-actioned
(`NEEDS_HUMAN` in `lib/taxonomy.ts`). Making that explicit is what fixed the
biggest failure in v1 of the prompt — see (c).

**Priority is defined by rules, not adjectives.** `high` means money or a mandate
is at stake now, a stated deadline inside ~48 hours, or an unhappy existing
client. `medium` is a real opportunity or client request with no hard deadline.
`low` is no action needed, automated, or the sender says it is not urgent. The
point of writing them as rules is that two people who disagree can resolve it by
pointing at a rule instead of trading intuitions — and, as it turned out, so can
a person and a model.

**Urgency and value are deliberately separate axes.** Priority orders the work
queue; it does not score the opportunity. `inb-006` is a genuine prospect asking
about minimums and fees who explicitly says "no rush at all" — that is `low`
priority and potentially high value, and conflating the two would push every
large prospect to the top of the queue regardless of whether anyone needs to act
today. A production version would carry a separate `value` or `qualification`
field rather than smuggling it into priority.

**Ordering is part of the taxonomy decision, not just presentation.** The queue
sorts actionable rows first, then priority rank, then confidence descending, with
flagged rows last. `needs_review` does the first step alone, and deliberately so:
it is already true when the category is `unclear`, when confidence is below the
review threshold, or when triage degraded — so one flag sinks unclear *and*
low-confidence rows without a second sort double-counting the same signal. The
tradeoff is that ambiguous rows are now less visible, which is only acceptable
because a "needs review" filter pulls them back in one click.

**If the taxonomy doubled tomorrow, the database would not move.** Categories and
priorities are rows in `arootah_triage.categories` / `.priorities`, and `results`
references them by foreign key. Adding a category is an `INSERT` plus a line in
`lib/taxonomy.ts`; there is no migration, no enum `ALTER`, and no deploy. Three
consequences I actually wanted:

- The prompt text, the Zod validator, the eval harness and the UI legend are all
  generated from the same `lib/taxonomy.ts` module, so they cannot drift apart.
  Adding a category updates the prompt and the validator in one edit.
- Retiring a category sets `active = false` instead of deleting the row, so
  historical results keep a valid foreign key and stay interpretable. A Postgres
  `ENUM` makes retirement either impossible or destructive.
- Because `results` is keyed on `sha256(message + prompt_version + model)`, two
  taxonomy versions can coexist in the same table and be scored against each
  other on the same messages.

The cost of this choice is a join to read a human-readable label, which the
`arootah_triage.queue` view absorbs. That is the right trade for the part of the
system most likely to change.

---

## b. Reliable structure

Four layers, in `lib/llm.ts`. Each catches something the previous one cannot,
which is the only reason there are four.

1. **Constrained generation.** The Zod schema (`lib/schema.ts`) is converted to
   JSON Schema and passed as `output_config.format` on the Anthropic path, or
   `response_format: {type: 'json_schema', strict: true}` on the OpenRouter path.
   The model is constrained while decoding, which removes essentially all shape
   errors.
2. **Stop-reason checks** (`callAnthropic`, `callOpenRouter`). A `refusal` or a
   `max_tokens` truncation returns **HTTP 200** with content that does not satisfy
   the constraint. Both are checked explicitly before anything is parsed.
   Trusting the constraint alone is precisely the bug this layer prevents.
3. **Zod revalidation** (`attemptOnce`). This is not redundant with layer 1, and
   I can prove it: constrained decoding **rejects numeric range constraints
   outright** — the provider returns
   `output_config.format.schema: For 'number' type, properties maximum, minimum
   are not supported`. So `stripUnsupported()` removes `minimum`/`maximum`/
   `minLength`/`maxLength` before sending, meaning **`confidence` being inside
   0..1 is enforced only in-process**. Without layer 3, a confidence of 42 reaches
   the database. The `--simulate malformed` run catches exactly that, alongside an
   invented category and an empty `next_action`.
4. **One repair retry, then a deterministic fallback.** On a validation failure
   the specific Zod error is fed back and the call is retried **once**. Verified
   working:

   ```
   R inb-005  existing_client  high  conf=0.95   source=llm_repaired
     ! First pass invalid: category: Invalid option...; priority: Invalid option...;
       next_action: Too small: expected string to have >=1 characters;
       confidence: Too big: expected number to be <=1
   ```

   Retrying more than once was a deliberate cut: if a constrained model cannot
   satisfy the schema twice, the input is the problem, and looping spends money
   without changing the outcome.

**What the code does when the model returns something unusable.** It writes the
row anyway, as `unclear` / `low` / `confidence 0`, with `source='fallback'`, an
explicit human `next_action`, the real error string attached, and
`needs_review = true` (`fallbackResult()` in `lib/schema.ts`). Three properties
matter here and each rules out a tempting alternative:

- **The row is never dropped.** A message that failed triage is exactly the one a
  human needs to see. Silently skipping it is the worst available behaviour
  because the queue then looks complete.
- **A category is never invented.** The fallback is always `unclear`, never a
  guess.
- **Degradation is visible.** The UI badges `fallback` and `repaired` rows, so a
  degraded result never renders identically to a clean one.

Verified against a real transport failure, not just the simulated one — the
Anthropic key hit its spend limit mid-development and returned a genuine
`400 invalid_request_error`. The tool logged the error, produced a fallback row,
flagged it for review, and kept going.

**Retries are split by failure type.** The SDK retries 429/5xx/timeouts three
times with backoff at the transport level. A schema violation is *not* retried
that way — it gets the single prompt-level repair instead. Conflating the two
would either re-prompt for network problems or silently re-send an identical
request that is guaranteed to fail the same way.

**Provider portability was free, and load-bearing.** The same model is reachable
directly from Anthropic or through OpenRouter, which speak different wire
protocols. Layers 2–4 sit above the transport, so the safety properties are a
property of `lib/llm.ts` rather than of the vendor. This stopped being
theoretical when the Anthropic account hit its limit: switching route was one env
var, and the guardrails did not change.

---

## c. Where the model was wrong

**The prediction I made was wrong, and the eval is what told me.**

Before running anything, I labelled all 13 messages by hand
(`evals/expected.json`) and wrote down that `inb-009` — Sam Cho, org
`(unknown)`, "just following up on our conversation" — would be the mis-triage.
With prompt v1 it was: the model returned `prospect` with high confidence, because
v1 contained *"If in doubt, pick the most likely category"*. That is the expensive
failure mode. A confident wrong label **looks handled**: it lands in a
business-development queue, nobody recognises the name, and it ages out silently.

v2 made `unclear` an explicit instruction with a confidence ceiling. On the
measured run:

```
inb-009  unclear  low  conf=0.32   "Follows up on an unspecified prior conversation and asks for the next step."
```

Correct category, appropriately low confidence, flagged for review. **The
prediction no longer reproduces.**

**What the eval found instead is more interesting, and it is not a model bug.**
Category accuracy was 13/13. Every one of the four priority disagreements ran in
the *same* direction — the model assigned a lower priority than my label:

| id | my label | model | my stated reason |
|---|---|---|---|
| inb-001 | high | medium | $8M mandate, explicit ask to be routed |
| inb-002 | high | medium | hard third-party deadline, "by this Friday" |
| inb-013 | high | medium | warm referral from a named existing client |
| inb-009 | medium | low | a real person is waiting on a reply (I had marked this contested) |

A one-directional error across four cases is systematic bias, not noise. So I
checked my own rule — and on **`inb-002` the model is right and my label is
wrong**. Every message in the set arrives Monday 2026-07-20. "By this Friday" is
2026-07-24, **four days out**. My own `high` rule says *"a stated deadline inside
~48 hours"*. Four days is not inside 48 hours, so the rule says `medium`, and the
model applied the rule I wrote. My label encoded what I *meant* — a client with a
real external deadline should be escalated — which the rule never said.

`inb-013` is the same shape. The prompt tells the model a warm introduction
"carries more weight", but the priority rules never make a referral `high`. The
model followed the rules; the rules did not express my intent.

**So the finding is a specification bug, not a model bug**, and the eval harness
is what surfaced it. Without a scored ground truth I would have skimmed a
plausible-looking queue, seen sensible labels, and shipped a priority rule that
silently under-escalates client deadlines. That is worth more than the accuracy
number.

**A second model, independently, agrees with the first and not with me.** After
building the n8n backend I ran the same 13 messages through `gpt-oss:120b` (a
different lab, a different transport, prompt-based JSON rather than constrained
decoding). Category accuracy was again 13/13. Priority was 10/13 — one *better*
than `claude-opus-5` — and the disagreements land in overlapping places, all in the
same direction:

| id | my label | claude-opus-5 | gpt-oss:120b |
|---|---|---|---|
| inb-001 | high | medium | low |
| inb-002 | high | medium | high ✓ |
| inb-009 | medium (contested) | low | low |
| inb-013 | high | medium | medium |

One model declining to escalate is a model problem. Two models from different labs
declining to escalate the same messages, while agreeing with each other, is a
specification problem — mine. That is the strongest evidence in this submission for
the conclusion above, and I would not have had it without building the second
backend.

It also says something about where the accuracy comes from: both models get all
thirteen categories right, so on this corpus the taxonomy and the prompt are doing
that work, not model capability. The judgement call the models actually differ on is
priority — which is precisely the part of my spec that turned out to be
under-written.

**How I would fix it** (not applied — I would rather show the honest measurement
than tune the prompt until it matches my labels, which is how you overfit a
13-row eval):

1. Replace the flat 48-hour threshold with a rule that distinguishes *who* set
   the deadline. A deadline imposed by a client's third party — a lender, an
   auditor, a counterparty — should escalate regardless of distance, because
   missing it damages the client relationship rather than merely being late.
2. State a referral rule explicitly rather than hoping "carries more weight"
   propagates into priority.
3. Re-run the eval and confirm the change moves the three cases without
   disturbing the ten that were already correct.

**Confidence is doing real work.** Mean confidence was 0.81 when correct and 0.72
when wrong. The gap is modest and the sample is 13 rows, so I would not defend a
precise threshold — but the direction is right, and the three lowest-confidence
rows (0.32, 0.40, 0.42) are exactly the three that needed a human. That is what
justifies `CONFIDENCE_REVIEW_THRESHOLD` existing at all; the eval prints this
check every run so that if the relationship inverts, I find out.

---

## d. Edge cases

**Treated as low-signal at ingest** (`lib/normalize.ts`), before any model call —
detected, flagged, and stated to the model rather than hidden:

| input | what is wrong | what the tool does |
|---|---|---|
| `inb-010` | every field blank, body is a single `.` | 1 alphanumeric char → low-signal; model returned `unclear`/`low` at 0.40, flagged for review |
| `inb-011` | real `U+0000` bytes, `U+FFFD` replacement chars, undecoded MIME encoded-word `=?utf-8?B?` as the sender name, truncated multipart body | NULs and controls stripped and *recorded*; corrupt name resolved to null; corruption markers detected → low-signal; returned `unclear`/`low` at 0.42, flagged |
| `inb-008` | no sender name, automated newsletter | not low-signal — genuinely well-formed; correctly `noise`/`low` |
| `inb-009` | named human, org `(unknown)`, no recoverable context | not malformed, just unattributable — `unclear` with low confidence |

**`from_org` sentinels are resolved to `null` before the model sees the field.**
`(individual)` and `(unknown)` are not organisation names. Left in place, the
prompt literally reads `Sender organisation: (unknown)`, and a model reasonably
treats that as a company — which is how a private individual gets labelled
`vendor`. The prompt says absent-organisation means "probably a private
individual, not suspicious", because v1's silence on this pushed sentinel-org
senders toward `vendor`.

**The NUL bytes are a storage bug, not just noise.** Postgres rejects `U+0000` in
`text` columns outright. Had the raw body been passed through, the insert would
have failed **after** paying for the LLM call — so cleaning happens before both
the API call and the write, including in the `*_raw` audit columns, where "raw"
therefore means "pre-normalisation" rather than "byte-identical". This is
documented in the schema rather than left as a surprise.

**Deliberate choice: low-signal messages still go to the model.** Cheaper to
short-circuit them in code, and I tried that first. Two reasons against it: a
hand-written "is this junk" heuristic will eventually reject a real message that
merely looks odd, and if the model never sees them I cannot measure whether it
handles them correctly. Instead, preprocessing computes the hint and *tells* the
model, and the model still assigns the category. The measured result is that both
junk messages came back `unclear` with confidence ≤ 0.42, so the guardrail and
the model agree — which is the evidence I wanted.

**What is recorded, not just handled.** `cleaned` stores what was removed per
message, `low_signal` is a queryable column, and the UI shows both under each
card. A pipeline that quietly sanitises its input is one where you cannot later
answer "why did this message get triaged that way".

---

## e. Scale & risk

### What breaks at 10,000 messages/day

Extrapolated linearly from the measured run — deliberately linear, because the
point is to find which constraint binds first, not to claim the numbers hold:

```
cost              $122.81/day    ~$3,684/month
model time        13.9 core-hours/day
p95 latency       7.5s per message
```

**Cost is the binding constraint, and it breaks first.** $3.7k/month to sort an
inbox is not defensible for a mid-size advisory firm. Three fixes in order of
leverage:

1. **Stop paying for effort that buys nothing, and route by difficulty.** I swept
   all three effort levels over the full set: category accuracy was **13/13 at
   every level**, and total cost moved only ~9% ($0.157 low → $0.172 high). On this
   corpus effort is close to a pure cost knob, so the saving is not in tuning it
   globally — it is in **model choice**. `claude-haiku-4-5` is 5x cheaper per token
   ($1/$5 vs $5/$25) and these are short classification calls. The design to build
   is a cheap first pass with escalation to Opus only for low-confidence rows,
   which the `confidence` field already identifies (the three rows needing a human
   scored ≤0.42). That targets spend at the ~20% of messages where judgement
   actually matters.
2. **Batch.** OpenRouter and Anthropic both price batch at ~50% (`:batch` model
   ids are already visible in the provider list). Triage is not latency-sensitive
   — nobody is waiting on a web request — so this is close to free.
3. **Prompt caching.** The system prompt is ~1,700 of the ~1,760 input tokens per
   call and is byte-identical every time. Caching it cuts input cost sharply. The
   schema object is already cached in-process specifically so the request bytes
   stay stable enough for an upstream cache to hit.

**Throughput is not a problem.** 13.9 core-hours/day is ~0.6× concurrency to keep
up; the current concurrency of 4 has an order of magnitude of headroom. What does
break is the **architecture**: `scripts/triage.ts` is a script that reads a JSON
file. At 10k/day it needs to be a queue consumer with idempotency (the
`input_hash` unique constraint already provides that), a dead-letter path for
rows that exhaust the repair retry, and per-message rate-limit backpressure
rather than a fixed concurrency of 4.

**Two quieter failures at volume.** Postgres is fine at this scale, but
`arootah_triage.results` grows one row per message *per prompt version*, so
re-running the whole corpus after a prompt change doubles the table — a retention
policy is needed, not just an index. And a silent 5% accuracy regression from a
model or prompt change is invisible without the eval running continuously on a
held-out set; at 13 rows the harness is a development tool, and at 10k/day it
needs to be a monitored one with far more labels.

### The biggest risk in shipping this to a real advisory firm

**Not that it is wrong — that it is confidently wrong in a way nobody notices.**

A visible failure is safe: the fallback row is badged, sits in the review queue,
and someone deals with it. The dangerous output is a well-formed, confident,
plausible label that is wrong — because the whole value proposition is that
nobody re-reads the message. `inb-009` under prompt v1 is precisely this: a
confident `prospect` label on an unidentifiable sender, which routes to
business development, gets no recognition, and ages out. Nobody ever learns that
a real person was ignored. In this domain that message could have been a client
with $8M in play.

The measured priority bias is the same risk in milder form: a systematic
under-escalation that looks entirely reasonable message by message, and only
shows up as a pattern when something scores it against labels.

**Mitigations, in the order I would trust them:**

1. **Never let the tool close the loop.** Categories in `NEEDS_HUMAN` always route
   to a person, and `noise` is the only bucket that means "no human sees this".
   The eval reports "real messages sent to a no-action bucket without review" as
   a first-class number — currently 0 — because that single metric is the one that
   corresponds to lost revenue.
2. **Keep confidence and act on it.** Sub-threshold rows go to review regardless
   of how clean the label looks. Verified as directionally useful above.
3. **Score against labels continuously, not once.** The eval exists so that
   "where is it wrong" has an answer that survives a prompt change. It already
   caught a bug in my own specification.
4. **Make degradation legible.** `source`, `error`, `cleaned` and `low_signal` are
   stored and displayed. An operator can always see whether a row is trustworthy.
5. **Treat the taxonomy as reviewable.** Because it is data with routing
   destinations attached, a compliance reviewer can read what routes where without
   reading TypeScript.

**One risk I have not mitigated, stated plainly.** Everything here is validated
against 13 synthetic messages that I labelled myself. My labels were wrong at
least once (`inb-002`), which is a fair estimate of how reliable a single
annotator is. Before this touched real client mail it would need a few hundred
messages labelled by the people who actually do the routing today, with
inter-annotator agreement measured — because a rule that two ops staff read
differently cannot be enforced by a prompt. The tooling is ready for that; the
evidence base is not, and no amount of engineering substitutes for it.

### Also worth naming

- **The public try-it form is the one place the deployment spends money, and the
  spend guard was broken twice — the second time after I had already written that
  it worked.** Version one wrapped each check in `if (binding)`, so a missing
  binding silently disabled the limit: fail-open on a spend guard. That was fixed
  to fail closed (503 rather than an uncapped call).

  An earlier draft of this document then claimed I had "confirmed both were bound
  and the limiter was functioning". When a second public endpoint was added and
  the guards were refactored into one shared module, I re-tested and **could not
  reproduce it**: seven sequential requests inside a single minute all returned
  200 against a documented 5/minute cap. Instrumenting the two layers directly
  (fixed IP, fixed minute bucket, 8 calls in 9 seconds) gave the real picture:

  | layer | configured | measured |
  |---|---|---|
  | Cloudflare rate-limit binding | 5 per 60s | `success=true` on all 8 calls — **inert** |
  | KV read-then-write counter | monotonic | reads returned `1,2,3,4,2,3,3,4` |

  The Cloudflare binding is bound, does not throw, and does not enforce; it is
  left in place as free redundancy and documented as inert rather than counted as
  a layer. The KV counter climbs but its reads regress, because different edge
  instances see different versions — an effective ~2× undercount, which is exactly
  why seven real requests never tripped a threshold of five. The threshold is now
  **3**, so the effective ceiling lands near the intended 5, and that *is*
  verified: requests 4 through 7 in one minute return 429.

  So the honest position is split. The **daily cap is a real spend ceiling** — a
  2× overshoot on a 150/day budget is still bounded at a few dollars. The
  **per-minute burst limit is best-effort only.** A Durable Object is the correct
  primitive for both, giving genuinely atomic counters; I did not build one because
  exporting a Durable Object class from an OpenNext-generated worker means wrapping
  its entrypoint, which is a real change to the deploy path and out of proportion
  to a demo whose worst case is a few dollars. That is a judgement, and I would
  make the opposite one if this metered anything that mattered.

  Three lessons, and the third is the one I would actually repeat. First, a guard
  you have not seen reject something is not a guard — I asserted "rate limited"
  twice before ever observing a 429. Second, timing tests need controlling: an
  earlier round of probes straddled a minute boundary because each call takes ~5s,
  which produced a *false negative* and sent me looking for a bug that was not
  there. Third, and worst: **I wrote the limitation down as a caveat and treated
  writing it down as having handled it.** The measured behaviour was worse than
  the caveat. This is the same failure as the secret leak below — a claim about
  the system, published before it was tested.

- **The deployed app holds no write credential.** It holds only the publishable
  Supabase key and no LLM credential, so a public URL over a paid API is not an
  open proxy. Live re-triage requires an admin token that is not set in
  production.
- **The build system leaked every secret into the deployable artifact, and I only
  found it because I checked.** `@opennextjs/cloudflare` serialises everything
  Next.js loads into `.open-next/cloudflare/next-env.mjs` and ships it inside the
  Worker. Next.js auto-loads `.env.local`, so the Anthropic key, the OpenRouter
  key, the Supabase service-role key and the admin token were all embedded in the
  bundle — with no warning, and with the `NEXT_PUBLIC_` prefix being irrelevant.
  Deploying it would have published four live credentials at a public URL while
  the README claimed the opposite.

  The fix is structural: `.env.local` now holds only values that are safe to
  publish, secrets live in `.env.secrets` (a filename Next.js does not know, so it
  is never bundled), and `npm run check:bundle` fails `cf:build` if any secret
  value, known credential pattern, or `service_role` JWT claim appears in the
  artifact. Verified both directions — the guard flags the old bundle and passes
  the new one, and in `workerd` with no secrets present `POST /api/triage` returns
  501 rather than running.

  The generalisable lesson, and the reason this belongs in a risk section: **a
  security property that nothing tests is a hope, not a property.** I had written
  the read-only claim in the README before it was true. The gap between the two
  was one `grep` wide.

- **The service-role key never leaves a developer machine.** It bypasses RLS, so
  shipping it would make any route-handler bug a full-database write primitive.
- **PII.** The synthetic data is harmless, but real inbound mail contains client
  financial details, and this design sends message bodies to a third-party API —
  in the current configuration, through OpenRouter, which adds a second processor.
  For a real deployment that is a data-protection decision to make deliberately
  and contractually (zero-retention terms, direct-to-provider rather than via a
  gateway, or a self-hosted model), not a default to inherit from a take-home.
