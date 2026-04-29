-- Forge Leads — Temperature System Schema Update
-- Run this in Supabase SQL Editor
-- Safe to run on existing database — uses ALTER TABLE not DROP

-- ─── ADD TEMPERATURE TO LEADS ────────────────────────────────────────────────

-- Add temperature column (cold / warm / hot / vip)
alter table leads
  add column if not exists temperature text
  default 'cold'
  check (temperature in ('cold','warm','hot','vip'));

-- Add temperature tracking timestamps
alter table leads
  add column if not exists became_warm_at  timestamptz;

alter table leads
  add column if not exists became_hot_at   timestamptz;

alter table leads
  add column if not exists became_vip_at   timestamptz;

-- Add offer and revenue tracking per lead
alter table leads
  add column if not exists opted_in_offer  text;    -- which offer they opted into

alter table leads
  add column if not exists bought_offer    text;    -- which offer they bought

alter table leads
  add column if not exists total_revenue   numeric(10,2) default 0;

alter table leads
  add column if not exists last_click_at   timestamptz;

alter table leads
  add column if not exists click_count     int default 0;

-- ─── CONVERSIONS TABLE ───────────────────────────────────────────────────────
-- Tracks every purchase event per lead
create table if not exists lead_conversions (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references auth.users(id) on delete cascade,
  lead_id       uuid references leads(id) on delete cascade,
  email         text not null,
  offer_name    text,
  offer_url     text,
  network       text,               -- clickbank / digistore / jvzoo / etc
  revenue       numeric(10,2) default 0,
  postback_data jsonb,              -- raw postback payload from network
  converted_at  timestamptz default now()
);

-- ─── OPT-INS TABLE ───────────────────────────────────────────────────────────
-- Tracks every opt-in event
create table if not exists lead_optins (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid references auth.users(id) on delete cascade,
  lead_id       uuid references leads(id),
  email         text not null,
  first_name    text,
  offer_name    text,
  page_url      text,
  ip_hash       text,
  opted_in_at   timestamptz default now()
);

-- ─── INDEXES ─────────────────────────────────────────────────────────────────
create index if not exists leads_temp_idx      on leads(temperature);
create index if not exists leads_warm_at_idx   on leads(became_warm_at);
create index if not exists leads_hot_at_idx    on leads(became_hot_at);
create index if not exists optins_email_idx    on lead_optins(email);
create index if not exists optins_user_idx     on lead_optins(user_id);
create index if not exists convs_email_idx     on lead_conversions(email);
create index if not exists convs_user_idx      on lead_conversions(user_id);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table lead_optins      enable row level security;
alter table lead_conversions enable row level security;

create policy if not exists "own optins"
  on lead_optins for all
  using (auth.uid() = user_id);

create policy if not exists "own conversions"
  on lead_conversions for all
  using (auth.uid() = user_id);

-- ─── TEMPERATURE STATS VIEW ──────────────────────────────────────────────────
create or replace view temperature_stats as
select
  user_id,
  pool,
  count(*) filter (where temperature = 'cold') as cold,
  count(*) filter (where temperature = 'warm') as warm,
  count(*) filter (where temperature = 'hot')  as hot,
  count(*) filter (where temperature = 'vip')  as vip,
  sum(total_revenue)                            as total_revenue,
  count(*)                                      as total
from leads
group by user_id, pool;

-- ─── RPC: upgrade temperature ─────────────────────────────────────────────────
create or replace function upgrade_lead_temperature(
  p_email       text,
  p_user_id     uuid,
  p_temperature text,
  p_offer       text default null,
  p_revenue     numeric default 0
)
returns jsonb language plpgsql as $$
declare
  lead_record leads%rowtype;
  now_ts timestamptz := now();
begin
  -- Find lead by email
  select * into lead_record
  from leads
  where email = lower(p_email)
    and user_id = p_user_id
  limit 1;

  if not found then
    return jsonb_build_object('found', false, 'email', p_email);
  end if;

  -- Update based on new temperature
  if p_temperature = 'warm' then
    update leads set
      temperature     = 'warm',
      became_warm_at  = coalesce(became_warm_at, now_ts),
      opted_in_offer  = coalesce(p_offer, opted_in_offer),
      status          = 'active'
    where id = lead_record.id;

  elsif p_temperature = 'hot' then
    update leads set
      temperature     = 'hot',
      became_warm_at  = coalesce(became_warm_at, now_ts),
      became_hot_at   = coalesce(became_hot_at, now_ts),
      bought_offer    = coalesce(p_offer, bought_offer),
      total_revenue   = total_revenue + coalesce(p_revenue, 0),
      status          = 'active'
    where id = lead_record.id;

  elsif p_temperature = 'vip' then
    update leads set
      temperature     = 'vip',
      became_vip_at   = coalesce(became_vip_at, now_ts),
      total_revenue   = total_revenue + coalesce(p_revenue, 0),
      status          = 'active'
    where id = lead_record.id;
  end if;

  return jsonb_build_object(
    'found',      true,
    'lead_id',    lead_record.id,
    'email',      lead_record.email,
    'old_temp',   lead_record.temperature,
    'new_temp',   p_temperature,
    'upgraded',   lead_record.temperature != p_temperature
  );
end;
$$;
