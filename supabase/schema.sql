-- ─────────────────────────────────────────────────────────────────────────
-- Nawilis SPK — Supabase (Postgres) schema.
-- Run this once in the Supabase SQL Editor (Dashboard → SQL → New query).
--
-- Design: JSONB-hybrid. The full SpkDoc lives in `doc jsonb` (so all the
-- shared domain logic is reused unchanged), with a few columns promoted out of
-- it for indexing, filtering, and the compare-and-swap state transition.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists spk (
  id            text primary key,
  upload_id     text unique,
  branch_code   text not null,
  state         text not null,
  nomor_antrian text,
  plate         text,                    -- vehicle.noPolisi.full (search)
  business_date date,
  used          boolean not null default false,  -- true once given to a mechanic
  doc           jsonb not null,          -- the complete SpkDoc
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists ix_spk_state        on spk (state);
create index if not exists ix_spk_branch_day    on spk (branch_code, business_date);
create index if not exists ix_spk_plate         on spk (plate);
create index if not exists ix_spk_used          on spk (used);
-- Turboly doc numbers must be unique once assigned (guards double-push).
create unique index if not exists uq_spk_so_no
  on spk ((doc #>> '{turboly,serviceOrderNo}'))
  where (doc #>> '{turboly,serviceOrderNo}') is not null;

create table if not exists spk_events (
  id      text primary key,
  spk_id  text not null,
  at      timestamptz not null default now(),
  type    text not null,
  by      text,
  data    jsonb
);
create index if not exists ix_events_spk on spk_events (spk_id, at);

create table if not exists vehicles (
  id             text primary key,       -- vehicleRef, e.g. veh_B1234XY
  plate_full     text unique not null,
  plate_variants text[] not null default '{}',
  doc            jsonb not null
);
create index if not exists ix_veh_variants on vehicles using gin (plate_variants);

create table if not exists tb_stores (
  branch_code text primary key,
  doc         jsonb not null
);
create table if not exists tb_service_products (
  sku        text primary key,
  store_code text,
  doc        jsonb not null
);
create table if not exists tb_mechanics (
  code       text primary key,
  store_code text,
  doc        jsonb not null
);
create table if not exists service_sku_map (
  id           text primary key,          -- `${branch|*}:${serviceCode}`
  service_code text not null,
  branch_code  text,
  sku          text not null,
  confirmed    boolean not null default false
);
create table if not exists turboly_docs (
  id                text primary key,      -- `${spkId}#${phase}`
  spk_id            text not null,
  phase             text not null,
  correlation_token text not null,
  committed_at      timestamptz,
  turboly_doc_no    text,
  unique (correlation_token, phase)
);
create table if not exists degradation_state (
  id  text primary key,
  doc jsonb not null
);

-- NOTE: with the service-role key (server-side only) RLS is bypassed. If you
-- later expose the anon key to browsers, enable RLS + policies on these tables.
