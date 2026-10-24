-- 011_edge_state.sql — provenance edges can be proposed before they count.
--
-- Nothing has ever written memory_edges, so the cascade reader always found zero
-- dependents. The first writers are heuristic (an update/contradiction detector) and
-- the extractor (an inference's premises). A heuristic guess must not change what is
-- deleted or retrieved until the user agrees with it, so an edge now carries a state:
--
--   proposed   shown to the user; ignored by cascade and retrieval
--   confirmed  counts everywhere (the only state that existed before this migration)
--   rejected   kept, so the same pair is not proposed again — the existing
--              unique (from_item_id, to_item_id, relation) makes a re-insert a no-op
--
-- Default 'confirmed' keeps every existing writer (tests, seed scripts) meaning what it
-- meant before.
--
-- origin says who asserted the edge. Nullable: rows from before this migration have no
-- recorded origin, and labelling them would be a guess.
--
-- Direction is unchanged (SYSTEM_DESIGN §3): `from` is the source, `to` is derived from
-- it. For `updates`, `from` is the older fact and `to` the newer one, so a confirmed
-- `updates` edge supersedes its `from` end.

create type edge_state  as enum ('proposed', 'confirmed', 'rejected');
create type edge_origin as enum ('heuristic', 'extraction', 'user');

alter table memory_edges
  add column if not exists state  edge_state not null default 'confirmed',
  add column if not exists origin edge_origin;
