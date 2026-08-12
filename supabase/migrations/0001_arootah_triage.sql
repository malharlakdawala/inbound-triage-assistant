-- Inbound Triage Assistant — schema
--
-- Everything lives in a dedicated `arootah_triage` schema so it is namespaced away from
-- anything else in this Supabase project.
--
-- The central design decision is that the taxonomy is DATA, not schema. Categories
-- and priorities are rows in lookup tables, and `results` holds foreign keys to
-- them. Adding a category is an INSERT — no migration, no enum ALTER, no deploy,
-- and no risk to the rows already stored. If the taxonomy doubled tomorrow, the
-- only code change would be to the prompt text; the database would not move.
--
-- The alternative — a Postgres ENUM or a CHECK constraint — reads tidier and is
-- worse: every taxonomy change becomes a locking DDL migration, and historical
-- rows silently become unexplainable when a category is retired.

create schema if not exists arootah_triage;

-- ---------------------------------------------------------------------------
-- Taxonomy lookup tables
-- ---------------------------------------------------------------------------

create table if not exists arootah_triage.categories (
  slug        text primary key,
  label       text not null,
  definition  text not null,
  routes_to   text not null,
  -- Retire a category by flipping `active` rather than deleting it, so existing
  -- results keep a valid foreign key and stay interpretable.
  active      boolean not null default true,
  sort_order  integer not null default 100,
  created_at  timestamptz not null default now()
);

create table if not exists arootah_triage.priorities (
  slug       text primary key,
  -- Sort order for the queue. Lower rank surfaces first.
  rank       integer not null unique,
  rule       text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Contacts — exists to carry the one linked relationship
-- ---------------------------------------------------------------------------
-- inb-013 ("Referred by Dana Whitfield") points at the sender of inb-002. That
-- referral edge is the most commercially valuable fact in the whole dataset, and
-- it is invisible if messages are stored as flat rows. `referred_by_contact_id`
-- is the self-referencing FK that captures it, and it is the relationship the
-- Airtable note in the README mirrors.

create table if not exists arootah_triage.contacts (
  id                     uuid primary key default gen_random_uuid(),
  full_name              text not null,
  org                    text,
  is_existing_client     boolean not null default false,
  referred_by_contact_id uuid references arootah_triage.contacts (id) on delete set null,
  created_at             timestamptz not null default now(),
  unique (full_name, org)
);

-- ---------------------------------------------------------------------------
-- Messages — the immutable inbound record
-- ---------------------------------------------------------------------------

create table if not exists arootah_triage.messages (
  id           text primary key,                -- the source id, e.g. 'inb-001'
  received_at  timestamptz not null,
  channel      text not null,
  -- Raw values exactly as received, sentinels and all, so the source stays
  -- reproducible and normalisation decisions remain auditable after the fact.
  from_name_raw text,
  from_org_raw  text,
  subject_raw   text,
  body_raw      text,
  -- Post-normalisation values: sentinels resolved to NULL, control characters
  -- stripped. This is what the model was actually shown.
  from_name    text,
  from_org     text,
  subject      text,
  body         text not null,
  contact_id   uuid references arootah_triage.contacts (id) on delete set null,
  low_signal   boolean not null default false,
  cleaned      jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists messages_received_at_idx on arootah_triage.messages (received_at desc);

-- ---------------------------------------------------------------------------
-- Results — one row per (message, prompt_version, model)
-- ---------------------------------------------------------------------------
-- Keyed on input_hash rather than message_id alone: re-running with the same
-- prompt and model is a cache hit costing nothing, while editing the prompt
-- produces a genuinely new row instead of overwriting history. That means two
-- prompt versions can be compared on the same messages, which is what makes the
-- eval harness worth having.

create table if not exists arootah_triage.results (
  id             uuid primary key default gen_random_uuid(),
  message_id     text not null references arootah_triage.messages (id) on delete cascade,
  summary        text not null,
  category       text not null references arootah_triage.categories (slug),
  priority       text not null references arootah_triage.priorities (slug),
  next_action    text not null,
  confidence     numeric(3, 2) not null check (confidence >= 0 and confidence <= 1),
  reasoning      text,

  -- Provenance. `source` records whether this row came from a clean pass, a
  -- schema-repair retry, or the deterministic fallback — so a degraded result is
  -- never indistinguishable from a good one.
  source         text not null check (source in ('llm', 'llm_repaired', 'fallback')),
  needs_review   boolean not null default false,
  error          text,

  prompt_version text not null,
  model          text not null,
  input_hash     text not null,

  latency_ms     integer,
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       numeric(10, 6),

  created_at     timestamptz not null default now(),
  unique (input_hash)
);

create index if not exists results_message_idx on arootah_triage.results (message_id);
create index if not exists results_review_idx on arootah_triage.results (needs_review) where needs_review;

-- ---------------------------------------------------------------------------
-- Convenience view for the front end
-- ---------------------------------------------------------------------------
-- The UI reads this instead of joining four tables client-side, and it sorts by
-- priority rank so "most urgent first" is the database's job, not the browser's.

create or replace view arootah_triage.queue as
select
  m.id                as message_id,
  m.received_at,
  m.channel,
  m.from_name,
  m.from_org,
  m.subject,
  m.body,
  m.low_signal,
  m.cleaned,
  r.summary,
  r.category,
  c.label             as category_label,
  c.routes_to,
  r.priority,
  p.rank              as priority_rank,
  r.next_action,
  r.confidence,
  r.reasoning,
  r.source,
  r.needs_review,
  r.error,
  r.prompt_version,
  r.model,
  r.latency_ms,
  r.input_tokens,
  r.output_tokens,
  r.cost_usd,
  ref.full_name       as referred_by
from arootah_triage.messages m
left join arootah_triage.results    r  on r.message_id = m.id
left join arootah_triage.categories c  on c.slug = r.category
left join arootah_triage.priorities p  on p.slug = r.priority
left join arootah_triage.contacts   ct on ct.id = m.contact_id
left join arootah_triage.contacts   ref on ref.id = ct.referred_by_contact_id;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- The deployed front end holds only the publishable (anon) key, so anon gets
-- read-only access and nothing else. All writes go through the service-role key,
-- which stays on a developer machine and is never shipped to the browser or to
-- the hosting platform.

alter table arootah_triage.categories enable row level security;
alter table arootah_triage.priorities enable row level security;
alter table arootah_triage.contacts   enable row level security;
alter table arootah_triage.messages   enable row level security;
alter table arootah_triage.results    enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'arootah_triage' and tablename = 'categories' and policyname = 'anon_read_categories') then
    create policy anon_read_categories on arootah_triage.categories for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'arootah_triage' and tablename = 'priorities' and policyname = 'anon_read_priorities') then
    create policy anon_read_priorities on arootah_triage.priorities for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'arootah_triage' and tablename = 'contacts' and policyname = 'anon_read_contacts') then
    create policy anon_read_contacts on arootah_triage.contacts for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'arootah_triage' and tablename = 'messages' and policyname = 'anon_read_messages') then
    create policy anon_read_messages on arootah_triage.messages for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'arootah_triage' and tablename = 'results' and policyname = 'anon_read_results') then
    create policy anon_read_results on arootah_triage.results for select to anon, authenticated using (true);
  end if;
end $$;

-- Expose the schema to the Supabase REST API and let anon read the view.
grant usage on schema arootah_triage to anon, authenticated;
grant select on all tables in schema arootah_triage to anon, authenticated;
alter default privileges in schema arootah_triage grant select on tables to anon, authenticated;
