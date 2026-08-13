import { NextResponse } from 'next/server';
import { applyGuards, getEnv, str, MAX_BODY_CHARS, MAX_FIELD_CHARS } from '@/lib/try-guards';

/**
 * Backend 2: triage out-of-process. This route forwards to an n8n workflow on a
 * self-hosted instance, which does the normalising, prompting, validation and
 * repair retry as nodes rather than as TypeScript, calling gpt-oss:120b through
 * Ollama Cloud.
 *
 * Two deliberate choices here:
 *
 * 1. It proxies rather than letting the browser call the webhook directly.
 *    A direct call would put an unauthenticated, paid endpoint in client-side
 *    JavaScript with no spend guard in front of it, and would need CORS opened
 *    on the n8n side. Proxying keeps the same guards over both backends.
 *
 * 2. It is independent of backend 1. The UI fires both and renders whichever
 *    returns; n8n being unreachable degrades the page to one result rather than
 *    breaking it. That independence is the point of running two backends, so it
 *    should be visible rather than asserted — this route returns a structured
 *    error instead of throwing.
 */
export const runtime = 'nodejs';

const DAILY_CAP = 150;
// See lib/try-guards.ts: the KV counter undercounts ~2x, so 3 is what yields an
// effective ceiling near 5 per minute.
const PER_IP_PER_MINUTE = 3;

/** Measured p95 for this workflow is ~6s; 60s is a generous ceiling that still bounds a hang. */
const TIMEOUT_MS = 60_000;

export async function POST(request: Request) {
  const webhook = getEnv().N8N_WEBHOOK_URL ?? process.env.N8N_WEBHOOK_URL;

  if (!webhook) {
    return NextResponse.json(
      {
        backend: 'n8n',
        error: 'Backend 2 is not configured.',
        detail: 'N8N_WEBHOOK_URL is unset on this deployment.',
      },
      { status: 503 },
    );
  }

  const guard = await applyGuards(request, {
    scope: 'try-n8n',
    dailyCap: DAILY_CAP,
    perIpPerMinute: PER_IP_PER_MINUTE,
  });
  if (!guard.ok) return guard.response;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const body = str(payload.body, MAX_BODY_CHARS);
  const subject = str(payload.subject, MAX_FIELD_CHARS);

  if (body.trim().length === 0 && subject.trim().length === 0) {
    return NextResponse.json(
      { error: 'Provide a subject or a body to triage.' },
      { status: 400 },
    );
  }

  const forwarded = {
    id: 'live-try',
    received_at: new Date().toISOString(),
    channel: str(payload.channel, 40) || 'email',
    from_name: str(payload.from_name, MAX_FIELD_CHARS),
    from_org: str(payload.from_org, MAX_FIELD_CHARS),
    subject,
    body,
  };

  const started = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(forwarded),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Unreachable, DNS failure, or timeout. Reported, not thrown: backend 1's
    // result is still worth showing.
    return NextResponse.json(
      {
        backend: 'n8n',
        error: 'Backend 2 did not respond.',
        detail: err instanceof Error ? err.message : String(err),
        latency_ms: Date.now() - started,
      },
      { status: 502 },
    );
  }

  const latency = Date.now() - started;
  const text = await upstream.text();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      {
        backend: 'n8n',
        error: 'Backend 2 returned a non-JSON response.',
        detail: text.slice(0, 300),
        latency_ms: latency,
      },
      { status: 502 },
    );
  }

  if (!upstream.ok || !parsed.result) {
    return NextResponse.json(
      {
        backend: 'n8n',
        error: `Backend 2 returned ${upstream.status}.`,
        detail: typeof parsed.message === 'string' ? parsed.message : text.slice(0, 300),
        latency_ms: latency,
      },
      { status: 502 },
    );
  }

  await guard.commit();

  return NextResponse.json({
    ...parsed,
    backend: 'n8n',
    meta: {
      // The workflow does not meter tokens, so cost is deliberately absent here
      // rather than guessed. Latency is measured at this hop, which includes the
      // network leg to the n8n host — the comparable number, since backend 1's
      // latency is measured the same way.
      model: 'gpt-oss:120b (Ollama Cloud)',
      runtime: 'n8n workflow, 14 nodes',
      latency_ms: latency,
    },
    quota: { used: guard.used + 1, cap: DAILY_CAP },
  });
}
