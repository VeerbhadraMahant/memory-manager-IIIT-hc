"""P1 acceptance check. Requires uvicorn on 127.0.0.1:8000.

    python backend/scripts/smoke_p1.py

P1's done-when: a user can complete a turn, see what the system wants to remember,
and change it without leaving the chat. This exercises that loop and the policy
decisions underneath it — the interruption budget, the session-by-default rule for
sensitive categories, and the extractor's refusal to store credentials.

Makes real LLM calls, so it draws against the daily allowance and takes ~40s.
"""

from __future__ import annotations

import sys
import time

import httpx

BASE = "http://127.0.0.1:8000"
failures: list[str] = []
c = httpx.Client(timeout=120)


def check(label: str, got, want) -> bool:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}  (got {got!r}, want {want!r})")
    if not ok:
        failures.append(label)
    return ok


def note(label: str, value) -> None:
    print(f"  ....  {label}: {value}")


def wait_for_candidates(chat_id: str, message_id: str, timeout: float = 90) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = c.get(f"{BASE}/chats/{chat_id}/candidates",
                  params={"message_id": message_id}).json()
        if r["status"] in ("done", "failed", "skipped"):
            return r
        time.sleep(1.5)
    return {"status": "timeout", "candidates": [], "auto_accepted": [], "error": None}


TURN = (
    "I've been on 20mg escitalopram since March for anxiety. Still writing the CHI "
    "paper with Priya, should wrap next month. My sister is getting divorced so I'm "
    "flying to Pune this weekend. My card is 4539 1488 0343 6467 if you need it."
)


def main() -> int:
    try:
        c.get(f"{BASE}/health")
    except httpx.ConnectError:
        print("Backend unreachable. Start it:\n"
              "  cd backend && ../.venv/Scripts/python -m uvicorn app.main:app --port 8000")
        return 1

    chat = c.post(f"{BASE}/chats", json={"title": "P1 smoke"}).json()

    print("\nA full turn returns a response without waiting for extraction")
    t = time.time()
    turn = c.post(f"{BASE}/chats/{chat['id']}/message", json={"content": TURN})
    elapsed = time.time() - t
    check("turn -> 200", turn.status_code, 200)
    if turn.status_code != 200:
        print(turn.text[:400])
        return 1
    turn = turn.json()
    check("extraction reported as running", turn["extraction_running"], True)
    note("response latency", f"{elapsed:.1f}s (extraction excluded)")
    note("assistant said", turn["assistant_message"]["content"][:110].replace("\n", " "))

    print("\nExtraction produces reviewable candidates")
    res = wait_for_candidates(chat["id"], turn["user_message"]["id"])
    check("extraction completed", res["status"], "done")
    if res["status"] != "done":
        note("error", res.get("error"))
        return 1

    pending, auto = res["candidates"], res["auto_accepted"]
    note("pending review", len(pending))
    note("auto-accepted", len(auto))
    for i in pending + auto:
        flag = "AUTO" if i["review_state"] == "auto_accepted" else "REVIEW"
        print(f"        [{flag:6s}] [{i['source_type']:8s}] [{i['status']:12s}] "
              f"[{i['sensitivity']:16s}] [{i['scope']:10s}] {i['block_name']:12s} {i['content'][:60]}")

    all_items = pending + auto
    check("something was extracted", len(all_items) > 0, True)

    print("\nInterruption budget (principle 2)")
    check("nothing inferred was auto-accepted",
          all(i["source_type"] == "stated" for i in auto), True)
    check("nothing sensitive was auto-accepted",
          all(i["sensitivity"] == "low" for i in auto), True)
    check("at least one item did NOT interrupt the user", len(auto) > 0, True)

    print("\nSensitive categories default to session scope (principle 3)")
    sensitive = [i for i in all_items if i["sensitivity"] in ("high", "special_category")]
    note("sensitive items found", len(sensitive))
    check("all sensitive items are session-scoped",
          all(i["scope"] == "session" for i in sensitive), True)
    check("session items carry a chat anchor (D14)",
          all(i["session_chat_id"] == chat["id"] for i in sensitive if i["scope"] == "session"),
          True)

    print("\nStatus classification — the CV failure case")
    paper = [i for i in all_items if "paper" in i["content"].lower()]
    if check("the paper was extracted", len(paper) > 0, True):
        check("paper is in_progress, not completed", paper[0]["status"], "in_progress")
    sister = [i for i in all_items if "sister" in i["content"].lower()]
    if sister:
        check("sister's divorce is third_party", sister[0]["status"], "third_party")

    print("\nCredentials are never stored as memory")
    blob = " ".join(i["content"] + " " + (i["evidence"] or "") for i in all_items)
    check("full card number absent", "4539" in blob and "6467" in blob, False)
    check("no partial card number either",
          any(x in blob for x in ("6467", "ending 6467", "card ending")), False)

    print("\nEvery item is traceable to its source (principle 7)")
    check("all items reference the source message",
          all(i["source_message_id"] == turn["user_message"]["id"] for i in all_items), True)
    check("all items carry an evidence span",
          all(i.get("evidence") for i in all_items), True)

    print("\nThe user can change things without leaving the chat")
    if pending:
        target = pending[0]
        r = c.patch(f"{BASE}/memory/items/{target['id']}",
                    json={"content": target["content"] + " (corrected)"}).json()
        check("edit applies", r["content"].endswith("(corrected)"), True)
        check("editing counts as accepting", r["review_state"], "accepted")

        r = c.post(f"{BASE}/memory/items/{target['id']}/rescope",
                   json={"scope": "persistent"}).json()
        check("rescope to persistent", r["scope"], "persistent")
        check("persistent drops the chat anchor", r["session_chat_id"], None)

    if len(pending) > 1:
        victim = pending[1]
        r = c.post(f"{BASE}/memory/items/{victim['id']}/reject").json()
        check("reject marks rejected", r["review_state"], "rejected")
        check("reject tombstones rather than erases", r["deleted_at"] is not None, True)
        listed = c.get(f"{BASE}/memory/items").json()
        check("rejected item leaves the live list",
              any(i["id"] == victim["id"] for i in listed), False)

    print("\nP3 preview: an ephemeral turn never reaches the extractor")
    eph = c.post(f"{BASE}/chats/{chat['id']}/message", json={
        "content": "Off the record: my employee ID is 88213 and I'm interviewing elsewhere.",
        "session_ephemeral": True,
    }).json()
    check("ephemeral turn reports no extraction", eph["extraction_running"], False)
    res2 = wait_for_candidates(chat["id"], eph["user_message"]["id"], timeout=12)
    check("extraction status is skipped", res2["status"], "skipped")
    check("no candidates at all", len(res2["candidates"]) + len(res2["auto_accepted"]), 0)
    leaked = c.get(f"{BASE}/memory/items", params={"q": "88213", "include_deleted": "true"}).json()
    check("nothing about it entered the store", len(leaked), 0)

    if failures:
        print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
        return 1
    print("\nP1 acceptance: all checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
