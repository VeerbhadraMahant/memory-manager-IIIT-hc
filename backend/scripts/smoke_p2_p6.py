"""P2 (classification) + P6 (attribution and verification) acceptance.

    python backend/scripts/smoke_p2_p6.py

Reproduces the originating incident end to end: memory says a paper is in progress,
the system is asked for a CV line, and it refuses to render it as published.

Costs 2 chat-model calls. The heuristic, decay and confirm checks need no model at
all, so most of this runs free — deliberately, because daily quota is 20 per model.
"""

from __future__ import annotations

import sys

import httpx

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


def main() -> int:
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
    turn = c.post(f"{BASE}/chats/{chat['id']}/message", json={
        "content": "What am I working on at the moment?",
    })
    if turn.status_code != 200:
        print(f"  FAIL  turn -> {turn.status_code} {turn.text[:200]}")
        return 1
    turn = turn.json()
    note("used memories", len(turn["used_memories"]))
    note("reply", turn["assistant_message"]["content"][:120].replace("\n", " "))

    if turn["used_memories"]:
        victim = turn["used_memories"][0]
        regen = c.post(f"{BASE}/chats/{chat['id']}/regenerate", json={
            "message_id": turn["assistant_message"]["id"],
            "revoke_item_ids": [victim["id"]],
        })
        if regen.status_code != 200:
            print(f"  FAIL  regenerate -> {regen.status_code} {regen.text[:200]}")
            return 1
        regen = regen.json()
        check("previous answer returned for comparison",
              regen["previous"] == turn["assistant_message"]["content"], True)
        check("answer actually changed", regen["regenerated"] != regen["previous"], True)
        check("the revoked memory is gone from the new answer's sources",
              any(m["id"] == victim["id"] for m in regen["used_memories"]), False)
        note("revoked", victim["content"][:60])
        note("regenerated", regen["regenerated"][:120].replace("\n", " "))

        gone = c.get(f"{BASE}/memory/items/{victim['id']}").json()
        check("revoking rejects the memory, not just this response",
              gone["review_state"], "rejected")
        check("and tombstones it", gone["deleted_at"] is not None, True)
    else:
        note("skipped", "no memories were retrieved for that turn")

    if failures:
        print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
        return 1
    print("\nP2 + P6 acceptance: all checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
