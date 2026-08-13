import { NextResponse } from 'next/server';
import { normalize, type InboundMessage } from '@/lib/normalize';
import { triageMessage } from '@/lib/llm';
import { applyGuards, str, MAX_BODY_CHARS, MAX_FIELD_CHARS } from '@/lib/try-guards';

/**
 * Backend 1: triage in-process. Next.js route handler → OpenRouter → claude-opus-5
 * under constrained decoding, then Zod revalidation and one repair retry.
 *
 * Public "try it" endpoint, and deliberately one of only two paths on this
 * deployment that can spend money. Spend guards live in lib/try-guards.ts and
 * are shared with backend 2 so the two limits cannot drift apart.
 *
 * It also never writes to the database. Ad-hoc triage is returned to the caller
 * and discarded, so no service-role key is needed here and the stored queue
 * cannot be polluted by a stranger.
 */
export const runtime = 'nodejs';

const DAILY_CAP = 150;
// Set to 3, not 5, because the KV counter undercounts ~2x under bursts (measured;
// see lib/try-guards.ts). The intent is "about 5 per minute"; 3 is what produces
// that in practice.
const PER_IP_PER_MINUTE = 3;

export async function POST(request: Request) {
  const guard = await applyGuards(request, {
    scope: 'try',
    dailyCap: DAILY_CAP,
    perIpPerMinute: PER_IP_PER_MINUTE,
  });
  if (!guard.ok) return guard.response;

  // --- input validation -----------------------------------------------------
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
  if (outcome.source !== 'fallback') await guard.commit();

  return NextResponse.json({
    backend: 'nextjs',
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
    quota: { used: guard.used + 1, cap: DAILY_CAP },
  });
}
