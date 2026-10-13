-- 008_subnodes_and_rls.sql — child notes on a memory, and lock the tables down.
--
-- 1. memory_subnodes: the "Add Child" nodes of the interactive memory graph. These were
--    served from a process-local dict (SUBNODES_STORE) that vanished on every restart
--    and was shared by all users; they are real rows now.
--
-- 2. Row-level security on every table in `public`.
--    On Supabase, every table in `public` is automatically exposed over PostgREST to
--    anyone holding the project's anon key — and the anon key ships in browser code.
--    This backend never uses PostgREST: it connects as the table owner over a direct
--    Postgres connection, and the owner bypasses RLS. So enabling RLS with *no*
--    policies is the exact right shape: the app is unaffected and the auto-generated
--    REST API sees zero rows and can write none. Without this, activating Supabase
--    would publish the whole memory store, including health and finance blocks.

create table if not exists memory_subnodes (
  id             uuid primary key default gen_random_uuid(),
  memory_item_id uuid not null references memory_items(id) on delete cascade,
  -- Denormalised so ownership is one equality check, not a join, on every write.
  user_id        uuid not null references users(id) on delete cascade,
  content        text not null,
  confidence     real not null default 0.9 check (confidence >= 0 and confidence <= 1),
  category       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists memory_subnodes_item_idx on memory_subnodes (memory_item_id, created_at);
create index if not exists memory_subnodes_user_idx on memory_subnodes (user_id);

-- Exact-search path in retrieval filters on these together.
create index if not exists memory_items_user_scope_idx
  on memory_items (user_id, scope) where deleted_at is null;

-- Account deletion and transcript reads walk these.
create index if not exists chats_user_idx on chats (user_id);

do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;

  -- Supabase's API roles. Absent on plain Postgres, hence the guard.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
    alter default privileges in schema public revoke all on tables from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
    alter default privileges in schema public revoke all on tables from authenticated;
  end if;
end $$;
