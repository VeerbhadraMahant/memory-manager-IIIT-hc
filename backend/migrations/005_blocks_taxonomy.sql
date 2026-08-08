-- 005_blocks_taxonomy.sql — widen the block taxonomy from five to nine.
--
-- Why a new migration rather than editing 002: 002 is already applied on every
-- existing database, and migrate.py runs each file exactly once. Editing 002 would
-- change only fresh installs and leave existing ones silently different.
--
-- Two of the requested names were synonyms of blocks that already existed, and are
-- handled as renames rather than additions:
--
--   "job"      is already `work`               -> no change
--   "school"   is narrower than `learning`     -> renamed to `education`
--   "relations" is broader than `family`       -> renamed to `relationships`
--
-- Synonym pairs are actively harmful here, not merely redundant. The extractor
-- classifies zero-shot against block *names*, so `work` alongside `job` would send
-- identical facts to different blocks from one run to the next, and "one home block
-- per item" stops meaning anything. One concept, one name.
--
-- Renaming rather than adding also re-labels existing items for free: memory_items
-- reference block_id, not the name, so the seeded wedding item moves from `family`
-- to `relationships` without touching a single row in memory_items.
--
-- Scope note: blocks are per-user, so every statement below is written to cover all
-- users rather than just the demo one. Seeding blocks for a *newly created* user is
-- a separate concern and does not exist yet — it belongs with the auth work.

-- Renames first, so the inserts below cannot collide with an old name.
update blocks set name = 'education'     where name = 'learning';
update blocks set name = 'relationships' where name = 'family';

-- The four genuinely new blocks, for every user that exists.
--
--   identity     — name, pronouns, languages, dates. Has its own block because
--                  "people who have changed" is an explicit inclusivity commitment
--                  in PRD.md §2: a former name or former gender needs somewhere to
--                  live that the user can find and delete, not scattered across
--                  unclassified.
--   finance      — income, subscriptions, purchases.
--   location     — home city, addresses, travel. Mirrors the client-side PII
--                  detector, which already treats an address as a category of its
--                  own, so the storage layer now has a matching home for it.
--   preferences  — food, tools, communication style. The least sensitive block, and
--                  the one that gives the interruption budget somewhere legitimate to
--                  auto-accept into: today only `work` is tier `low`, which makes
--                  silent auto-accept rarer than principle 2 intends.
insert into blocks (user_id, name)
select u.id, v.name
from users u
cross join (values ('identity'), ('finance'), ('location'), ('preferences')) as v(name)
on conflict (user_id, name) do nothing;

-- One authoritative pass over the whole taxonomy, so the intended end state is
-- readable in a single place rather than inferred from an insert plus a default.
--
-- restrictive_rank: lower = more restrictive (001_init.sql). It is also the display
-- order for the blocks list, so this reads most-sensitive-first in the UI.
--
-- Honesty note on default_sensitivity: it is currently *metadata only*. Nothing in
-- the pipeline reads it — `policy.decide()` takes the per-item sensitivity the
-- extractor classified (which classify.py may raise but never lower), and the
-- fallback block is found via `is_fallback`, not via rank. These values describe
-- intent and drive the API response; they do not by themselves make a block
-- session-scoped. Do not cite them as an enforcement mechanism.
update blocks set restrictive_rank =  0, default_sensitivity = 'high'             where name = 'unclassified';
update blocks set restrictive_rank = 10, default_sensitivity = 'special_category' where name = 'health';
update blocks set restrictive_rank = 20, default_sensitivity = 'high'             where name = 'identity';
update blocks set restrictive_rank = 30, default_sensitivity = 'high'             where name = 'finance';
update blocks set restrictive_rank = 40, default_sensitivity = 'high'             where name = 'relationships';
update blocks set restrictive_rank = 50, default_sensitivity = 'high'             where name = 'location';
update blocks set restrictive_rank = 60, default_sensitivity = 'medium'           where name = 'education';
update blocks set restrictive_rank = 70, default_sensitivity = 'low'              where name = 'work';
update blocks set restrictive_rank = 80, default_sensitivity = 'low'              where name = 'preferences';
