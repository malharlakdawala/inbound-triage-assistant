import { createClient } from '@supabase/supabase-js';

/**
 * Two clients, deliberately separated.
 *
 * The read client uses the publishable (anon) key and is the only one that ever
 * reaches the browser or the hosting platform. RLS restricts it to SELECT.
 *
 * The write client uses the service-role key, which bypasses RLS entirely. It is
 * only ever constructed from a local script. If this project were deployed with
 * the service-role key in its environment, a bug in any route handler would be a
 * full-database write primitive — so it simply is not shipped.
 */

const SCHEMA = 'arootah_triage';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. See .env.example.`);
  return v;
}

/** Read-only client. Safe for the deployed app. */
export function readClient() {
  const url = required('NEXT_PUBLIC_SUPABASE_URL');
  const key = required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  return createClient(url, key, {
    db: { schema: SCHEMA },
    auth: { persistSession: false },
  });
}

/** Write client. Local scripts only — never in a deployed environment. */
export function writeClient() {
  const url = required('SUPABASE_URL');
  const key = required('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, {
    db: { schema: SCHEMA },
    auth: { persistSession: false },
  });
}

export interface QueueRow {
  message_id: string;
  received_at: string;
  channel: string;
  from_name: string | null;
  from_org: string | null;
  subject: string | null;
  body: string;
  low_signal: boolean;
  cleaned: string[];
  summary: string | null;
  category: string | null;
  category_label: string | null;
  routes_to: string | null;
  priority: string | null;
  priority_rank: number | null;
  next_action: string | null;
  confidence: number | null;
  reasoning: string | null;
  source: string | null;
  needs_review: boolean | null;
  error: string | null;
  prompt_version: string | null;
  model: string | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  referred_by: string | null;
}

/**
 * The read path used by the deployed app.
 *
 * Ordering is a product decision, so it is stated explicitly rather than left to
 * the view: **work you can act on, most confident first; anything ambiguous sinks
 * to the bottom.**
 *
 *   1. needs_review ascending — actionable rows first, flagged rows last.
 *   2. priority_rank ascending — high before medium before low.
 *   3. confidence descending — the surest call at the top of each band.
 *   4. received_at ascending — a stable tiebreak, so the order never shuffles
 *      between renders.
 *
 * `needs_review` does the heavy lifting for step 1 and it is worth being clear
 * why: it is already true when the category is `unclear`, when confidence falls
 * below the review threshold, or when triage degraded. So one flag pushes both
 * the unclear rows and the low-confidence rows to the bottom — there is no
 * separate "is it unclear" sort, because that would double-count the same signal.
 *
 * This inverts what the first version did, which surfaced the review queue at the
 * top. Both are defensible; the tradeoff is that ambiguous rows are now less
 * visible, which is the right call only because the "needs review" filter exists
 * to pull them back in one click. If nobody ever clicked that filter, burying
 * them would be how ambiguous messages quietly rot.
 */
export async function fetchQueue(): Promise<QueueRow[]> {
  const supabase = readClient();
  const { data, error } = await supabase
    .from('queue')
    .select('*')
    .order('needs_review', { ascending: true, nullsFirst: false })
    .order('priority_rank', { ascending: true, nullsFirst: false })
    .order('confidence', { ascending: false, nullsFirst: false })
    .order('received_at', { ascending: true });

  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return (data ?? []) as QueueRow[];
}
