/**
 * Runs triage over the inbound set and writes results to Supabase.
 *
 *   npm run triage                     # triage anything not already cached
 *   npm run triage -- --force          # re-triage everything
 *   npm run triage -- --only inb-009   # one message
 *   npm run triage -- --effort low     # cheaper / shallower
 *   npm run triage -- --simulate api_error
 *   npm run triage -- --dry-run        # no database writes
 *
 * Caching is keyed on sha256(message + prompt_version + model), so a re-run after
 * a prompt edit correctly re-triages everything, while a re-run with no changes
 * costs nothing. That distinction is the whole point: it makes iterating on the
 * prompt cheap without ever serving a stale answer.
 */
import '../lib/load-env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeClient } from '../lib/supabase';
import { normalize, inputHash, type InboundMessage } from '../lib/normalize';
import { triageMessage, activeModel, activeProvider, modelLabel, type TriageOutcome } from '../lib/llm';
import { PROMPT_VERSION } from '../lib/prompt';
import type { SimulatedFailure } from '../lib/schema';

const CONCURRENCY = 4;

interface Args {
  force: boolean;
  dryRun: boolean;
  only: string | null;
  effort: 'low' | 'medium' | 'high';
  simulate: SimulatedFailure;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const effort = (get('--effort') ?? 'medium') as Args['effort'];
  const simulate = (get('--simulate') ?? 'none') as SimulatedFailure;
  return {
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    only: get('--only'),
    effort,
    simulate,
  };
}

/** Bounded-concurrency map. Sequential is needlessly slow; unbounded invites 429s. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs();
  const supabase = writeClient();

  let messages = (
    JSON.parse(readFileSync(join(process.cwd(), 'data', 'inbound.json'), 'utf8')) as InboundMessage[]
  ).map(normalize);

  if (args.only) messages = messages.filter((m) => m.id === args.only);
  if (messages.length === 0) {
    console.error(`No messages matched${args.only ? ` --only ${args.only}` : ''}.`);
    process.exit(1);
  }

  // --- cache check ---------------------------------------------------------
  const MODEL = modelLabel();
  const hashes = messages.map((m) => inputHash(m, PROMPT_VERSION, MODEL));
  let cached = new Set<string>();
  if (!args.force && !args.dryRun) {
    const { data, error } = await supabase.from('results').select('input_hash').in('input_hash', hashes);
    if (error) throw new Error(`cache check: ${error.message}`);
    cached = new Set((data ?? []).map((r) => r.input_hash as string));
  }

  const todo = messages.filter((m, i) => args.force || !cached.has(hashes[i]!));
  const skipped = messages.length - todo.length;

  console.log(
    `provider=${activeProvider()} model=${activeModel()} prompt=${PROMPT_VERSION} effort=${args.effort}` +
      (args.simulate !== 'none' ? ` simulate=${args.simulate}` : '') +
      (args.dryRun ? ' (dry run)' : ''),
  );
  console.log(`${messages.length} message(s): ${todo.length} to triage, ${skipped} cached\n`);
  if (todo.length === 0) {
    console.log('Nothing to do. Use --force to re-triage.');
    return;
  }

  // --- run -----------------------------------------------------------------
  const started = Date.now();
  const outcomes = await mapLimit(todo, CONCURRENCY, async (msg) => {
    const outcome = await triageMessage(msg, { effort: args.effort, simulate: args.simulate });
    const flag =
      outcome.source === 'llm' ? ' ' : outcome.source === 'llm_repaired' ? 'R' : 'F';
    console.log(
      `${flag} ${msg.id}  ${outcome.result.category.padEnd(17)} ${outcome.result.priority.padEnd(6)}` +
        ` conf=${outcome.result.confidence.toFixed(2)}  ${outcome.latency_ms}ms` +
        `  ${outcome.result.summary}`,
    );
    if (outcome.error) console.log(`    ! ${outcome.error}`);
    return { msg, outcome };
  });
  const wallMs = Date.now() - started;

  // --- write ---------------------------------------------------------------
  if (!args.dryRun) {
    const rows = outcomes.map(({ msg, outcome }) => ({
      message_id: msg.id,
      summary: outcome.result.summary,
      category: outcome.result.category,
      priority: outcome.result.priority,
      next_action: outcome.result.next_action,
      confidence: outcome.result.confidence,
      reasoning: outcome.result.reasoning,
      source: outcome.source,
      needs_review: outcome.needs_review,
      error: outcome.error,
      prompt_version: outcome.prompt_version,
      model: outcome.model,
      input_hash: outcome.input_hash,
      latency_ms: outcome.latency_ms,
      input_tokens: outcome.input_tokens,
      output_tokens: outcome.output_tokens,
      cost_usd: Number(outcome.cost_usd.toFixed(6)),
    }));
    const { error } = await supabase.from('results').upsert(rows, { onConflict: 'input_hash' });
    if (error) throw new Error(`write results: ${error.message}`);
    console.log(`\nwrote ${rows.length} result(s)`);
  }

  summarise(outcomes.map((o) => o.outcome), wallMs);
}

function summarise(outcomes: TriageOutcome[], wallMs: number) {
  const n = outcomes.length;
  const sum = (f: (o: TriageOutcome) => number) => outcomes.reduce((a, o) => a + f(o), 0);
  const inTok = sum((o) => o.input_tokens);
  const outTok = sum((o) => o.output_tokens);
  const cost = sum((o) => o.cost_usd);
  const latencies = outcomes.map((o) => o.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(n * 0.5)] ?? 0;
  const p95 = latencies[Math.min(n - 1, Math.floor(n * 0.95))] ?? 0;

  const bySource = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.source] = (acc[o.source] ?? 0) + 1;
    return acc;
  }, {});

  console.log('\n--- run summary ---');
  console.log(`messages         ${n}`);
  console.log(
    `sources          ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join('  ')}`,
  );
  console.log(`needs review     ${outcomes.filter((o) => o.needs_review).length}`);
  console.log(`tokens           ${inTok} in / ${outTok} out`);
  console.log(`cost             $${cost.toFixed(4)}  ($${(cost / n).toFixed(5)} per message)`);
  console.log(`latency          p50 ${p50}ms  p95 ${p95}ms`);
  console.log(`wall clock       ${(wallMs / 1000).toFixed(1)}s at concurrency ${CONCURRENCY}`);

  // Extrapolation for the scale question in RATIONALE.md. Stated as arithmetic
  // rather than a guess, and deliberately linear — the point of the number is to
  // show which constraint binds first, not to claim it would actually hold.
  const perMsgCost = cost / n;
  const perMsgLatency = latencies.reduce((a, b) => a + b, 0) / n;
  const daily = 10_000;
  console.log('\n--- extrapolated to 10,000 messages/day (linear, no batching) ---');
  console.log(`cost             $${(perMsgCost * daily).toFixed(2)}/day  ~$${(perMsgCost * daily * 30).toFixed(0)}/month`);
  console.log(
    `compute time     ${((perMsgLatency * daily) / 1000 / 3600).toFixed(1)} core-hours/day` +
      `  = ${((perMsgLatency * daily) / 1000 / 3600 / 24).toFixed(1)}x concurrency just to keep up`,
  );
}

main().catch((err) => {
  console.error('\nTriage failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
