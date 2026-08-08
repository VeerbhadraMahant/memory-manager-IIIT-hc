"use client";

// Which blocks the model is allowed to see.
//
// This is a different axis from scope, and conflating the two is the mistake the copy
// here works to prevent:
//
//   scope   — which *conversations* may use a memory ("this chat only" vs "remembered")
//   private — whether the *model* receives it at all, in any conversation
//
// A private block's memories stay fully visible in this panel, stay editable, stay
// deletable. They are simply excluded from the retrieval SQL, so they are never
// written into a prompt. The turn's retrieval panel reports the number withheld, so
// the guarantee is a count on screen rather than a claim in a doc.
//
// The fallback block cannot be made private — the server refuses it (422). Everything
// the classifier was unsure about lands there by design (D3), so making it private
// would silently withhold exactly the material the user never explicitly filed.

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldOff } from "lucide-react";

import { api, type Block } from "@/lib/api";
import { blockLabel } from "@/lib/semantics";
import { cn } from "@/lib/utils";
import { useMemoryStore } from "@/lib/memory-store";

export function PrivacyBlocks() {
  const { announce } = useMemoryStore();
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.blocks().then(setBlocks).catch(() => {});
  }, []);

  useEffect(load, [load]);

  const toggle = async (block: Block) => {
    setBusy(block.name);
    setError(null);
    try {
      const updated = await api.setBlockPrivacy(block.name, !block.private);
      setBlocks((bs) => bs.map((b) => (b.name === updated.name ? updated : b)));
      announce(
        updated.private
          ? `${blockLabel(updated.name)} is now withheld from the model.`
          : `${blockLabel(updated.name)} is available to the model again.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not change that");
    } finally {
      setBusy(null);
    }
  };

  if (blocks.length === 0) return null;
  const privateCount = blocks.filter((b) => b.private).length;

  return (
    <section
      aria-label="What the model may see"
      className="shrink-0 rounded-card border border-outline bg-raised p-4"
    >
      <h2 className="meta mb-2 flex items-center gap-1.5 text-ink-invert-muted">
        <ShieldOff className="size-4" aria-hidden="true" />
        What the model may see
      </h2>
      <p className="text-body-sm text-ink-invert-muted">
        Withhold a whole category from every prompt. These memories stay here — you can
        still read, edit and delete them — they just stop reaching the model.
      </p>

      <ul className="mt-3 space-y-1">
        {blocks.map((b) => (
          <li key={b.name}>
            <label
              className={cn(
                "tap flex items-center gap-2 rounded-input px-2 text-body-sm",
                b.is_fallback
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer hover:bg-sunken",
              )}
              title={
                b.is_fallback
                  ? "Unclassified cannot be private — anything the classifier was unsure about lands here"
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={b.private}
                disabled={b.is_fallback || busy === b.name}
                onChange={() => void toggle(b)}
                className="size-4 shrink-0 accent-[color:var(--danger)]"
              />
              <span className="min-w-0 flex-1 truncate text-ink-invert">
                {blockLabel(b.name)}
              </span>
              {busy === b.name && (
                <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
              )}
              {b.private && (
                <span className="meta shrink-0 text-danger-on-bg">withheld</span>
              )}
            </label>
          </li>
        ))}
      </ul>

      {error && (
        <p role="alert" className="mt-2 text-body-sm text-danger-on-bg">
          {error}
        </p>
      )}

      <p className="meta mt-3 border-t border-outline pt-2 text-ink-invert-muted">
        {privateCount === 0
          ? "nothing is withheld — every block can reach the model"
          : `${privateCount} withheld · enforced in retrieval, not in this panel`}
      </p>
    </section>
  );
}
