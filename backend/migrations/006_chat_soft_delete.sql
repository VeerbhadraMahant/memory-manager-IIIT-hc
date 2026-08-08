-- 006_chat_soft_delete.sql — make a chat deletable without destroying provenance.
--
-- Why a chat cannot simply be DELETEd, which is the whole reason this column exists.
-- The foreign keys around `chats` in 001_init.sql are:
--
--   messages.chat_id              -> chats     on delete CASCADE
--   memory_items.source_message_id-> messages  on delete RESTRICT
--   memory_items.session_chat_id  -> chats     on delete CASCADE
--
-- So `delete from chats where id = ...` has two possible outcomes, both wrong:
--
--   1. The cascade tries to remove the chat's messages, and RESTRICT refuses because
--      a surviving memory item still cites one as its source_message_id. The delete
--      fails with a raw foreign-key error. This is the common case — any chat that
--      produced a memory the user kept.
--   2. If every memory from that chat happened to be session-scoped, the
--      session_chat_id cascade *hard-deletes those memory items*, with no tombstone
--      and no audit row. That silently contradicts "deleted memories are tombstoned,
--      not erased", which the deletion dialog says in those words.
--
-- That RESTRICT is not an obstacle to work around — it is principle 7 ("no orphaned
-- facts") enforced in the schema. A memory must always be able to point at the
-- message it came from. So deletion is a tombstone here, exactly as it already is for
-- memory items, and the message rows stay so evidence quotes keep resolving.
--
-- What the DELETE /chats/{id} handler does with this column is in routers/chats.py:
-- tombstone the chat, tombstone its session-scoped memories (they were confined to a
-- chat that no longer exists), and leave persistent ones alone (the user explicitly
-- promoted those to outlive the chat, and overriding that would be the app deciding
-- something the user already decided).

alter table chats add column if not exists deleted_at timestamptz;

-- The sidebar's only query. Partial so it stays small as tombstoned chats accumulate.
create index if not exists chats_live_idx
  on chats (user_id, created_at desc)
  where deleted_at is null;
