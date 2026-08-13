'use client';

import { useMemo, useState } from 'react';
import type { QueueRow } from '@/lib/supabase';

type Filter = 'all' | 'review' | 'high' | 'medium' | 'low';

function fmtTime(iso: string): string {
  // Fixed timezone so server and client render identically — a locale-dependent
  // format here is a hydration mismatch waiting to happen.
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

export default function QueueView({ rows }: { rows: QueueRow[] }) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(
    () => ({
      all: rows.length,
      review: rows.filter((r) => r.needs_review).length,
      high: rows.filter((r) => r.priority === 'high').length,
      medium: rows.filter((r) => r.priority === 'medium').length,
      low: rows.filter((r) => r.priority === 'low').length,
    }),
    [rows],
  );

  const visible = useMemo(() => {
    if (filter === 'all') return rows;
    if (filter === 'review') return rows.filter((r) => r.needs_review);
    return rows.filter((r) => r.priority === filter);
  }, [rows, filter]);

  const totalCost = rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  const latencies = rows.map((r) => r.latency_ms ?? 0).filter((n) => n > 0);
  const medianLatency =
    latencies.length > 0
      ? [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)]!
      : 0;
  const degraded = rows.filter((r) => r.source && r.source !== 'llm').length;

  return (
    <>
      <div className="section-head">
        <h2>Triage queue</h2>
        <span className="section-note">
          Stored results, ordered by what needs attention first
        </span>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <span className="stat-label">Messages</span>
          <span className="stat-value">{rows.length}</span>
        </div>
        <div className={`stat${counts.review > 0 ? ' flagged' : ''}`}>
          <span className="stat-label">Needs review</span>
          <span className="stat-value">{counts.review}</span>
        </div>
        <div className={`stat${degraded > 0 ? ' flagged' : ''}`}>
          <span className="stat-label">Degraded rows</span>
          <span className="stat-value">{degraded}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Median latency</span>
          <span className="stat-value">{medianLatency}ms</span>
        </div>
        <div className="stat accent">
          <span className="stat-label">Run cost</span>
          <span className="stat-value">${totalCost.toFixed(4)}</span>
        </div>
        {/* Model and prompt version share one tile: they are read together (a
            number is only meaningful for a given model+prompt pair), and pairing
            them makes the row of tiles come out even. */}
        <div className="stat wide">
          <span className="stat-label">Model</span>
          <span className="stat-value small">{rows.find((r) => r.model)?.model ?? '—'}</span>
          <span className="stat-sub">
            prompt {rows.find((r) => r.prompt_version)?.prompt_version ?? '—'}
          </span>
        </div>
      </div>

      <div className="controls">
        {(['all', 'review', 'high', 'medium', 'low'] as Filter[]).map((f) => (
          <button
            key={f}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'review' ? 'needs review' : f} ({counts[f]})
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="empty">Nothing in this view.</div>
      ) : (
        visible.map((r) => <Card key={r.message_id} row={r} />)
      )}
    </>
  );
}

function Card({ row: r }: { row: QueueRow }) {
  const triaged = r.category != null;

  // The priority stripe is a class rather than an inline style so the palette
  // stays in one file.
  const stripe = r.priority ? ` p-${r.priority}` : '';

  return (
    <article className={`card${stripe}${r.needs_review ? ' review' : ''}`}>
      <div className="card-top">
        <div>
          <div className="who">
            {r.from_name ?? <em style={{ fontWeight: 400 }}>no sender name</em>}
            {r.from_org ? <span className="org"> · {r.from_org}</span> : null}
          </div>
          <div className="meta">
            {r.message_id} · {r.channel} · {fmtTime(r.received_at)}
            {r.subject ? ` · ${r.subject}` : ' · (no subject)'}
          </div>
        </div>
        <div className="badges">
          {r.priority ? <span className={`badge ${r.priority}`}>{r.priority}</span> : null}
          {r.category ? <span className="badge cat">{r.category.replace(/_/g, ' ')}</span> : null}
          {r.needs_review ? <span className="badge flag">review</span> : null}
          {r.source && r.source !== 'llm' ? (
            <span className="badge flag">{r.source.replace('llm_', '')}</span>
          ) : null}
        </div>
      </div>

      {triaged ? (
        <>
          <p className="summary">{r.summary}</p>
          <p className="action">
            <strong>Next:</strong> {r.next_action}
          </p>
        </>
      ) : (
        <p className="summary">
          <em>Not yet triaged. Run `npm run triage`.</em>
        </p>
      )}

      <details>
        <summary>Original message and triage detail</summary>
        <div className="detail-body">
          <blockquote className="body">{r.body || '(empty body)'}</blockquote>
          {r.reasoning ? (
            <div>
              <strong>Model reasoning:</strong> {r.reasoning}
            </div>
          ) : null}
          {r.confidence != null ? (
            <div>
              <strong>Confidence:</strong> {Number(r.confidence).toFixed(2)}
              {r.routes_to ? ` · routes to ${r.routes_to}` : ''}
            </div>
          ) : null}
          {r.referred_by ? (
            <div>
              <strong>Referred by:</strong> {r.referred_by} (existing client)
            </div>
          ) : null}
          {r.low_signal ? (
            <div>
              <strong>Flagged low-signal at ingest.</strong>
            </div>
          ) : null}
          {r.cleaned && r.cleaned.length > 0 ? (
            <div>
              <strong>Cleaned before the model saw it:</strong> {r.cleaned.join('; ')}
            </div>
          ) : null}
          {r.error ? (
            <div>
              <strong>Degraded:</strong> <code>{r.error}</code>
            </div>
          ) : null}
          <div>
            <code>
              {r.source ?? 'untriaged'} · {r.latency_ms ?? 0}ms · {r.input_tokens ?? 0}in/
              {r.output_tokens ?? 0}out · ${Number(r.cost_usd ?? 0).toFixed(5)}
            </code>
          </div>
        </div>
      </details>
    </article>
  );
}
