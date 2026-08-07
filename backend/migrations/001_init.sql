-- 001_init.sql — Negotiated AI Memory, initial schema
--
-- Full schema per SYSTEM_DESIGN.md §3, baked in at P0. Carrying unused columns now
-- beats retrofitting fields later (PHASES.md P0).
--
-- The project vocabulary (CLAUDE.md "Core concepts") is enforced as Postgres enums
-- rather than text + CHECK, so a typo in a status string fails at write time.

create extension if not exists vector;


-- ---------------------------------------------------------------- vocabulary

-- user said it vs. model derived it. Inferred items default to review.
create type source_type as enum ('stated', 'inferred');

-- The field that prevents the "claimed a paper was finished when it wasn't" failure.
create type assertion_status as enum (
  'in_progress', 'completed', 'planned', 'abandoned', 'hypothetical', 'third_party'
);

create type sensitivity_tier as enum ('low', 'medium', 'high', 'special_category');

-- Session-scoped items are excluded at the extraction pass, not hidden in the UI.
create type memory_scope as enum ('session', 'persistent');

-- Drives cascade delete.
create type edge_relation as enum ('derived_from', 'summarized_from', 'contradicts', 'updates');

create type message_role as enum ('user', 'assistant', 'system');

-- Interruption budget (principle 2): auto_accepted never interrupted the user.
-- Distinguishing it from accepted keeps "what did the system decide on its own" auditable.
create type review_state as enum ('pending', 'accepted', 'auto_accepted', 'rejected');

create type audit_actor as enum ('user', 'system');


-- ---------------------------------------------------------------- core tables

create table users (
  id         uuid primary key default gen_random_uuid(),
  handle     text unique not null,
  created_at timestamptz not null default now()
);


create table blocks (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  name                text not null,
  default_sensitivity sensitivity_tier not null default 'medium',

  -- D3 (low confidence -> the *more* restrictive block) needs a total order over
  -- blocks, which a sensitivity tier alone does not give. Lower rank = more restrictive.
  restrictive_rank    int not null default 100,

  -- Where unclassified items land. Exactly one per user, enforced below.
  is_fallback         boolean not null default false,

  created_at          timestamptz not null default now(),

  unique (user_id, name)
);

create unique index one_fallback_block_per_user
  on blocks (user_id) where is_fallback;


create table chats (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  title      text,
  created_at timestamptz not null default now()
);


create table messages (
  id      uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  role    message_role not null,
  content text not null,

  -- P3: turns marked ephemeral are skipped by the extraction pass entirely.
  -- Nothing derived from them ever reaches memory_items.
  session_ephemeral boolean not null default false,

  created_at timestamptz not null default now()
);

create index messages_chat_created_idx on messages (chat_id, created_at);


create table memory_items (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,

  -- on delete restrict: a block cannot be dropped out from under its items.
  block_id uuid references blocks(id) on delete restrict,
  content  text not null,

  source_type source_type      not null,
  status      assertion_status not null,
  sensitivity sensitivity_tier not null,
  scope       memory_scope     not null default 'persistent',
  confidence  real             not null check (confidence >= 0 and confidence <= 1),

  -- Principle 7, no orphaned facts: every item traces to the message it came from.
  -- restrict, not cascade — losing the source silently would break the guarantee.
  source_message_id uuid not null references messages(id) on delete restrict,

  -- Session-scoped items are anchored to the chat that produced them so "session"
  -- has a concrete referent to enforce against. Null exactly when persistent.
  session_chat_id uuid references chats(id) on delete cascade,

  review_state review_state not null default 'pending',
  needs_review boolean      not null default false,

  -- 768 dims, truncated from the embedding model's native size. Fixed before migrations —
  -- changing this later forces a full re-embed (scripts/reembed.py, D31).
  embedding vector(768),

  created_at        timestamptz not null default now(),
  -- Decay (SYSTEM_DESIGN §1): in_progress items unconfirmed past a threshold
  -- trigger re-confirmation instead of silent reuse.
  last_confirmed_at timestamptz,

  -- Tombstone rather than hard delete, per the cascade policy (§3 step 3).
  -- Every read path must filter deleted_at is null.
  deleted_at timestamptz,

  constraint session_scope_needs_a_chat check (
    (scope = 'session'    and session_chat_id is not null) or
    (scope = 'persistent' and session_chat_id is null)
  )
);

create index memory_items_user_live_idx
  on memory_items (user_id) where deleted_at is null;
create index memory_items_block_idx  on memory_items (block_id);
create index memory_items_status_idx on memory_items (status);
create index memory_items_scope_idx  on memory_items (scope);
create index memory_items_source_msg_idx on memory_items (source_message_id);
create index memory_items_review_idx on memory_items (review_state)
  where review_state = 'pending';

-- HNSW over ivfflat: no training step and no list-count tuning, which matters
-- when the table starts empty and grows during a live demo.
create index memory_items_embedding_idx
  on memory_items using hnsw (embedding vector_cosine_ops);


create table memory_edges (
  id           uuid primary key default gen_random_uuid(),
  from_item_id uuid not null references memory_items(id) on delete cascade,
  to_item_id   uuid not null references memory_items(id) on delete cascade,
  relation     edge_relation not null,
  created_at   timestamptz not null default now(),

  constraint no_self_edges check (from_item_id <> to_item_id),
  unique (from_item_id, to_item_id, relation)
);

create index memory_edges_from_idx on memory_edges (from_item_id);
create index memory_edges_to_idx   on memory_edges (to_item_id);


-- Use-time attribution: which memory items shaped which response.
create table attributions (
  id             uuid primary key default gen_random_uuid(),
  message_id     uuid not null references messages(id) on delete cascade,
  memory_item_id uuid not null references memory_items(id) on delete cascade,
  created_at     timestamptz not null default now(),

  unique (message_id, memory_item_id)
);

create index attributions_message_idx on attributions (message_id);
create index attributions_item_idx    on attributions (memory_item_id);


-- Append-only. Survives the tombstone: no FK to memory_items, so purging a
-- tombstoned row on schedule does not erase the record that it existed.
create table audit_log (
  id             uuid primary key default gen_random_uuid(),
  memory_item_id uuid not null,
  action         text not null,
  actor          audit_actor not null,
  detail         jsonb,
  created_at     timestamptz not null default now()
);

create index audit_log_item_idx on audit_log (memory_item_id, created_at);
