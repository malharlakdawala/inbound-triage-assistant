import { NextResponse } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Spend guards shared by the two public "try it" endpoints.
 *
 * Both /api/try (backend 1, Claude via OpenRouter) and /api/try-n8n (backend 2,
 * Ollama Cloud via n8n) are unauthenticated endpoints that cost real money per
 * call. That makes them API-key proxies, so the guards have to be real rather
 * than decorative.
 *
 * This module exists because those guards were originally written inline in one
 * route. Copying them into the second route would have meant two implementations
 * of a spend limit drifting apart — and the failure mode of a spend limit that
 * silently stops matching its twin is a bill, not a bug report. One
 * implementation, two callers, separate counters.
 *
 * Counters are deliberately per-backend: the two backends bill to different
 * accounts, so a shared budget would let a cheap backend exhaust an expensive
 * one's allowance (and vice versa). Each gets its own daily cap and its own
 * per-IP window, which also means one submit from the UI costs each backend
 * exactly one call against its own limit.
 */

export const MAX_BODY_CHARS = 2000;
export const MAX_FIELD_CHARS = 200;

export interface Env {
  TRIAGE_QUOTA?: KVNamespace;
  // The rate-limit binding is not in @cloudflare/workers-types yet.
  TRIAGE_RATE_LIMIT?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
  N8N_WEBHOOK_URL?: string;
}

export interface GuardOptions {
  /** Namespace for this backend's counters. Keeps the two budgets independent. */
  scope: string;
  dailyCap: number;
  perIpPerMinute: number;
}

export type GuardOutcome =
  | { ok: false; response: NextResponse }
  | {
      ok: true;
      env: Env;
      used: number;
      /** Call only after the request actually reached the model. */
      commit: () => Promise<void>;
    };

export function getEnv(): Env {
  try {
    const { env } = getCloudflareContext() as unknown as { env: Env };
    return env;
  } catch {
    // Running under `next dev` rather than workerd: no bindings available.
    return {};
  }
}

/** UTC day key, so the cap resets predictably regardless of caller timezone. */
function quotaKey(scope: string): string {
  return `${scope}:${new Date().toISOString().slice(0, 10)}`;
}

export function str(v: unknown, cap: number): string {
  return typeof v === 'string' ? v.slice(0, cap) : '';
}

export async function applyGuards(
  request: Request,
  opts: GuardOptions,
): Promise<GuardOutcome> {
  const env = getEnv();
  const ip = request.headers.get('cf-connecting-ip') ?? 'local';
  const onWorkers = request.headers.has('cf-connecting-ip');

  // --- guard 0: fail CLOSED -------------------------------------------------
  // The first version of this logic wrapped each check in `if (binding)`, which
  // meant a missing binding silently disabled the guard. On a route that spends
  // money, an absent spend limit must refuse rather than proceed. Local dev has
  // no bindings and is allowed through; a deployed request without KV is not.
  if (onWorkers && !env.TRIAGE_QUOTA) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: 'Live triage is disabled.',
          detail:
            'The spend-limit store is unavailable, so this endpoint refuses to call a paid API rather than run uncapped.',
        },
        { status: 503 },
      ),
    };
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
  const rateLimited = () =>
    NextResponse.json(
      {
        error: 'Rate limited.',
        detail: `${opts.perIpPerMinute} triages per minute per IP on this backend. This limit exists because the endpoint spends real money.`,
      },
      { status: 429 },
    );

  if (env.TRIAGE_RATE_LIMIT) {
    try {
      const { success } = await env.TRIAGE_RATE_LIMIT.limit({ key: `${opts.scope}:${ip}` });
      if (!success) return { ok: false, response: rateLimited() };
    } catch {
      // Binding present but threw. The KV limiter below still applies, so this
      // degrades to one working guard rather than none.
    }
  }

  let used = 0;

  if (env.TRIAGE_QUOTA) {
    const ipKey = `ip:${opts.scope}:${ip}:${Math.floor(Date.now() / 60_000)}`;
    const ipCount = Number((await env.TRIAGE_QUOTA.get(ipKey)) ?? '0');
    if (ipCount >= opts.perIpPerMinute) return { ok: false, response: rateLimited() };
    await env.TRIAGE_QUOTA.put(ipKey, String(ipCount + 1), { expirationTtl: 120 });

    used = Number((await env.TRIAGE_QUOTA.get(quotaKey(opts.scope))) ?? '0');
    if (used >= opts.dailyCap) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: 'Daily demo quota reached.',
            detail: `This public demo is capped at ${opts.dailyCap} live triages per day per backend so it cannot run up an unbounded bill. It resets at 00:00 UTC. The stored results on the main page are unaffected.`,
            quota: { used, cap: opts.dailyCap },
          },
          { status: 429 },
        ),
      };
    }
  }

  const commit = async () => {
    if (!env.TRIAGE_QUOTA) return;
    await env.TRIAGE_QUOTA.put(quotaKey(opts.scope), String(used + 1), {
      expirationTtl: 60 * 60 * 48,
    });
  };

  return { ok: true, env, used, commit };
}
