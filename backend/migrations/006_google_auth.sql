-- 006_google_auth.sql — real users via Google sign-in.
--
-- 002_seed_demo.sql created one fixed user for the hackathon, with `handle` as its
-- only identifying field. Google sign-in needs somewhere to hang the OAuth subject
-- and the profile fields Google actually returns. `handle` stays — it is still the
-- thing `blocks`/`chats`/etc. join against via `user_id`, unchanged — this just adds
-- what a Google-authenticated account needs on top of it.
--
-- google_sub is the stable, never-reused identifier Google issues per account
-- (their docs explicitly say do not key on email — it can change hands). email is
-- kept too, for display and because it is unique enough to be a second real-world
-- handle, but the FK-equivalent lookup on sign-in is always by google_sub.

alter table users
  add column email      text,
  add column google_sub text,
  add column name       text,
  add column avatar_url text;

create unique index users_google_sub_key on users (google_sub) where google_sub is not null;
create unique index users_email_key on users (email) where email is not null;
