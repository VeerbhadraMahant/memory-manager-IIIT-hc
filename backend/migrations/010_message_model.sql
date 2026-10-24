-- 010_message_model.sql — record which model wrote each assistant message.
--
-- The turn response already reports the provider/model that actually ran (D32), but
-- nothing persisted it, so a reloaded chat could not say who answered. Measured
-- attribution needs it for a harder reason: an influence score compares a reply with
-- regenerations *without* one memory, and that comparison is only meaningful on the
-- same model. Re-running on whatever the selector says today would measure the model
-- change, not the memory.
--
-- Nullable: user messages have no model, and rows written before this migration are
-- honestly unknown rather than backfilled with a guess.

alter table messages
  add column if not exists provider text,
  add column if not exists model    text;
