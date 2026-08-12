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

const SCHEMA = 'triage';

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
 * The read path used by the deployed app. Sorts unactioned/urgent work first:
 * review queue, then priority rank, then arrival order.
 */
export async function fetchQueue(): Promise<QueueRow[]> {
  const supabase = readClient();
  const { data, error } = await supabase
    .from('queue')
    .select('*')
    .order('needs_review', { ascending: false, nullsFirst: false })
    .order('priority_rank', { ascending: true, nullsFirst: false })
    .order('received_at', { ascending: true });

  if (error) throw new Error(`Supabase read failed: ${error.message}`);
  return (data ?? []) as QueueRow[];
}
