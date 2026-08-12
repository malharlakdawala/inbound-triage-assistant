import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { normalize, type InboundMessage } from '@/lib/normalize';
import { triageMessage } from '@/lib/llm';

/**
 * Public "try it" endpoint. Deliberately the only path on this deployment that
 * can spend money, and deliberately capped three ways.
 *
 * The rest of the app is read-only: it serves triage results produced locally and
 * holds no write credential. This route is the exception, because a reviewer
 * being able to *use* the tool is worth more than reading about it — but an
 * unauthenticated endpoint that calls a paid model is an API-key proxy, so the
 * guards have to be real rather than decorative:
 *
 *   1. Per-IP burst limit (Cloudflare rate-limit binding, 5 per 60s). Stops a
 *      single client hammering it.
 *   2. Global daily cap in KV. Bounds total spend no matter how many clients
 *      show up — the failure mode is "quota reached", never a surprise bill.
 *   3. Input length cap. Cost scales with input tokens, so an unbounded body is
 *      an unbounded charge.
 *
 * It also never writes to the database. Ad-hoc triage is returned to the caller
 * and discarded, so no service-role key is needed here and the stored queue
 * cannot be polluted by a stranger.
 */
export const runtime = 'nodejs';

const MAX_BODY_CHARS = 2000;
const MAX_FIELD_CHARS = 200;
const DAILY_CAP = 150;
const PER_IP_PER_MINUTE = 5;

interface Env {
  TRIAGE_QUOTA?: KVNamespace;
  // The rate-limit binding is not in @cloudflare/workers-types yet.
  TRIAGE_RATE_LIMIT?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
}

function rateLimited() {
  return NextResponse.json(
    {
      error: 'Rate limited.',
      detail: `${PER_IP_PER_MINUTE} triages per minute per IP. This limit exists because the endpoint spends real money.`,
    },
    { status: 429 },
  );
}

/** UTC day key, so the cap resets predictably regardless of caller timezone. */
function quotaKey(): string {
  return `try:${new Date().toISOString().slice(0, 10)}`;
}

export async function POST(request: Request) {
  let env: Env = {};
  try {
    ({ env } = getCloudflareContext() as unknown as { env: Env });
  } catch {
    // Running under `next dev` rather than workerd: no bindings available.
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const onWorkers = request.headers.has('cf-connecting-ip');


  // --- guard 0: fail CLOSED -------------------------------------------------
  // The first version of this route wrapped each check in `if (binding)`, which
  // meant a missing binding silently disabled the guard. On a route that spends
  // money, an absent spend limit must refuse rather than proceed. Local dev has
  // no bindings and is allowed through; a deployed request without KV is not.
  if (onWorkers && !env.TRIAGE_QUOTA) {
    return NextResponse.json(
      {
        error: 'Live triage is disabled.',
        detail:
          'The spend-limit store is unavailable, so this endpoint refuses to call a paid API rather than run uncapped.',
      },
      { status: 503 },
    );
  }

  // --- input validation -----------------------------------------------------
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const str = (v: unknown, cap: number): string =>
    typeof v === 'string' ? v.slice(0, cap) : '';

  const body = str(payload.body, MAX_BODY_CHARS);
  const subject = str(payload.subject, MAX_FIELD_CHARS);

  if (body.trim().length === 0 && subject.trim().length === 0) {
    return NextResponse.json(
      { error: 'Provide a subject or a body to triage.' },
      { status: 400 },
    );
  }

  // --- guards 1 & 2: per-IP burst and global daily cap ---------------------
  // Both counters live in KV. KV is eventually consistent, so read-then-write can
  // undercount under a burst — measured: 8 rapid calls registered as 5. That is
  // acceptable for a demo spend ceiling (the overshoot is cents, and the cap
  // still binds within a few requests) but it is NOT a billing control. A
  // Durable Object gives true atomicity and is the fix if this ever metered
  // anything that mattered.
  //
  // The Cloudflare rate-limit binding is kept as an extra layer where present,
  // but it is deliberately no longer the only per-IP defence: it was bound and
  // still did not fire in testing, and a guard that cannot be observed working
  // should not be the one you depend on.
  let used = 0;

  if (env.TRIAGE_RATE_LIMIT) {
    try {
      const { success } = await env.TRIAGE_RATE_LIMIT.limit({ key: ip });
      if (!success) return rateLimited();
    } catch {
      // Binding present but threw. The KV limiter below still applies, so this
      // degrades to one working guard rather than none.
    }
  }

  if (env.TRIAGE_QUOTA) {
    const ipKey = `ip:${ip}:${Math.floor(Date.now() / 60_000)}`;
    const ipCount = Number((await env.TRIAGE_QUOTA.get(ipKey)) ?? '0');
    if (ipCount >= PER_IP_PER_MINUTE) return rateLimited();
    await env.TRIAGE_QUOTA.put(ipKey, String(ipCount + 1), { expirationTtl: 120 });

    used = Number((await env.TRIAGE_QUOTA.get(quotaKey())) ?? '0');
    if (used >= DAILY_CAP) {
      return NextResponse.json(
        {
          error: 'Daily demo quota reached.',
          detail: `This public demo is capped at ${DAILY_CAP} live triages per day so it cannot run up an unbounded bill. It resets at 00:00 UTC. The stored results on the main page are unaffected.`,
          quota: { used, cap: DAILY_CAP },
        },
        { status: 429 },
      );
    }
  }

  // --- triage ---------------------------------------------------------------
  const raw: InboundMessage = {
    id: 'live-try',
    received_at: new Date().toISOString(),
    channel: str(payload.channel, 40) || 'email',
    from_name: str(payload.from_name, MAX_FIELD_CHARS),
    from_org: str(payload.from_org, MAX_FIELD_CHARS),
    subject,
    body,
  };

  const normalized = normalize(raw);

  let outcome;
  try {
    outcome = await triageMessage(normalized, { effort: 'medium' });
  } catch (err) {
    // A missing credential is a configuration problem, not a user error.
    return NextResponse.json(
      {
        error: 'Live triage is unavailable.',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 503 },
    );
  }

  // Count only calls that actually reached the model.
  if (env.TRIAGE_QUOTA && outcome.source !== 'fallback') {
    await env.TRIAGE_QUOTA.put(quotaKey(), String(used + 1), {
      expirationTtl: 60 * 60 * 48,
    });
  }

  return NextResponse.json({
    result: outcome.result,
    source: outcome.source,
    needs_review: outcome.needs_review,
    error: outcome.error,
    attempts: outcome.attempts,
    // Surfaced so the preprocessing work is visible rather than invisible —
    // sentinel resolution and control-character stripping are decisions a
    // reviewer should be able to see, not trust.
    preprocessing: {
      from_org_resolved_to_null: raw.from_org.trim() !== '' && normalized.from_org === null,
      from_name_resolved_to_null: raw.from_name.trim() !== '' && normalized.from_name === null,
      low_signal: normalized.lowSignal,
      low_signal_reasons: normalized.lowSignalReasons,
      cleaned: normalized.cleaned,
    },
    meta: {
      model: outcome.model,
      prompt_version: outcome.prompt_version,
      latency_ms: outcome.latency_ms,
      input_tokens: outcome.input_tokens,
      output_tokens: outcome.output_tokens,
      cost_usd: Number(outcome.cost_usd.toFixed(5)),
    },
    quota: { used: used + 1, cap: DAILY_CAP },
  });
}
