-- 002_seed_demo.sql — demo user and the four blocks from CLAUDE.md.
--
-- Fixed UUIDs so the frontend can hardcode the demo user during the hackathon
-- instead of carrying an auth flow nobody is judging.
--
-- restrictive_rank: lower = more restrictive. Low-confidence classification routes
-- to the lowest-ranked plausible block (D3), so this order is load-bearing, not cosmetic.

insert into users (id, handle) values
  ('00000000-0000-0000-0000-000000000001', 'demo');

insert into blocks (user_id, name, default_sensitivity, restrictive_rank, is_fallback) values
  ('00000000-0000-0000-0000-000000000001', 'health',   'special_category', 10, false),
  ('00000000-0000-0000-0000-000000000001', 'family',   'high',             20, false),
  ('00000000-0000-0000-0000-000000000001', 'learning', 'medium',           30, false),
  ('00000000-0000-0000-0000-000000000001', 'work',     'low',              40, false),
  -- Unclassified is the most restrictive place an item can land, not the least:
  -- an item we could not classify must not default into a shareable block.
  ('00000000-0000-0000-0000-000000000001', 'unclassified', 'high',          0, true);
