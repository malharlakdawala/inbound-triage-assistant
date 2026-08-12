# Loom script — 3 minutes

> Working notes for recording, not a submission document. Delete before sending,
> or leave it; it does no harm.

The brief says they watch this for shortlisted candidates and that it should
explain **why**, not what. So: 20 seconds of what it does, then the whole rest on
reasoning. Do not narrate the UI.

**Before you hit record**

- Two tabs: the live site, and the repo open at `RATIONALE.md`.
- One terminal, cleared, in the project directory.
- Pre-run `npm run eval` once so the output is warm and instant.
- Say the numbers out loud once beforehand — 13/13, 9/13, $0.16. Fumbling those
  undercuts the whole point.

---

## 0:00–0:25 — What it is, fast

> "Thirteen inbound messages from a shared advisory inbox. Each one gets a
> summary, a category, a priority and a next action from claude-opus-5, stored in
> Postgres. This is the live deployment."

*Scroll once, slowly. Stop.*

> "Ordering is deliberate: review-flagged first, then priority. Sam Cho is at the
> top not because he's important but because the model wasn't sure about him —
> that's the interesting part, and I'll come back to it."

---

## 0:25–1:10 — Structured output and the malformed case

> "The brief asks how I get reliable JSON and what happens when the model doesn't.
> Four layers, and each one catches something the previous one can't."

*Terminal:*

```
npm run triage -- --only inb-005 --simulate malformed --dry-run
```

> "I've injected a broken payload. Zod caught four things — an invented category,
> an invalid priority, an empty next action, and a confidence of 42."

*Point at the `R` flag.*

> "It fed that error back, retried once, and got a valid answer. Row is marked
> `llm_repaired`, so a degraded result never looks like a clean one.
>
> The confidence-of-42 one matters. Constrained decoding **rejects** numeric range
> constraints — the API literally errors if you send `minimum`/`maximum`. So the
> provider cannot enforce confidence being between 0 and 1. Only Zod does. That's
> why the validation layer isn't belt-and-braces — without it, 42 reaches the
> database."

*If you have a spare 5 seconds:*

> "`--simulate api_error` gives a fallback row instead: `unclear`, low, flagged.
> Never dropped, never guessed. And that path got tested for real when my
> Anthropic key hit its spend limit mid-build."

---

## 1:10–2:15 — Where the model was wrong (the centrepiece)

Spend the most time here. It's the strongest thing you have.

```
npm run eval
```

> "Category accuracy 13 out of 13. Priority, 9 out of 13.
>
> I hand-labelled these before running anything, and I wrote down my prediction:
> Sam Cho — no identifiable sender, org 'unknown' — would come back as a confident
> `prospect`. Under my first prompt it did, because that prompt said 'if in doubt,
> pick the most likely category.' That's the expensive failure: a confident wrong
> label **looks handled**. It routes to business development, nobody recognises
> the name, and it ages out. Nobody ever finds out.
>
> I rewrote the prompt to make `unclear` an explicit instruction. Now it returns
> `unclear` at 0.32 confidence. So my prediction stopped reproducing."

*Then the actual finding:*

> "What the eval found instead is better. All four priority disagreements go the
> same direction — the model always assigned *lower* priority than me. One
> direction across four cases is systematic, so I checked my own rule.
>
> On `inb-002` the model is right and I'm wrong. Client with a mortgage deadline,
> 'by this Friday'. Every message arrives Monday, so Friday is four days out. My
> own `high` rule says 'a deadline inside 48 hours'. Four days isn't inside 48
> hours. The model applied the rule I wrote. My label encoded what I *meant* — a
> client with an external deadline should escalate — which the rule never said.
>
> So it's a specification bug, not a model bug, and the harness is what caught it.
> Without a scored ground truth I'd have skimmed a plausible-looking queue and
> shipped a priority rule that silently under-escalates client deadlines.
>
> I deliberately didn't fix it by tuning the prompt until it agreed with me. On
> thirteen rows that's just overfitting. It's written up in the rationale as-is."

---

## 2:15–2:50 — Scale and the risk that actually matters

> "At 10,000 messages a day this costs about $123 a day — $3,700 a month to sort
> an inbox, which isn't defensible. I swept all three effort levels: category
> accuracy was 13 out of 13 at every one and cost moved 9%, so effort is basically
> a cost knob here. The real saving is model choice — Haiku is 5x cheaper, and
> confidence already tells you which 20% need escalating to Opus.
>
> The biggest risk isn't that it's wrong. It's that it's *confidently* wrong in a
> way nobody notices. A visible failure is safe — it's badged and in the review
> queue. The dangerous output is a clean, plausible, wrong label, because the whole
> premise is that nobody re-reads the message.
>
> So `unclear` always routes to a human, sub-threshold confidence always routes to
> a human, and the eval reports 'real messages sent to a no-action bucket without
> review' as a first-class number. It's zero. That's the metric that maps to lost
> revenue."

---

## 2:50–3:00 — One honest close

Pick **one**. Don't rush all of them.

> "One thing I'd flag: this is validated against 13 synthetic messages I labelled
> myself, and I got at least one of those labels wrong. Before it touched real
> client mail it needs a few hundred labelled by the people doing the routing
> today, with agreement measured. The tooling is ready for that; the evidence
> isn't."

**Alternative close, if you'd rather end on the security find:**

> "One more: the Cloudflare build was baking my API keys into the deployed worker
> — OpenNext serialises everything Next.js loads into the bundle. I only found it
> because I checked the artifact before deploying instead of trusting my own
> README. There's now a build step that fails if any secret appears in the output.
> A security property nothing tests is a hope, not a property."

---

## Things not to do

- Don't tour the schema, the UI, or the file tree. Nobody is scoring the layout.
- Don't apologise for scope. The cuts are deliberate and listed in the README.
- Don't say "as you can see" — just say the thing.
- Don't claim the taxonomy is right. Claim it's *justified*, and say what would
  make you change it.
- If you run over, cut the scale section, not the mis-triage section.

## If they ask in the live session

- **"Add a category"** → row in `lib/taxonomy.ts`, `npm run db:seed`, re-run eval.
  No migration, because the taxonomy is data with FKs, not an enum.
- **"Handle a new failure mode"** → new branch in `describe()` / a new
  `SimulatedFailure` variant; the guardrail pipeline is provider-independent.
- **"Add a filter"** → `QueueView.tsx`, the `Filter` union.
- **"Change a priority rule"** → `PRIORITY_RULES` in `lib/taxonomy.ts` regenerates
  the prompt; bump `PROMPT_VERSION` so the cache invalidates and re-run the eval.
  This is the one they're most likely to ask, given the finding above.
