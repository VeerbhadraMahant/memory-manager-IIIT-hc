"""Re-embed every live memory item with the currently configured embedding model.

Needed once after the Gemini -> OpenRouter port. Embeddings from different providers
occupy different vector spaces, so rows written by the old client do not compare
meaningfully against rows written by the new one. Nothing errors — retrieval just
quietly returns the wrong memories, which is the worst possible failure mode for a
system whose whole claim is that the user can see what shaped a response.

Touches the `embedding` column only. Content, scope, status, review state and
provenance edges are never read for writing or modified, so this is safe to run
against demo data that is about to be shown to judges.

    .venv/Scripts/python backend/scripts/reembed.py --dry-run
    .venv/Scripts/python backend/scripts/reembed.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg
from psycopg.rows import dict_row

from app.config import settings
from app.services import llm

BATCH = 32


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="report what would change, write nothing")
    args = ap.parse_args()

    with psycopg.connect(settings.database_url, row_factory=dict_row, connect_timeout=15) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """select id, content from memory_items
                   where deleted_at is null and content is not null
                   order by created_at"""
            )
            rows = cur.fetchall()

        print(f"{len(rows)} live memory items")
        print(f"model: {settings.llm_embed_model} @ {settings.embedding_dim} dims")
        if args.dry_run:
            print("dry run — nothing written")
            return 0
        if not rows:
            return 0

        done = 0
        for i in range(0, len(rows), BATCH):
            chunk = rows[i : i + BATCH]
            vectors = llm.embed([r["content"] for r in chunk])
            with conn.cursor() as cur:
                for r, vec in zip(chunk, vectors, strict=True):
                    cur.execute(
                        "update memory_items set embedding = %s where id = %s",
                        (str(vec), r["id"]),
                    )
            conn.commit()
            done += len(chunk)
            print(f"  re-embedded {done}/{len(rows)}")

    print(f"done — {done} items now share one vector space")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
