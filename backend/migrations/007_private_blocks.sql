-- 007_private_blocks.sql — blocks the model never receives.
--
-- Scope already answers "which conversations may use this memory". This answers a
-- different question: "may the model see this at all". A private block's items stay
-- fully visible to the *user* in the list and the graph, keep working as memories
-- they can edit and delete, and are excluded from the retrieval SQL — so they are
-- never embedded into a prompt and never leave the database toward an LLM.
--
-- Enforced in `services/retrieval.py`'s WHERE clause, not in the UI, for the same
-- reason session scope is: a filter the frontend applies is a filter a frontend bug
-- can drop. The turn's retrieval trace reports the count it withheld, so "the model
-- did not get this" is a number on screen rather than a promise in a README.
--
-- Default false. Turning a block private is a decision with a cost — the assistant
-- gets less useful about that part of your life — so it is opt-in per block rather
-- than inferred from sensitivity. `health` is not made private here for exactly that
-- reason: the demo needs to *show* the toggle mattering, and a default that hides
-- the effect makes the feature invisible.

alter table blocks add column if not exists private boolean not null default false;
