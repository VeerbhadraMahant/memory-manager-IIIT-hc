# PRD — Negotiated AI Memory

Companion docs: `SYSTEM_DESIGN.md` (how), `PHASES.md` (build order), `DECISION_LOG.md` (why),
`RESEARCH.md` (your survey findings — replace the placeholder assumptions below with real data).

---

## 1. Problem

AI assistants accumulate memory about users silently. The user cannot see what is held, cannot
correct it, and cannot say "use this now but do not keep it." Existing controls are settings pages —
inspection after the fact, with no say at the moment memory forms.

Three harms follow, in increasing severity:

1. **Opacity.** The user cannot predict what the system will bring up, so cannot calibrate what to say.
2. **Staleness.** Memory records a moment as if it were permanent. "Working on a paper" silently
   becomes "wrote a paper." *(Originating incident — see D4 in the decision log.)*
3. **Loss of contextual control.** A fact shared in one context resurfaces in another where it does
   not belong. Personal disclosure appearing in professional output.

## 2. Users

Replace these with your survey segments — this is placeholder reasoning, not findings.

**Primary — the heavy personal user.** Uses an assistant across work and personal life. Benefits most
from memory, exposed most by it. Wants continuity without surveillance.

**Secondary — the cautious professional.** Uses AI for work output. Cares less about privacy than about
*accuracy in artifacts*. The CV case is their nightmare, not their annoyance.

**Underserved cases the design must not fail** (these are inclusivity commitments, not edge cases):
- **Shared-device users** — one account, several people. Common in multigenerational and lower-income
  households. Memory silently attributes one person's disclosures to another.
- **People who have changed** — memory encodes "smoker," "grieving," "job hunting," a former name, a
  former gender. Faithful memory becomes a refusal to let someone move on. Rectification is the
  ethical core here, not a feature.
- **Third parties** — the user discloses a partner's diagnosis. The system now holds a fact about
  someone who never consented and cannot inspect or delete it.
- **Users at risk of disclosure** — anyone harmed if memory contents were seen by an abusive partner or
  unaccepting family. Requires a fast, findable purge path, not a buried setting.

## 3. Product principles

1. Memory formation is visible *when it happens*, not auditable afterward.
2. Control without fatigue — most items pass silently; attention is spent only where it matters.
3. When uncertain, restrict. Over-restricting annoys; over-sharing violates.
4. Interventions state consequences, never scold.
5. Nothing is remembered that cannot be traced to something the user said.
6. Every capability is reachable without a mouse and without sight.

## 4. User stories

**Seeing**
- As a user, I can see what the system just decided to remember, in the conversation, without
  navigating away.
- I can tell at a glance whether something was *said by me* or *inferred about me*.
- When a response draws on memory, I can see which memories shaped it.

**Deciding**
- I can reject a memory before it persists.
- I can correct a memory's content or its classification in one action, where it appears.
- I can say "use this for now, do not keep it" and trust that it is enforced, not merely hidden.
- I can delete a memory and understand what else that affects before I confirm.

**Being protected**
- I am told when I am about to send something irreversible (a credential, a card number) before it
  leaves my device.
- I am not warned repeatedly about the same thing I already dismissed.
- When the system generates a high-stakes artifact from memory, it asks me to confirm the claims
  rather than asserting them.
- When something the system knows has gone stale, it asks rather than assumes.

## 5. Scope

**In scope:** the negotiation loop (surface, decide, scope), classification with visible correction,
provenance and cascade-aware deletion, use-time attribution, stake-proportional verification,
pre-send PII intervention, accessible primary interface.

**Explicitly out of scope, and why:**
- Multi-user identity resolution on shared devices — named as a limitation, not solved. Raising it
  honestly is stronger than a token implementation.
- Full third-party memory rights — surfaced and flagged, not resolved. There is no good answer in
  a hackathon window and pretending otherwise is worse than naming the gap.
- Production-grade PII detection. Regex + checksums. Stated as MVP-grade.
- Automatic re-derivation of summaries after cascade delete — tombstone plus flag-for-review instead.

## 6. Success criteria

**Demo must show, live:**
- A memory forming, being edited, and being rejected — all inside the conversation.
- Session-only scoping proven, not asserted: new session, the fact is gone, and it never entered the store.
- A response's memory attribution revoked, and the answer regenerated without it.
- The CV case reproduced: the system refuses to render an in-progress item as completed.

**Evidence to present:**
- Survey findings, including where participants were confused or wrong. Failures score better than
  successes.
- Decision log with rejected alternatives.
- Screen reader walkthrough of the core flow.

**Anti-goals:** a memory dashboard as the headline artifact; a graph view that impresses and does
nothing; a consent prompt on every extracted fact.
