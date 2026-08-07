"""P0 acceptance check. Requires uvicorn running on 127.0.0.1:8000.

    python backend/scripts/smoke_p0.py

Asserts the P0 done-when from PHASES.md ("a memory item can be inserted and read
back via API") plus the constraints that carry design weight: session scope cannot
exist without a chat anchor, and an unclassified item lands in the *most* restrictive
block rather than a neutral one.
"""

from __future__ import annotations

import sys

import httpx

BASE = "http://127.0.0.1:8000"
failures: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'PASS' if ok else 'FAIL'}  {label}  (got {got!r}, want {want!r})")
    if not ok:
        failures.append(label)


def main() -> int:
    c = httpx.Client(timeout=30)

    try:
        health = c.get(f"{BASE}/health").json()
    except httpx.ConnectError:
        print("Backend unreachable. Start it:\n"
              "  cd backend && ../.venv/Scripts/python -m uvicorn app.main:app --port 8000")
        return 1

    print("\nBackend")
    check("health ok", health["status"], "ok")
    check("pgvector installed", health["pgvector"] is not None, True)
    check("embedding dim 768", health["embedding_dim"], 768)

    print("\nSeeded blocks")
    blocks = c.get(f"{BASE}/memory/blocks").json()
    check("five blocks", len(blocks), 5)
    check("fallback is most restrictive", blocks[0]["name"], "unclassified")
    check("fallback flagged", blocks[0]["is_fallback"], True)

    print("\nInsert and read back")
    chat = c.post(f"{BASE}/chats", json={"title": "P0 smoke"}).json()
    msg = c.post(f"{BASE}/chats/{chat['id']}/messages", json={
        "role": "user",
        "content": "I'm still writing the CHI paper on memory negotiation.",
    }).json()

    created = c.post(f"{BASE}/memory/items", json={
        "content": "Writing a CHI paper on memory negotiation",
        "source_type": "stated", "status": "in_progress", "sensitivity": "low",
        "scope": "persistent", "confidence": 0.91,
        "source_message_id": msg["id"], "block_name": "work",
    })
    check("create -> 201", created.status_code, 201)
    item = created.json()

    read = c.get(f"{BASE}/memory/items/{item['id']}")
    check("read back -> 200", read.status_code, 200)
    check("content round-trips", read.json()["content"], item["content"])
    check("traceable to source message", read.json()["source_message_id"], msg["id"])
    check("status survives", read.json()["status"], "in_progress")

    print("\nFilters")
    filtered = c.get(f"{BASE}/memory/items", params={"status": "in_progress"}).json()
    check("status filter finds it", any(i["id"] == item["id"] for i in filtered), True)
    none = c.get(f"{BASE}/memory/items", params={"status": "completed", "q": "CHI paper"}).json()
    check("wrong status excludes it", any(i["id"] == item["id"] for i in none), False)

    print("\nConstraints that carry design weight")
    r = c.post(f"{BASE}/memory/items", json={
        "content": "canary", "source_type": "stated", "status": "completed",
        "sensitivity": "high", "scope": "session", "confidence": 0.5,
        "source_message_id": msg["id"],
    })
    check("session scope needs a chat anchor", r.status_code, 422)

    r = c.post(f"{BASE}/memory/items", json={
        "content": "canary", "source_type": "stated", "status": "completed",
        "sensitivity": "low", "scope": "persistent", "confidence": 0.5,
        "source_message_id": msg["id"], "session_chat_id": chat["id"],
    })
    check("persistent scope rejects a chat anchor", r.status_code, 422)

    r = c.post(f"{BASE}/memory/items", json={
        "content": "unclassifiable", "source_type": "inferred", "status": "hypothetical",
        "sensitivity": "medium", "scope": "persistent", "confidence": 0.3,
        "source_message_id": msg["id"], "needs_review": True,
    })
    check("no block -> restrictive fallback", r.json()["block_name"], "unclassified")

    r = c.post(f"{BASE}/memory/items", json={
        "content": "x", "source_type": "stated", "status": "finished",
        "sensitivity": "low", "scope": "persistent", "confidence": 0.5,
        "source_message_id": msg["id"],
    })
    check("invalid status rejected", r.status_code, 422)

    # What P0 actually promised was that a planned route says "planned", not "absent" —
    # 501 with the phase, never 404. It did not promise any particular route stays
    # unbuilt. `accept` shipped in P1 and `confirm` in P6, so asserting 501 on them
    # was asserting the project had not progressed, which is a test that fails on
    # success. Only genuinely unbuilt routes belong below.
    print("\nBuilt routes are built")
    check("accept -> 200, built in P1",
          c.post(f"{BASE}/memory/items/{item['id']}/accept").status_code, 200)
    check("confirm -> 200, built in P6",
          c.post(f"{BASE}/memory/items/{item['id']}/confirm").status_code, 200)

    print("\nUnbuilt routes announce themselves")
    check("delete -> 501 not 404",
          c.delete(f"{BASE}/memory/items/{item['id']}").status_code, 501)
    check("graph -> 501 not 404",
          c.get(f"{BASE}/memory/items/{item['id']}/graph").status_code, 501)

    if failures:
        print(f"\n{len(failures)} FAILED: {', '.join(failures)}")
        return 1
    print("\nP0 acceptance: all checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
