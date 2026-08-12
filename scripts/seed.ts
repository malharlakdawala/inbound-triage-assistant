/**
 * Loads the taxonomy, contacts and messages into Supabase.
 *
 * Idempotent — safe to re-run. Uses the service-role key, so it is a local-only
 * script by design.
 */
import '../lib/load-env';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeClient } from '../lib/supabase';
import {
  CATEGORIES,
  CATEGORY_DEFINITIONS,
  CATEGORY_ROUTING,
  PRIORITIES,
  PRIORITY_RULES,
} from '../lib/taxonomy';
import { normalize, type InboundMessage } from '../lib/normalize';

/** Senders who state in their own words that they are already clients. */
const EXISTING_CLIENT_PATTERNS = [
  /\bi'?m an existing client\b/i,
  /\bexisting client here\b/i,
  /\bi'?m a client\b/i,
  /\bclient of yours\b/i,
];

function looksLikeExistingClient(body: string): boolean {
  return EXISTING_CLIENT_PATTERNS.slice(0, 3).some((re) => re.test(body));
}

async function main() {
  const supabase = writeClient();
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), 'data', 'inbound.json'), 'utf8'),
  ) as InboundMessage[];

  // --- taxonomy ------------------------------------------------------------
  const categoryRows = CATEGORIES.map((slug, i) => ({
    slug,
    label: slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    definition: CATEGORY_DEFINITIONS[slug],
    routes_to: CATEGORY_ROUTING[slug],
    sort_order: (i + 1) * 10,
    active: true,
  }));
  {
    const { error } = await supabase.from('categories').upsert(categoryRows, { onConflict: 'slug' });
    if (error) throw new Error(`categories: ${error.message}`);
    console.log(`categories: ${categoryRows.length} upserted`);
  }

  const priorityRows = PRIORITIES.map((slug, i) => ({
    slug,
    rank: i + 1, // high=1, medium=2, low=3
    rule: PRIORITY_RULES[slug],
  }));
  {
    const { error } = await supabase.from('priorities').upsert(priorityRows, { onConflict: 'slug' });
    if (error) throw new Error(`priorities: ${error.message}`);
    console.log(`priorities: ${priorityRows.length} upserted`);
  }

  // --- contacts ------------------------------------------------------------
  // One contact per distinct named sender. Anonymous / corrupted senders get no
  // contact row rather than a placeholder, so the table stays trustworthy.
  const normalized = raw.map(normalize);

  const contactKey = (name: string, org: string | null) => `${name}::${org ?? ''}`;
  const contactSeed = new Map<string, { full_name: string; org: string | null; is_existing_client: boolean }>();

  for (const msg of normalized) {
    if (!msg.from_name) continue;
    const key = contactKey(msg.from_name, msg.from_org);
    const existing = contactSeed.get(key);
    const isClient = looksLikeExistingClient(msg.body);
    if (existing) {
      existing.is_existing_client = existing.is_existing_client || isClient;
    } else {
      contactSeed.set(key, {
        full_name: msg.from_name,
        org: msg.from_org,
        is_existing_client: isClient,
      });
    }
  }

  const contactRows = [...contactSeed.values()];
  {
    const { error } = await supabase
      .from('contacts')
      .upsert(contactRows, { onConflict: 'full_name,org' });
    if (error) throw new Error(`contacts: ${error.message}`);
  }
  const { data: storedContacts, error: readErr } = await supabase
    .from('contacts')
    .select('id, full_name, org');
  if (readErr) throw new Error(`contacts read: ${readErr.message}`);

  const contactId = new Map<string, string>();
  for (const c of storedContacts ?? []) {
    contactId.set(contactKey(c.full_name as string, (c.org as string | null) ?? null), c.id as string);
  }
  console.log(`contacts: ${contactRows.length} upserted`);

  // --- the referral edge ---------------------------------------------------
  // Derived rather than hardcoded: if message A names an existing contact who is
  // not its own sender, that is a referral. In this dataset it links Nathan
  // Brooks (inb-013) to Dana Whitfield (inb-002) — the single most commercially
  // useful fact in the set, and one a flat table would lose entirely.
  const idByName = new Map<string, string>();
  for (const c of storedContacts ?? []) {
    idByName.set(c.full_name as string, c.id as string);
  }

  const knownNames = [...idByName.keys()];
  let referralsLinked = 0;

  for (const msg of normalized) {
    if (!msg.from_name) continue;
    const haystack = `${msg.subject ?? ''} ${msg.body}`;
    const referrer = knownNames.find((n) => n !== msg.from_name && haystack.includes(n));
    if (!referrer) continue;

    const senderId = idByName.get(msg.from_name);
    const referrerId = idByName.get(referrer);
    if (!senderId || !referrerId) continue;

    const { error } = await supabase
      .from('contacts')
      .update({ referred_by_contact_id: referrerId })
      .eq('id', senderId);
    if (error) throw new Error(`referral link: ${error.message}`);
    referralsLinked++;
    console.log(`referral: ${msg.from_name} <- referred by ${referrer}`);
  }
  console.log(`referrals: ${referralsLinked} linked`);

  // --- messages ------------------------------------------------------------
  const messageRows = normalized.map((n, i) => {
    const src = raw[i]!;
    return {
      id: n.id,
      received_at: n.received_at,
      channel: n.channel,
      // Raw values preserved for auditability. NUL bytes are stripped even here:
      // Postgres rejects U+0000 in text columns outright, so "raw" means
      // "pre-normalisation", not "byte-identical".
      from_name_raw: stripNul(src.from_name),
      from_org_raw: stripNul(src.from_org),
      subject_raw: stripNul(src.subject),
      body_raw: stripNul(src.body),
      from_name: n.from_name,
      from_org: n.from_org,
      subject: n.subject,
      body: n.body,
      contact_id: n.from_name ? (contactId.get(contactKey(n.from_name, n.from_org)) ?? null) : null,
      low_signal: n.lowSignal,
      cleaned: n.cleaned,
    };
  });
  {
    const { error } = await supabase.from('messages').upsert(messageRows, { onConflict: 'id' });
    if (error) throw new Error(`messages: ${error.message}`);
    console.log(`messages: ${messageRows.length} upserted`);
  }

  const lowSignal = normalized.filter((n) => n.lowSignal);
  console.log(
    `\nflagged low-signal at ingest: ${lowSignal.map((n) => n.id).join(', ') || '(none)'}`,
  );
  console.log('Seed complete.');
}

/** Postgres text columns cannot hold U+0000 at all, in any column. */
function stripNul(v: string | null | undefined): string | null {
  if (v == null) return null;
  return v.replace(/\u0000/g, '');
}

main().catch((err) => {
  console.error('\nSeed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
