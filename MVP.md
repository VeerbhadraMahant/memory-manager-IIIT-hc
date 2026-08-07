# MVP

The honest question this doc answers: **if you get four phases done instead of nine, is what you have
still a coherent submission?** Yes — but only if they are the right four.

Assumption, since team size and timeline are still unstated: small team, short clock. Adjust upward if
you have more people than I think.

---

## The MVP is P0 + P1 + P3 + P6

Nothing else. Everything in `PHASES.md` beyond these four is upside.

| Phase | Why it is non-negotiable |
|---|---|
| **P0** Schema | Full schema now. Retrofitting `status` or `scope` later is worse than unused columns. |
| **P1** Candidate surfacing | This *is* the problem statement. Without it you built a settings page. |
| **P3** Session scoping | The only claim in the project that can be *proven* live rather than asserted. |
| **P6** Attribution + verification | Your differentiator. Contains the CV case, which is the strongest thing you have. |

**Minimal classification inside the MVP:** P2 is a full phase, but P6 cannot function without
`assertion status`. So the MVP carries a *reduced* classification pass — status only, plus a coarse
sensitivity flag. Domain/block classification can be manual or absent in the MVP. Do not skip status.

**Minimal memory view inside the MVP:** P4 is a full phase, but you need *somewhere* to see the list.
The MVP version is a plain filterable list — no bulk actions, no graph. Keyboard-navigable from the
start; retrofitting keyboard access is more work than building it in.

---

## Cut order, when time runs out

Cut from the bottom. Do not cut out of order — each of these is cheaper to lose than the one above it.

1. **P8 accessibility pass** → cut the *polish*, not the basics. Semantic HTML, labels, focus order and
   keyboard nav stay in from the beginning. A full WCAG audit and screen reader test is the cuttable part.
   Then say honestly: "we built to these principles, we did not have time to audit."
2. **P5 graph** → cut entirely. Show deletion consequences as a text list. Loses visual appeal, loses
   nothing functional. The graph was always scoped narrowly for exactly this reason.
3. **P7 PII pre-send** → reduce to card numbers + credential-like patterns only. Two regexes and Luhn.
   Do not cut it to zero; it is your cross-PS bridge and it is cheap.
4. **P4 list completeness** → reduce to filter-only, no bulk actions.
5. **P2 classification** → reduce to status + sensitivity, drop domain/block auto-routing, let users
   assign blocks manually. Say that auto-classification is designed and specified but unimplemented.

If you are cutting past item 5, you are cutting into the MVP and the submission stops making sense.
At that point drop scope elsewhere — fewer memory blocks, fewer sensitivity tiers, a seeded demo
account instead of real auth.

---

## Demo script — build toward this, in this order

Roughly four minutes. Each beat maps to a phase, so a cut phase costs you exactly one beat.

1. **The silent baseline.** One turn in a normal assistant. "It just learned four things about you.
   You cannot see them, and you cannot say no." *(sets the problem — no build needed)*
2. **Negotiation.** Same turn in yours. Candidate card appears inline. Reject one, edit one, accept one.
   Show stated vs. inferred as a visible distinction. *(P1)*
3. **Session-only, proven.** Share something sensitive, mark it session-only. New session. Ask about
   it — gone. Then show the store: it never persisted. **Show the database, not just the UI.**
   This is the beat that separates you from teams who built a checkbox. *(P3)*
4. **The CV case.** Ask for a CV. Memory holds "paper — in progress." System surfaces the claim for
   confirmation instead of writing "published." Say the real story in one line: this happened to
   someone on our team and they were caught in an interview. *(P6)*
5. **Attribution and revoke.** Point at a response, show which memories shaped it, revoke one,
   regenerate. "Here is what it would have said without that." *(P6)*
6. **Close on limits.** Name what you did not solve — shared devices, third-party memory,
   re-derivation on cascade delete. Thirty seconds. Judges trust teams who volunteer their gaps far
   more than teams who are found out during Q&A.

Rehearse beat 3 and beat 4 until they cannot fail. They are the two moments nobody else will have.

---

## Pre-demo checklist

- [ ] LLM safety behaviour tested against the *actual* demo content (fake diagnosis, fake address,
      fake card number). A blocked response on stage is unrecoverable.
- [ ] Rate limits: demo path cached or backoff verified. Rapid turns on free tier will 429.
- [ ] Seeded demo account with pre-existing memories, including one stale in-progress item.
- [ ] Embedding dimension fixed in pgvector before any data exists.
- [ ] Beat 3 runnable as a scripted check, not clicked live.
- [ ] Every citation in `DECISION_LOG.md` verified against the real paper.
- [ ] `PHASES.md` "stubbed / not done" section current and honest.
- [ ] Offline fallback: recorded video of beats 3 and 4 in case the venue network dies.
