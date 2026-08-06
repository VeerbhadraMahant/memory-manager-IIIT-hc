-- 004 — why is this item in front of me?
--
-- The policy already computes this when it decides between auto-accept and review;
-- it was only being written to audit_log.detail, which the UI has no business
-- parsing. A review card that cannot answer "why am I being asked about this" is
-- the thing that turns consent into reflex clicking (principle 2), so the reason
-- belongs on the item itself.

alter table memory_items add column review_reason text;
