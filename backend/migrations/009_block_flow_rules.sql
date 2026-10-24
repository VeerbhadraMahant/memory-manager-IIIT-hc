-- 009_block_flow_rules.sql — a block may be usable in one place and not another.
--
-- 007 made privacy binary: a private block reaches no prompt at all. That cannot express
-- the case PRD §1 harm 3 is about — a health disclosure that is fine in a supportive chat
-- and a violation in a CV. Contextual integrity (Nissenbaum, 2004) frames privacy as
-- appropriate *flows* between contexts, so this records, per block, which destinations
-- its memories must never flow to.
--
-- Destinations are the four places retrieval feeds a model:
--   chat       an ordinary turn
--   draft      the verified high-stakes draft (the CV case)
--   summary    a node summary in the graph view
--   relevance  the relevance highlight for a prompt being typed
--
-- A deny-list, not an allow-list, so a destination added later is open by default and
-- an existing block does not silently go dark. `private` (007) still wins over this:
-- a private block reaches no destination whatever this column says.
--
-- Enforced in services/retrieval.py's SQL, like 007, so a UI bug cannot drop it.

create type flow_destination as enum ('chat', 'draft', 'summary', 'relevance');

alter table blocks
  add column if not exists denied_destinations flow_destination[] not null default '{}';

-- Principle 1 (asymmetric error costs): the four most sensitive personal blocks are
-- withheld from high-stakes drafts by default. Chat is untouched, so the assistant
-- stays as useful as before in conversation; the user can lift any of these per block.
-- Applied to every existing user, matching DEFAULT_BLOCKS in services/users.py.
update blocks
   set denied_destinations = array['draft']::flow_destination[]
 where name in ('health', 'identity', 'finance', 'relationships');
