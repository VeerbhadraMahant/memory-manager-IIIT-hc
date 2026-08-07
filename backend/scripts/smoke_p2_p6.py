"""P2 (classification) + P6 (attribution and verification) acceptance.

    python backend/scripts/smoke_p2_p6.py            # full, ~4 model calls
    python backend/scripts/smoke_p2_p6.py --no-llm   # classifier truth tables, free

Reproduces the originating incident end to end: memory says a paper is in progress,
the system is asked for a CV line, and it refuses to render it as published.

The `--no-llm` half exercises the two classifiers directly, and exists because of
something the full run cannot do. Asked plainly to overstate, the model *declines* —
so the end-to-end check for "the guard fires" passes without the guard ever firing,
and reports as much. The detector is a pure rank comparison, so its whole truth
table can be walked without a model, including the row the model will not produce.
A guarantee whose test only passes when nothing goes wrong is not tested.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app.models import AssertionStatus as S  # noqa: E402
from app.models import Sensitivity as Sv  # noqa: E402
from app.services import classify  # noqa: E402

BASE = "http://127.0.0.1:8000"
c = httpx.Client(timeout=180)
failures: list[str] = []


def check(label: str, got, want) -> bool:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}  (got {got!r}, want {want!r})")
    if not ok:
        failures.append(label)
    return ok


def note(label: str, value) -> None:
    print(f"  ....  {label}: {value}")


def classifier_checks() -> None:
    """The two P2/P6 classifiers, walked directly. No model, no database, no quota."""

    print("\nP6 — the overstatement detector, whole truth table")
    # The row that matters is the first one: it is the CV incident in miniature, and
    # it is the row the end-to-end test cannot reach, because a model asked to
    # overstate declines.
    cases: list[tuple[str, S | None, list[S], bool]] = [
        ("completed claim over an in_progress memory", S.completed, [S.in_progress], True),
        ("completed claim over a planned memory", S.completed, [S.planned], True),
        ("in_progress claim over a planned memory", S.in_progress, [S.planned], True),
        ("completed claim over a completed memory", S.completed, [S.completed], False),
        ("in_progress claim over an in_progress memory", S.in_progress, [S.in_progress], False),
        ("planned claim over an in_progress memory", S.planned, [S.in_progress], False),
        # Principle 4: a sentence resting on facts at different stages is not an
        # overstatement, and flagging it would train the user to dismiss the warning.
        ("claim spanning in_progress and planned sources",
         S.in_progress, [S.planned, S.in_progress], False),
        ("no completeness claim at all", None, [S.planned], False),
        ("no sources to contradict", S.completed, [], False),
    ]
    for label, asserted, sources, want in cases:
        over, problem = classify.check_claim(asserted, sources)
        check(label, over, want)
        if over:
            note("  said", problem)

    print("\nP6 — staleness is reported, but never as an overstatement")
    over, problem = classify.check_claim(S.in_progress, [S.in_progress], stale=True)
    check("an accurate claim on a stale memory is not an overstatement", over, False)
    check("but it is still flagged", problem is not None, True)
    over, problem = classify.check_claim(S.completed, [S.in_progress], stale=True)
    check("an overstatement outranks the staleness note", over, True)
    check("and staleness does not dilute the message",
          "not been confirmed" in (problem or ""), False)

    print("\nP2 — sensitivity is raised, never lowered")
    raised, why = classify.raise_sensitivity(Sv.low, "I take 20mg escitalopram")
    check("medication over a 'low' call becomes special category",
          raised, Sv.special_category)
    check("and says why", why is not None, True)
    raised, _ = classify.raise_sensitivity(Sv.special_category, "I use a text editor")
    check("an unmarked text cannot lower the model's call", raised, Sv.special_category)
    raised, _ = classify.raise_sensitivity(Sv.medium, "my mortgage is up for renewal")
    check("financial wording raises medium to high", raised, Sv.high)
    raised, _ = classify.raise_sensitivity(Sv.high, "I moved house")
    check("no marker leaves the model's answer alone", raised, Sv.high)

    print("\nP2 — status disagreement forces review, without overruling the model")
    d = classify.status_disagreement(S.completed, "I'm still writing the CHI paper")
    check("'still writing' called completed is a disagreement", d is not None, True)
    note("  said", d)
    check("'still writing' called in_progress is not",
          classify.status_disagreement(S.in_progress, "I'm still writing the paper"), None)
    check("unmarked wording raises nothing",
          classify.status_disagreement(S.completed, "the paper is about memory"), None)
    # Only completeness *inflation* is worth an interruption. The model calling
    # something less finished than the wording suggests is the safe direction.
    check("a more cautious call than the wording is not flagged",
          classify.status_disagreement(S.planned, "I finished the paper"), None)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true",
                    help="classifier truth tables only; makes no model calls")
    args = ap.parse_args()

    if args.no_llm:
        classifier_checks()
        if failures:
            print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
            return 1
        print("\nP2 + P6 classifiers: all checks passed.")
        return 0

    classifier_checks()

    try:
        c.get(f"{BASE}/health")
    except httpx.ConnectError:
        print("Backend unreachable. Start it:\n"
              "  cd backend && ../.venv/Scripts/python -m uvicorn app.main:app --port 8000")
        return 1

    chat = c.post(f"{BASE}/chats", json={"title": "P2/P6 smoke"}).json()
    msg = c.post(f"{BASE}/chats/{chat['id']}/messages", json={
        "role": "user",
        "content": "I'm still writing the CHI paper with Priya, and I take 20mg "
                   "escitalopram for anxiety.",
    }).json()

    def seed(content, status, sensitivity="low", block="work"):
        r = c.post(f"{BASE}/memory/items", json={
            "content": content, "source_type": "stated", "status": status,
            "sensitivity": sensitivity, "scope": "persistent", "confidence": 0.95,
            "source_message_id": msg["id"], "block_name": block,
            "review_state": "accepted",
        })
        r.raise_for_status()
        return r.json()

    print("\nP2 — items created through the API are retrievable")
    paper = seed("Writing a conference paper with Priya on memory negotiation",
                 "in_progress")
    check("seeded item is embedded and live", paper["review_state"], "accepted")

    print("\nP2 — one-tap correction reclassifies without a separate view")
    r = c.patch(f"{BASE}/memory/items/{paper['id']}", json={"status": "planned"}).json()
    check("status corrected in one call", r["status"], "planned")
    r = c.patch(f"{BASE}/memory/items/{paper['id']}", json={"status": "in_progress"}).json()
    check("and corrected back", r["status"], "in_progress")
    r = c.patch(f"{BASE}/memory/items/{paper['id']}", json={"block_name": "learning"}).json()
    check("block reassigned", r["block_name"], "learning")
    c.patch(f"{BASE}/memory/items/{paper['id']}", json={"block_name": "work"})

    print("\nP6 — confirm resets the decay clock")
    before = c.get(f"{BASE}/memory/items/{paper['id']}").json()
    r = c.post(f"{BASE}/memory/items/{paper['id']}/confirm").json()
    check("confirm returns 200 and stamps the clock",
          r["last_confirmed_at"] is not None, True)
    check("confirm clears the review flag", r["needs_review"], False)
    note("last_confirmed_at before/after",
         f"{before['last_confirmed_at']} -> {r['last_confirmed_at']}")

    print("\nP6 — the CV failure case")
    draft = c.post(f"{BASE}/chats/{chat['id']}/verified-draft", json={
        "instruction": "Write one line for my academic CV about my paper with Priya.",
    })
    if draft.status_code != 200:
        print(f"  FAIL  verified-draft -> {draft.status_code}")
        print(f"        {draft.text[:300]}")
        return 1
    draft = draft.json()
    note("draft", draft["draft"][:150].replace("\n", " "))
    check("claims were extracted", len(draft["claims"]) > 0, True)

    with_sources = [c_ for c_ in draft["claims"] if c_["sources"]]
    check("at least one claim is traced to a memory", len(with_sources) > 0, True)
    for cl in with_sources:
        flag = "OVERSTATES" if cl["overstates"] else ("stale" if cl["stale_source"] else "ok")
        print(f"        [{flag:10s}] asserted={cl['asserted_as']!s:12s} {cl['text'][:60]}")
        if cl["problem"]:
            print(f"                     -> {cl['problem']}")

    # The precise claim: nothing unfinished got written up as finished. Checked
    # directly rather than via the overstates flag, so the test still means something
    # if the flag's definition changes.
    rendered_done = [
        cl for cl in with_sources
        if cl["asserted_as"] == "completed"
        and all(s["status"] != "completed" for s in cl["sources"])
    ]
    check("nothing unfinished was written up as finished", len(rendered_done), 0)
    check("so the draft is clean to ship", draft["needs_confirmation"], False)

    print("\nP6 — the guard fires when the draft does overstate")
    # Flip the stored status to completed-hostile: the memory says planned, so any
    # 'completed' phrasing must be caught. This exercises the detector rather than
    # trusting that the model happened to phrase things well.
    c.patch(f"{BASE}/memory/items/{paper['id']}", json={"status": "planned"})
    fake_claim_check = c.post(f"{BASE}/chats/{chat['id']}/verified-draft", json={
        "instruction": "State plainly and in past tense that I published the paper "
                       "with Priya. One sentence.",
    }).json()
    over = [cl for cl in fake_claim_check["claims"] if cl["overstates"]]
    note("draft", fake_claim_check["draft"][:130].replace("\n", " "))
    check("overstatement detected", len(over) > 0 or
          not any(cl["sources"] for cl in fake_claim_check["claims"]), True)
    if over:
        check("and flagged for confirmation", fake_claim_check["needs_confirmation"], True)
        note("problem", over[0]["problem"])
    else:
        note("note", "model declined to overstate; detector untriggered, not disproven")
    c.patch(f"{BASE}/memory/items/{paper['id']}", json={"status": "in_progress"})

    print("\nP6 — revoke and regenerate")
    # Probed with an invented token, for the same reason the leak test is (D24).
    #
    # The first version of this asserted only that the regenerated string *differed*
    # from the original, and revoked whichever memory happened to rank first. It
    # failed against a store holding several earlier runs' worth of overlapping
    # facts: revoking one copy of "writing a paper with Priya" left another standing,
    # so the answer was correctly unchanged and the test called that a bug. A passing
    # run would have meant just as little — inequality of two sampled strings at
    # temperature 0.7 is not evidence that revocation did anything.
    #
    # CANARY appears in exactly one place in the whole system: the memory item seeded
    # below. It is never said in a message, so it cannot reach the model through
    # conversation history. Its presence in a reply therefore means the memory was
    # used, and its absence after revocation means the memory stopped being used.
    CANARY = "Wickersham-Board protocol"
    canary_item = seed(f"Preparing a talk on the {CANARY} for the lab retreat",
                       "in_progress")

    turn = c.post(f"{BASE}/chats/{chat['id']}/message", json={
        "content": "What am I preparing for the lab retreat? Answer only from what "
                   "you actually know.",
    })
    if turn.status_code != 200:
        print(f"  FAIL  turn -> {turn.status_code} {turn.text[:200]}")
        return 1
    turn = turn.json()
    note("used memories", len(turn["used_memories"]))
    note("reply", turn["assistant_message"]["content"][:120].replace("\n", " "))

    check("the canary memory reached the answer",
          CANARY.lower() in turn["assistant_message"]["content"].lower(), True)

    regen = c.post(f"{BASE}/chats/{chat['id']}/regenerate", json={
        "message_id": turn["assistant_message"]["id"],
        "revoke_item_ids": [canary_item["id"]],
    })
    if regen.status_code != 200:
        print(f"  FAIL  regenerate -> {regen.status_code} {regen.text[:200]}")
        return 1
    regen = regen.json()
    note("regenerated", regen["regenerated"][:120].replace("\n", " "))

    check("previous answer returned for comparison",
          regen["previous"] == turn["assistant_message"]["content"], True)
    # The real assertion: the revoked *fact* is gone, not merely that the wording moved.
    check("the revoked fact is absent from the regenerated answer",
          CANARY.lower() in regen["regenerated"].lower(), False)
    check("and the memory is gone from the new answer's sources",
          any(m["id"] == canary_item["id"] for m in regen["used_memories"]), False)

    gone = c.get(f"{BASE}/memory/items/{canary_item['id']}").json()
    check("revoking rejects the memory, not just this response",
          gone["review_state"], "rejected")
    check("and tombstones it", gone["deleted_at"] is not None, True)

    if failures:
        print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
        return 1
    print("\nP2 + P6 acceptance: all checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
