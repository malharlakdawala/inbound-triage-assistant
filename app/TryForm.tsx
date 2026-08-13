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
  backend?: string;
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
    runtime?: string;
    prompt_version?: string;
    latency_ms: number;
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
  quota?: { used: number; cap: number };
  detail?: string;
}

interface Slot {
  busy: boolean;
  res: TryResult | null;
  err: string | null;
}

const IDLE: Slot = { busy: false, res: null, err: null };

/** One backend's column. Kept identical between the two so the comparison is like-for-like. */
function BackendPanel({
  n,
  title,
  subtitle,
  slot,
}: {
  n: number;
  title: string;
  subtitle: string;
  slot: Slot;
}) {
  const r = slot.res?.result;
  return (
    <div className="cmp-panel">
      <div className="cmp-head">
        <span className="cmp-num">Backend {n}</span>
        <div>
          <strong>{title}</strong>
          <span className="cmp-sub">{subtitle}</span>
        </div>
      </div>

      {slot.busy ? <div className="cmp-wait">Triaging…</div> : null}

      {slot.err ? (
        <div className="cmp-err">
          <strong>{slot.err}</strong>
          <div className="cmp-errnote">
            The other backend is unaffected — the two run independently.
          </div>
        </div>
      ) : null}

      {r ? (
        <div className="try-result">
          <div className="badges">
            <span className={`badge ${r.priority}`}>{r.priority}</span>
            <span className="badge cat">{r.category.replace(/_/g, ' ')}</span>
            {slot.res?.needs_review ? <span className="badge flag">review</span> : null}
            {slot.res?.source && slot.res.source !== 'llm' ? (
              <span className="badge flag">{slot.res.source.replace('llm_', '')}</span>
            ) : null}
          </div>
          <p className="summary">{r.summary}</p>
          <p className="action">
            <strong>Next:</strong> {r.next_action}
          </p>
          <div className="try-detail">
            <div>
              <strong>Confidence:</strong> {r.confidence.toFixed(2)} ·{' '}
              <strong>Reasoning:</strong> {r.reasoning}
            </div>
            {slot.res?.error ? (
              <div>
                <strong>Recovered from:</strong> <code>{slot.res.error}</code>
              </div>
            ) : null}
            {slot.res?.preprocessing ? (
              <div>
                <strong>Preprocessing:</strong>{' '}
                {[
                  slot.res.preprocessing.from_org_resolved_to_null
                    ? 'organisation was a sentinel → null'
                    : null,
                  slot.res.preprocessing.from_name_resolved_to_null
                    ? 'sender name unusable → null'
                    : null,
                  slot.res.preprocessing.low_signal
                    ? `low-signal (${slot.res.preprocessing.low_signal_reasons.join('; ')})`
                    : null,
                  slot.res.preprocessing.cleaned.length
                    ? `cleaned: ${slot.res.preprocessing.cleaned.join('; ')}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'nothing to clean'}
              </div>
            ) : null}
            {slot.res?.meta ? (
              <div>
                <code>
                  {slot.res.meta.model}
                  {slot.res.meta.prompt_version ? ` ${slot.res.meta.prompt_version}` : ''}
                  {slot.res.meta.runtime ? ` · ${slot.res.meta.runtime}` : ''} ·{' '}
                  {slot.res.meta.latency_ms}ms
                  {typeof slot.res.meta.input_tokens === 'number'
                    ? ` · ${slot.res.meta.input_tokens}in/${slot.res.meta.output_tokens}out`
                    : ''}
                  {typeof slot.res.meta.cost_usd === 'number'
                    ? ` · $${slot.res.meta.cost_usd.toFixed(5)}`
                    : ' · cost not metered'}
                </code>
              </div>
            ) : null}
            {slot.res?.quota ? (
              <div className="try-quota">
                {slot.res.quota.used}/{slot.res.quota.cap} live triages used today on this backend
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function TryForm() {
  const [fromName, setFromName] = useState('');
  const [fromOrg, setFromOrg] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [s1, setS1] = useState<Slot>(IDLE);
  const [s2, setS2] = useState<Slot>(IDLE);

  const busy = s1.busy || s2.busy;

  function loadExample(i: number) {
    const e = EXAMPLES[i];
    if (!e) return;
    setFromName(e.from_name);
    setFromOrg(e.from_org);
    setSubject(e.subject);
    setBody(e.body);
    setS1(IDLE);
    setS2(IDLE);
  }

  /**
   * Both backends are fired independently rather than sequentially or as one
   * combined request. Sequential would double the wait; combined would mean one
   * backend failing takes the other's result with it. Independent means each
   * column fills in as its backend returns, and a dead backend is visibly dead
   * next to a live one.
   */
  async function callBackend(path: string, set: (s: Slot) => void, payload: unknown) {
    set({ busy: true, res: null, err: null });
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await r.json()) as TryResult;
      if (!r.ok) {
        set({
          busy: false,
          res: json.quota ? { quota: json.quota } : null,
          err: [json.error, json.detail].filter(Boolean).join(' '),
        });
      } else {
        set({ busy: false, res: json, err: null });
      }
    } catch (e) {
      set({ busy: false, res: null, err: e instanceof Error ? e.message : String(e) });
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload = { from_name: fromName, from_org: fromOrg, subject, body };
    await Promise.all([
      callBackend('/api/try', setS1, payload),
      callBackend('/api/try-n8n', setS2, payload),
    ]);
  }

  const r1 = s1.res?.result;
  const r2 = s2.res?.result;
  const agree = r1 && r2 ? r1.category === r2.category && r1.priority === r2.priority : null;

  return (
    <section className="try">
      <div className="try-head">
        <h2>Try it live — both backends, same message</h2>
        <span className="try-live">live</span>
      </div>
      <p className="try-sub">
        One message, two independent implementations of the same pipeline: sentinel
        stripping, low-signal detection, a constrained model call, schema validation and
        one repair retry. <strong>Backend 1</strong> does this in TypeScript inside this
        app; <strong>Backend 2</strong> does it as nodes in a self-hosted n8n workflow
        against a different model. Nothing you enter is stored.
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
          {busy ? 'Triaging on both backends…' : 'Triage on both backends'}
        </button>
      </form>

      {agree !== null ? (
        <div className={`cmp-verdict ${agree ? 'same' : 'diff'}`}>
          {agree ? (
            <>
              <strong>Both backends agree</strong> — {r1!.category.replace(/_/g, ' ')} /{' '}
              {r1!.priority}. Two different models, two different runtimes, same call.
            </>
          ) : (
            <>
              <strong>The backends disagree.</strong>{' '}
              {r1!.category !== r2!.category
                ? `Category: ${r1!.category.replace(/_/g, ' ')} vs ${r2!.category.replace(/_/g, ' ')}. `
                : ''}
              {r1!.priority !== r2!.priority
                ? `Priority: ${r1!.priority} vs ${r2!.priority}. `
                : ''}
              Worth reading both reasonings — disagreement usually means the message is
              genuinely ambiguous, not that one model is broken.
            </>
          )}
        </div>
      ) : null}

      <div className="cmp-grid">
        <BackendPanel
          n={1}
          title="Next.js + Claude"
          subtitle="in-process TypeScript · claude-opus-5 via OpenRouter"
          slot={s1}
        />
        <BackendPanel
          n={2}
          title="n8n + Ollama"
          subtitle="self-hosted workflow · gpt-oss:120b via Ollama Cloud"
          slot={s2}
        />
      </div>
    </section>
  );
}
