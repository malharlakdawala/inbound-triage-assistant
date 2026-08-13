import { fetchQueue, type QueueRow } from '@/lib/supabase';
import QueueView from './QueueView';
import TryForm from './TryForm';

// Always read fresh — the triage script writes out of band, so a cached page
// would show stale results after a re-run.
export const dynamic = 'force-dynamic';

export default async function Page() {
  let rows: QueueRow[];
  let error: string | null = null;

  // The page renders even when the data layer is unreachable. A triage tool that
  // shows a stack trace instead of the inbox has failed at its only job, so a
  // read failure degrades to an explanation rather than a crash.
  try {
    rows = await fetchQueue();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    rows = [];
  }

  return (
    <main>
      <header className="masthead">
        <span className="eyebrow">Northwind Advisors · shared inbox</span>
        <h1>Inbound triage</h1>
        <p className="sub">
          Every message gets a one-line summary, a category, a priority and a{' '}
          <strong>concrete next action</strong> — produced by an LLM under a validated
          schema, so a malformed message or a failed call degrades to a flagged row
          instead of a crash.
        </p>
      </header>

      {error ? (
        <div className="err">
          <strong>Could not read the triage store.</strong>
          <br />
          <code>{error}</code>
          <br />
          <br />
          Check <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
          <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code>, and confirm the migration and seed have
          run.
        </div>
      ) : null}

      <TryForm />

      <QueueView rows={rows} />

      <footer>
        Priority orders the queue; it does not score the opportunity. A high-value prospect who says
        &ldquo;no rush&rdquo; is deliberately ranked low. Rows marked <em>review</em> are queued for a
        human because the model was unsure, the category is one we never auto-action, or triage
        degraded.
      </footer>
    </main>
  );
}
