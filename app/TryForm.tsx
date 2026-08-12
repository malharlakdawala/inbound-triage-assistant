'use client';

import { useState } from 'react';

const EXAMPLES: Array<{ label: string; from_name: string; from_org: string; subject: string; body: string }> = [
  {
    label: 'Angry client',
    from_name: 'Marta Vela',
    from_org: '(individual)',
    subject: '',
    body: "I've been a client for six years and nobody has returned my call about the withdrawal I requested on Monday. I need someone to ring me back today or I'm moving the account.",
  },
  {
    label: 'Cold vendor pitch',
    from_name: 'Devon Park',
    from_org: 'NorthPeak Compliance',
    subject: 'Cut your compliance review time by 40%',
    body: 'Hi there — we help RIAs automate annual compliance reviews. Happy to show you a 15 minute demo. Do you have time Thursday?',
  },
  {
    label: 'Garbled / corrupt',
    from_name: '=?utf-8?B?',
    from_org: '(unknown)',
    subject: 'FWD: RE:',
    body: '--- forwarded message truncated --- Content-Type: multipart/alternative; boundary=00042',
  },
  {
    label: 'Ambiguous follow-up',
    from_name: 'Chris',
    from_org: '(unknown)',
    subject: 'circling back',
    body: 'Hey, any update on that thing we discussed? Thanks',
  },
];

interface TryResult {
  result?: {
    summary: string;
    category: string;
    priority: string;
    next_action: string;
    confidence: number;
    reasoning: string;
  };
  source?: string;
  needs_review?: boolean;
  error?: string | null;
  preprocessing?: {
    from_org_resolved_to_null: boolean;
    from_name_resolved_to_null: boolean;
    low_signal: boolean;
    low_signal_reasons: string[];
    cleaned: string[];
  };
  meta?: {
    model: string;
    prompt_version: string;
    latency_ms: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  quota?: { used: number; cap: number };
  detail?: string;
}

export default function TryForm() {
  const [open, setOpen] = useState(false);
  const [fromName, setFromName] = useState('');
  const [fromOrg, setFromOrg] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<TryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function loadExample(i: number) {
    const e = EXAMPLES[i];
    if (!e) return;
    setFromName(e.from_name);
    setFromOrg(e.from_org);
    setSubject(e.subject);
    setBody(e.body);
    setRes(null);
    setErr(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await fetch('/api/try', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_name: fromName, from_org: fromOrg, subject, body }),
      });
      const json = (await r.json()) as TryResult & { error?: string };
      if (!r.ok) {
        setErr([json.error, json.detail].filter(Boolean).join(' '));
        if (json.quota) setRes({ quota: json.quota });
      } else {
        setRes(json);
      }
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="try-collapsed">
        <button type="button" className="try-open" onClick={() => setOpen(true)}>
          Try it on your own message →
        </button>
        <span className="try-note">
          Runs a real claude-opus-5 call. Capped at 150/day so the demo cannot run up a bill.
        </span>
      </div>
    );
  }

  return (
    <section className="try">
      <div className="try-head">
        <h2>Try it live</h2>
        <button type="button" className="try-close" onClick={() => setOpen(false)}>
          close
        </button>
      </div>
      <p className="try-sub">
        Paste a message and it runs the same pipeline as the queue above: sentinel
        stripping, low-signal detection, a constrained <code>claude-opus-5</code> call,
        schema validation, and one repair retry on failure. Nothing you enter is stored.
      </p>

      <div className="try-examples">
        <span>Load an example:</span>
        {EXAMPLES.map((e, i) => (
          <button key={e.label} type="button" onClick={() => loadExample(i)}>
            {e.label}
          </button>
        ))}
      </div>

      <form onSubmit={submit}>
        <div className="try-row">
          <label>
            Sender name
            <input
              value={fromName}
              onChange={(ev) => setFromName(ev.target.value)}
              maxLength={200}
              placeholder="Jane Doe"
            />
          </label>
          <label>
            Sender organisation
            <input
              value={fromOrg}
              onChange={(ev) => setFromOrg(ev.target.value)}
              maxLength={200}
              placeholder="(individual)"
            />
          </label>
        </div>
        <label>
          Subject
          <input
            value={subject}
            onChange={(ev) => setSubject(ev.target.value)}
            maxLength={200}
            placeholder="Question about my portfolio"
          />
        </label>
        <label>
          Body
          <textarea
            value={body}
            onChange={(ev) => setBody(ev.target.value)}
            maxLength={2000}
            rows={5}
            placeholder="Paste the message here..."
          />
          <span className="try-count">{body.length}/2000</span>
        </label>
        <button type="submit" disabled={busy} className="try-submit">
          {busy ? 'Triaging…' : 'Triage this message'}
        </button>
      </form>

      {err ? (
        <div className="try-err">
          <strong>{err}</strong>
          {res?.quota ? (
            <div className="try-quota">
              {res.quota.used}/{res.quota.cap} live triages used today
            </div>
          ) : null}
        </div>
      ) : null}

      {res?.result ? (
        <div className="try-result">
          <div className="badges">
            <span className={`badge ${res.result.priority}`}>{res.result.priority}</span>
            <span className="badge cat">{res.result.category.replace(/_/g, ' ')}</span>
            {res.needs_review ? <span className="badge flag">review</span> : null}
            {res.source && res.source !== 'llm' ? (
              <span className="badge flag">{res.source.replace('llm_', '')}</span>
            ) : null}
          </div>
          <p className="summary">{res.result.summary}</p>
          <p className="action">
            <strong>Next:</strong> {res.result.next_action}
          </p>
          <div className="try-detail">
            <div>
              <strong>Confidence:</strong> {res.result.confidence.toFixed(2)} ·{' '}
              <strong>Reasoning:</strong> {res.result.reasoning}
            </div>
            {res.error ? (
              <div>
                <strong>Recovered from:</strong> <code>{res.error}</code>
              </div>
            ) : null}
            {res.preprocessing ? (
              <div>
                <strong>Preprocessing:</strong>{' '}
                {[
                  res.preprocessing.from_org_resolved_to_null
                    ? 'organisation was a sentinel → null'
                    : null,
                  res.preprocessing.from_name_resolved_to_null
                    ? 'sender name unusable → null'
                    : null,
                  res.preprocessing.low_signal
                    ? `low-signal (${res.preprocessing.low_signal_reasons.join('; ')})`
                    : null,
                  res.preprocessing.cleaned.length
                    ? `cleaned: ${res.preprocessing.cleaned.join('; ')}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'nothing to clean'}
              </div>
            ) : null}
            {res.meta ? (
              <div>
                <code>
                  {res.meta.model} {res.meta.prompt_version} · {res.meta.latency_ms}ms ·{' '}
                  {res.meta.input_tokens}in/{res.meta.output_tokens}out · $
                  {res.meta.cost_usd.toFixed(5)}
                </code>
              </div>
            ) : null}
            {res.quota ? (
              <div className="try-quota">
                {res.quota.used}/{res.quota.cap} live triages used today
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
