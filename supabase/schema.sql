-- Forge Mail — Lead Manager Schema
-- Run this in Supabase SQL Editor

create extension if not exists "uuid-ossp";

-- ─── LEAD POOLS ──────────────────────────────────────────────────────────────
-- Two pools: mlgs (organise only) and own (full control)

drop table if exists lead_tags cascade;
drop table if exists leads cascade;
drop table if exists lead_batches cascade;

-- Batches — each upload is a named batch
create table lead_batches (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade,
  name        text not null,                    -- e.g. "Batch 1 — Jan 2025"
  pool        text not null check (pool in ('mlgs','own')),
  lead_count  int default 0,
  tags        text[] default '{}',
  niche       text,
  notes       text,
  created_at  timestamptz default now()
);

-- Leads table
create table leads (
  id          uuid primary key default uuid_generate_v4(),
  user_id     uuid references auth.users(id) on delete cascade,
  batch_id    uuid references lead_batches(id) on delete cascade,
  pool        text not null check (pool in ('mlgs','own')),

  -- Core fields
  email       text not null,
  first_name  text,
  last_name   text,
  phone       text,
  postcode    text,
  state       text,
  country     text,

  -- Organisation
  tags        text[] default '{}',
  notes       text,
  status      text default 'active' check (status in ('active','unsubscribed','bounced','removed')),

  created_at  timestamptz default now()
);

-- Indexes for fast filtering
create index leads_user_idx    on leads(user_id);
create index leads_pool_idx    on leads(pool);
create index leads_batch_idx   on leads(batch_id);
create index leads_email_idx   on leads(email);
create index leads_state_idx   on leads(state);
create index leads_country_idx on leads(country);
create index leads_status_idx  on leads(status);

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
alter table lead_batches enable row level security;
alter table leads         enable row level security;

create policy "own batches"
  on lead_batches for all
  using (auth.uid() = user_id);

create policy "own leads"
  on leads for all
  using (auth.uid() = user_id);

-- ─── STATS VIEW ──────────────────────────────────────────────────────────────
create or replace view lead_stats as
select
  user_id,
  pool,
  count(*) filter (where status = 'active')       as active,
  count(*) filter (where status = 'unsubscribed')  as unsubscribed,
  count(*) filter (where status = 'bounced')       as bounced,
  count(*)                                          as total
from leads
group by user_id, pool;

-- ─── RPC: bulk insert leads ──────────────────────────────────────────────────
-- Called from the import function with an array of leads
create or replace function bulk_insert_leads(p_leads jsonb)
returns int language plpgsql as $$
declare
  inserted int := 0;
  lead jsonb;
begin
  for lead in select * from jsonb_array_elements(p_leads)
  loop
    insert into leads (
      user_id, batch_id, pool,
      email, first_name, last_name, phone,
      postcode, state, country, tags
    ) values (
      (lead->>'user_id')::uuid,
      (lead->>'batch_id')::uuid,
      lead->>'pool',
      lead->>'email',
      lead->>'first_name',
      lead->>'last_name',
      lead->>'phone',
      lead->>'postcode',
      lead->>'state',
      lead->>'country',
      array(select jsonb_array_elements_text(lead->'tags'))
    )
    on conflict do nothing;
    inserted := inserted + 1;
  end loop;
  return inserted;
end;
$$;
-- Forge Leads — Duplicate Detection Schema
-- Run this in Supabase SQL Editor

-- ─── DUPLICATES TABLE ─────────────────────────────────────────────────────────
create table if not exists lead_duplicates (
  id           uuid primary key default uuid_generate_v4(),
  user_id      uuid references auth.users(id) on delete cascade,
  email        text not null,
  first_name   text,
  last_name    text,
  phone        text,
  postcode     text,
  state        text,
  country      text,
  source_file  text,    -- which batch/file it came from
  detected_at  timestamptz default now(),
  reviewed     boolean default false,
  action       text      -- 'deleted' | 'kept' | null (pending)
);

-- Indexes
create index if not exists dupes_user_idx  on lead_duplicates(user_id);
create index if not exists dupes_email_idx on lead_duplicates(email);
create index if not exists dupes_reviewed  on lead_duplicates(reviewed);

-- RLS
alter table lead_duplicates enable row level security;

create policy if not exists "own duplicates"
  on lead_duplicates for all
  using (auth.uid() = user_id);

-- ─── RPC: get duplicate stats ─────────────────────────────────────────────────
create or replace function get_duplicate_stats(p_user_id uuid)
returns jsonb language plpgsql as $$
declare
  total_dupes int;
  reviewed    int;
  pending     int;
begin
  select count(*) into total_dupes
  from lead_duplicates
  where user_id = p_user_id;

  select count(*) into reviewed
  from lead_duplicates
  where user_id = p_user_id and reviewed = true;

  pending := total_dupes - reviewed;

  return jsonb_build_object(
    'total',    total_dupes,
    'reviewed', reviewed,
    'pending',  pending
  );
end;
$$;

-- ─── RPC: bulk delete all duplicates ─────────────────────────────────────────
create or replace function delete_all_duplicates(p_user_id uuid)
returns int language plpgsql as $$
declare
  deleted_count int;
begin
  delete from lead_duplicates
  where user_id = p_user_id;

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
