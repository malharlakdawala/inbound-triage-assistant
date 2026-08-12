/**
 * Scores the stored triage results against the hand labels in evals/expected.json.
 *
 *   npm run eval
 *
 * Why this exists: without it, "where was the model wrong?" is answered from
 * memory and vibes. With it, the answer is a number, the same number can be
 * recomputed after a prompt change, and a regression is visible instead of
 * anecdotal. It is also what makes it cheap to answer "add a category" live —
 * change the taxonomy, re-run, compare.
 *
 * Reads from the database rather than re-calling the model, so scoring is free
 * and deterministic.
 */
import '../lib/load-env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeClient } from '../lib/supabase';
import { CATEGORIES } from '../lib/taxonomy';

interface Label {
  id: string;
  category: string;
  priority: string;
  why: string;
  contested?: boolean;
}

async function main() {
  const expected = JSON.parse(
    readFileSync(join(process.cwd(), 'evals', 'expected.json'), 'utf8'),
  ) as { labels: Label[] };

  const supabase = writeClient();
  const { data, error } = await supabase
    .from('queue')
    .select('message_id, category, priority, confidence, source, needs_review, prompt_version, model');
  if (error) throw new Error(`read queue: ${error.message}`);

  const actual = new Map(
    (data ?? []).map((r) => [
      r.message_id as string,
      {
        category: r.category as string | null,
        priority: r.priority as string | null,
        confidence: r.confidence as number | null,
        source: r.source as string | null,
        needs_review: r.needs_review as boolean | null,
        prompt_version: r.prompt_version as string | null,
        model: r.model as string | null,
      },
    ]),
  );

  const untriaged = expected.labels.filter((l) => !actual.get(l.id)?.category);
  if (untriaged.length === expected.labels.length) {
    console.error('No triaged results found. Run `npm run triage` first.');
    process.exit(1);
  }

  const versions = new Set(
    [...actual.values()].map((a) => `${a.model}@${a.prompt_version}`).filter((v) => !v.includes('null')),
  );
  console.log(`scoring ${[...versions].join(', ') || '(unknown version)'}\n`);

  let catOk = 0;
  let priOk = 0;
  let bothOk = 0;
  let scored = 0;
  const misses: Array<{ id: string; field: string; want: string; got: string; contested: boolean; why: string }> = [];
  const confusion = new Map<string, number>();

  for (const label of expected.labels) {
    const got = actual.get(label.id);
    if (!got?.category || !got.priority) continue;
    scored++;

    const cOk = got.category === label.category;
    const pOk = got.priority === label.priority;
    if (cOk) catOk++;
    if (pOk) priOk++;
    if (cOk && pOk) bothOk++;

    if (!cOk) {
      misses.push({
        id: label.id,
        field: 'category',
        want: label.category,
        got: got.category,
        contested: !!label.contested,
        why: label.why,
      });
      const key = `${label.category} -> ${got.category}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
    }
    if (!pOk) {
      misses.push({
        id: label.id,
        field: 'priority',
        want: label.priority,
        got: got.priority,
        contested: !!label.contested,
        why: label.why,
      });
    }
  }

  const pct = (n: number) => `${((n / scored) * 100).toFixed(0)}%`;
  console.log('--- accuracy ---');
  console.log(`scored           ${scored}/${expected.labels.length}`);
  console.log(`category         ${catOk}/${scored}  ${pct(catOk)}`);
  console.log(`priority         ${priOk}/${scored}  ${pct(priOk)}`);
  console.log(`both correct     ${bothOk}/${scored}  ${pct(bothOk)}`);

  if (misses.length > 0) {
    // Contested labels are separated out on purpose: a disagreement on a case I
    // flagged as arguable is weaker evidence of a model error than a miss on a
    // clear-cut one, and collapsing them would overstate the failure rate.
    const clear = misses.filter((m) => !m.contested);
    const contested = misses.filter((m) => m.contested);

    if (clear.length > 0) {
      console.log('\n--- disagreements on clear-cut labels ---');
      for (const m of clear) {
        console.log(`${m.id}  ${m.field}: expected ${m.want}, got ${m.got}`);
        console.log(`    label rationale: ${m.why}`);
      }
    }
    if (contested.length > 0) {
      console.log('\n--- disagreements on labels I marked contested ---');
      for (const m of contested) {
        console.log(`${m.id}  ${m.field}: expected ${m.want}, got ${m.got}`);
        console.log(`    label rationale: ${m.why}`);
      }
    }
  } else {
    console.log('\nNo disagreements.');
  }

  if (confusion.size > 0) {
    console.log('\n--- category confusion ---');
    for (const [pair, n] of [...confusion.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`${pair}  x${n}`);
    }
  }

  // --- calibration ---------------------------------------------------------
  // Confidence is only worth storing if it predicts anything. If mean confidence
  // on wrong answers is not below mean confidence on right ones, the field is
  // decoration and the review threshold is arbitrary — worth knowing either way.
  const missIds = new Set(misses.map((m) => m.id));
  const conf = (ids: (l: Label) => boolean) => {
    const vals = expected.labels
      .filter(ids)
      .map((l) => actual.get(l.id)?.confidence)
      .filter((c): c is number => typeof c === 'number');
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  };
  const confCorrect = conf((l) => !missIds.has(l.id));
  const confWrong = conf((l) => missIds.has(l.id));

  console.log('\n--- confidence calibration ---');
  console.log(`mean confidence when correct    ${fmt(confCorrect)}`);
  console.log(`mean confidence when wrong      ${fmt(confWrong)}`);
  if (!Number.isNaN(confWrong) && !Number.isNaN(confCorrect)) {
    console.log(
      confWrong < confCorrect
        ? 'Confidence is directionally useful: the model is less sure when it is wrong.'
        : 'Confidence is NOT tracking correctness here — treat the review threshold as unjustified.',
    );
  }

  // --- routing safety ------------------------------------------------------
  // The failure that actually costs money is a real message silently routed to a
  // no-action bucket. Report it separately from raw accuracy.
  const silentDrops = expected.labels.filter((l) => {
    const got = actual.get(l.id);
    if (!got?.category) return false;
    const wasReal = !['noise', 'unclear'].includes(l.category);
    const gotDropped = ['noise'].includes(got.category) && !got.needs_review;
    return wasReal && gotDropped;
  });
  console.log('\n--- routing safety ---');
  console.log(`real messages sent to a no-action bucket without review: ${silentDrops.length}`);
  for (const d of silentDrops) console.log(`  ${d.id} (should be ${d.category})`);

  const unused = CATEGORIES.filter(
    (c) => ![...actual.values()].some((a) => a.category === c),
  );
  if (unused.length > 0) {
    console.log(`\ncategories never used on this set: ${unused.join(', ')}`);
    console.log('(not necessarily wrong — but an unused category is one to justify or cut)');
  }
}

function fmt(n: number): string {
  return Number.isNaN(n) ? 'n/a' : n.toFixed(2);
}

main().catch((err) => {
  console.error('\nEval failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
