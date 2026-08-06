-- 003 — track the async extraction pass per message.
--
-- Extraction runs post-turn so it does not add ~9s to every chat response
-- (SYSTEM_DESIGN §5, sync vs. async). The UI needs to know whether candidates are
-- still coming, so the state lives on the message rather than in process memory —
-- a restart mid-demo would otherwise strand the indicator spinning forever.

create type extraction_status as enum ('skipped', 'pending', 'done', 'failed');

alter table messages
  add column extraction_status extraction_status not null default 'skipped',
  -- surfaced in the UI when a pass fails, rather than silently showing "no candidates"
  add column extraction_error text;

-- The evidence span the extractor pulled the item from. Principle 7 says every item
-- references a source message; this narrows that to the phrase inside it, so the
-- review card can show *why* something was extracted rather than asking the user to
-- trust it.
alter table memory_items
  add column evidence text;
