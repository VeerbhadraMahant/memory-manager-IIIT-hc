"""P3 leak test — the repeatable check PHASES.md asks for.

    python backend/scripts/leak_test_p3.py            # full, uses ~4 Gemini calls
    python backend/scripts/leak_test_p3.py --no-llm   # store-level only, free

Two guarantees are tested, and they are genuinely different claims:

  1. An **off-the-record turn** is never extracted. Nothing is derived from it, so
     nothing about it exists in the memory store at all. This is enforced by an early
     return in the extraction pass, before Gemini is called.

  2. A **session-scoped memory** does exist in the store, but is unreachable from any
     other chat. This is enforced in SQL at retrieval.

The store-level half needs no model and no quota, which is deliberate: the strongest
evidence here is a database query returning zero rows, and that should be runnable
on demand without spending a request. `--no-llm` is the version to run in front of
an audience if quota is tight.
"""

from __future__ import annotations

import argparse
import sys
import time

import httpx

BASE = "http://127.0.0.1:8000"
c = httpx.Client(timeout=120)
failures: list[str] = []

# Both probes use invented tokens that cannot already exist in the store.
#
# An earlier version of this test used "escitalopram" for the session-scoped fact and
# failed, because previous smoke runs had left *persistent* memories saying the same
# thing — which session two is entitled to see. The test could not tell a genuine leak
# from a legitimate persistent recall, which made a passing run meaningless too.
# A canary that cannot pre-exist is what makes absence from the answer evidence.
SECRET = "Kestrel-Lane-Provisional-77"
OFF_RECORD = (
    f"Off the record: my internal project codename is {SECRET} and I'm quietly "
    "interviewing at another lab."
)

SESSION_SECRET = "Vaudrey-Linnet syndrome"
SESSION_FACT = (
    f"I was diagnosed with {SESSION_SECRET} last month and started treatment for it. "
    "I'd rather that stayed in this conversation."
)


def check(label: str, got, want) -> bool:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}  (got {got!r}, want {want!r})")
    if not ok:
        failures.append(label)
    return ok


def note(label: str, value) -> None:
    print(f"  ....  {label}: {value}")


def wait_extraction(chat_id: str, message_id: str, timeout: float = 90) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = c.get(f"{BASE}/chats/{chat_id}/candidates",
                  params={"message_id": message_id}).json()
        if r["status"] in ("done", "failed", "skipped"):
            return r
        time.sleep(1.5)
    return {"status": "timeout", "candidates": [], "auto_accepted": [], "error": None}


