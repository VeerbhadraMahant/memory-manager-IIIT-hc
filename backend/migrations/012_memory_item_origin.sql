-- 012_memory_item_origin.sql — who worded a memory, and a less identifying version.
--
-- content_origin. source_type records who *asserted* a fact (the user or the model). It
-- does not record who *worded* it: extracted content is always model-phrased, and an
-- edited inference stays `inferred`. People misattribute the source of text produced
-- with AI (Zindulka et al., CHI '26), and a memory store mixes both kinds of wording.
--   model_worded  written by the extractor
--   user_edited   the user changed the extractor's wording
--   user_written  the user wrote it from scratch
-- Nullable: existing rows cannot be classified after the fact, so they stay unknown and
-- the UI shows no label rather than a wrong one.
--
-- abstracted. For a fact about someone else, the same fact with names and identifying
-- detail removed, produced in the same single extraction call. The review card offers it
-- as an alternative to keeping the specific wording. Null when the extractor offered
-- none.

create type content_origin as enum ('model_worded', 'user_edited', 'user_written');

alter table memory_items
  add column if not exists content_origin content_origin,
  add column if not exists abstracted     text;
