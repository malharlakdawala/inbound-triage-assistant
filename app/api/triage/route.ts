import { NextResponse } from 'next/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalize, type InboundMessage } from '@/lib/normalize';
import { triageMessage } from '@/lib/anthropic';
import { writeClient } from '@/lib/supabase';
import type { SimulatedFailure } from '@/lib/schema';

/**
 * Live re-triage of a single message. Double-gated on purpose.
 *
 * This app is deployed to a public URL. An open endpoint that calls a paid LLM on
 * demand is an API-key proxy: anyone who finds it can loop it and spend the key's
 * budget. So this route refuses unless BOTH are present in the environment:
 *
 *   TRIAGE_ADMIN_TOKEN      - a shared secret, sent as x-admin-token
 *   SUPABASE_SERVICE_ROLE_KEY - needed to write, and never deployed
 *
 * Neither is set on the public deployment, so the hosted app is strictly
 * read-only and cannot spend money no matter what is sent to it. Locally both
 * exist, so the demo path works. The public site reads results the local script
 * already produced.
 */
export const runtime = 'nodejs';

export async function POST(request: Request) {
  const adminToken = process.env.TRIAGE_ADMIN_TOKEN;
  const canWrite = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!adminToken || !canWrite) {
    return NextResponse.json(
      {
        error: 'Live triage is disabled in this environment.',
        detail:
          'This deployment is read-only by design: it holds neither an admin token nor a write key, so it cannot call the LLM. Run `npm run triage` locally to produce results.',
      },
      { status: 501 },
    );
  }

  if (request.headers.get('x-admin-token') !== adminToken) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }

  let payload: { id?: string; simulate?: SimulatedFailure; effort?: 'low' | 'medium' | 'high' };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 });
  }
  if (!payload.id) {
    return NextResponse.json({ error: 'Provide { "id": "inb-001" }.' }, { status: 400 });
  }

  const messages = (
    JSON.parse(readFileSync(join(process.cwd(), 'data', 'inbound.json'), 'utf8')) as InboundMessage[]
  ).map(normalize);
  const msg = messages.find((m) => m.id === payload.id);
  if (!msg) {
    return NextResponse.json({ error: `Unknown message id ${payload.id}.` }, { status: 404 });
  }

  const outcome = await triageMessage(msg, {
    effort: payload.effort ?? 'medium',
    simulate: payload.simulate ?? 'none',
  });

  const supabase = writeClient();
  const { error } = await supabase.from('results').upsert(
    {
      message_id: msg.id,
      summary: outcome.result.summary,
      category: outcome.result.category,
      priority: outcome.result.priority,
      next_action: outcome.result.next_action,
      confidence: outcome.result.confidence,
      reasoning: outcome.result.reasoning,
      source: outcome.source,
      needs_review: outcome.needs_review,
      error: outcome.error,
      prompt_version: outcome.prompt_version,
      model: outcome.model,
      input_hash: outcome.input_hash,
      latency_ms: outcome.latency_ms,
      input_tokens: outcome.input_tokens,
      output_tokens: outcome.output_tokens,
      cost_usd: Number(outcome.cost_usd.toFixed(6)),
    },
    { onConflict: 'input_hash' },
  );
  if (error) {
    return NextResponse.json({ error: `Write failed: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    id: msg.id,
    source: outcome.source,
    needs_review: outcome.needs_review,
    result: outcome.result,
    attempts: outcome.attempts,
    latency_ms: outcome.latency_ms,
    cost_usd: outcome.cost_usd,
  });
}