def store_level_checks() -> None:
    """No Gemini required. The invariants that must hold whatever is in the store."""
    print("\nStore-level invariants (no model calls)")

    chats = c.get(f"{BASE}/chats").json()
    if not chats:
        print("  ....  no chats yet — run without --no-llm first")
        return

    report = c.get(f"{BASE}/chats/{chats[0]['id']}/scope-report").json()
    check("nothing anywhere was derived from an off-the-record turn",
          report["items_from_ephemeral_turns_global"], 0)

    everything = c.get(f"{BASE}/memory/items",
                       params={"limit": "1000", "include_deleted": "true"}).json()
    note("memory items in store (incl. tombstoned)", len(everything))

    hits = [i for i in everything if SECRET.lower() in i["content"].lower()
            or SECRET.lower() in (i["evidence"] or "").lower()]
    check("the off-the-record secret is in no memory item", len(hits), 0)

    # The complement, and the sharper claim: the session-scoped fact *is* stored. It
    # was not suppressed or forgotten — it exists, carries an anchor, and is simply
    # unreachable from anywhere else. "Never written down" and "written down and
    # fenced" are different guarantees and the demo should not blur them.
    session_hits = [i for i in everything
                    if SESSION_SECRET.split()[0].lower() in i["content"].lower()]
    if session_hits:
        check("the session-only fact IS in the store", len(session_hits) > 0, True)
        check("and every copy of it is session-scoped",
              all(i["scope"] == "session" for i in session_hits), True)
        check("and every copy carries a chat anchor",
              all(i["session_chat_id"] for i in session_hits), True)

    orphans = [i for i in everything if not i["source_message_id"]]
    check("no orphaned facts (principle 7)", len(orphans), 0)

    unanchored = [i for i in everything
                  if i["scope"] == "session" and not i["session_chat_id"]]
    check("no session item without a chat anchor (D14)", len(unanchored), 0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true",
                    help="store-level checks only; spends no Gemini quota")
    args = ap.parse_args()

    try:
        c.get(f"{BASE}/health")
    except httpx.ConnectError:
        print("Backend unreachable. Start it:\n"
              "  cd backend && ../.venv/Scripts/python -m uvicorn app.main:app --port 8000")
        return 1

    if args.no_llm:
        store_level_checks()
        return report_result()

    # ---------------------------------------------------------------- session one
    print("\nSession one — say something off the record, and something session-scoped")
    s1 = c.post(f"{BASE}/chats", json={"title": "Leak test — session one"}).json()

    t1 = c.post(f"{BASE}/chats/{s1['id']}/message",
                json={"content": OFF_RECORD, "session_ephemeral": True}).json()
    check("off-the-record turn reports no extraction", t1["extraction_running"], False)
    res1 = wait_extraction(s1["id"], t1["user_message"]["id"], timeout=12)
    check("extraction status is skipped", res1["status"], "skipped")
    check("no candidates were produced",
          len(res1["candidates"]) + len(res1["auto_accepted"]), 0)

    t2 = c.post(f"{BASE}/chats/{s1['id']}/message",
                json={"content": SESSION_FACT}).json()
    res2 = wait_extraction(s1["id"], t2["user_message"]["id"])
    check("the second turn WAS extracted", res2["status"], "done")

    health_items = [i for i in res2["candidates"] + res2["auto_accepted"]
                    if "vaudrey" in i["content"].lower()]
    if check("the health fact was extracted", len(health_items) > 0, True):
        item = health_items[0]
        check("and defaulted to session scope (principle 3)", item["scope"], "session")
        check("anchored to this chat", item["session_chat_id"], s1["id"])
        # Accept it, so the next assertion is about scope and not about review state.
        c.post(f"{BASE}/memory/items/{item['id']}/accept")

    r1 = c.get(f"{BASE}/chats/{s1['id']}/scope-report").json()
    note("session one sees", f"{r1['visible_persistent']} persistent + "
                             f"{r1['visible_session']} session")
    check("session one can see its own session memory", r1["visible_session"] >= 1, True)

    # ---------------------------------------------------------------- session two
    print("\nSession two — a new session, same user")
    s2 = c.post(f"{BASE}/chats", json={"title": "Leak test — session two"}).json()

    r2 = c.get(f"{BASE}/chats/{s2['id']}/scope-report").json()
    check("session two sees none of session one's session memory",
          r2["visible_session"], 0)
    check("and knows they exist but are out of reach",
          len(r2["hidden_session_items"]) >= 1, True)
    note("hidden from session two",
         [h["content"][:48] for h in r2["hidden_session_items"]][:4])

    print("\nAsk session two directly about both")
    probe = c.post(f"{BASE}/chats/{s2['id']}/message", json={
        "content": "What do you know about my medication, and do you know any "
                   "project codename of mine? Answer only from what you actually know.",
    }).json()
    answer = probe["assistant_message"]["content"]
    note("used_memories in session two", len(probe["used_memories"]))
    note("answer", answer[:170].replace("\n", " "))

    check("no session-scoped memory was injected into session two",
          any(m["scope"] == "session" for m in probe["used_memories"]), False)
    check("the off-the-record codename is absent from the answer",
          SECRET.lower() in answer.lower(), False)
    check("the session-only diagnosis is absent from the answer",
          "vaudrey" in answer.lower(), False)

    store_level_checks()
    return report_result()


def report_result() -> int:
    if failures:
        print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
        return 1
    print("\nP3 leak test: all checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
