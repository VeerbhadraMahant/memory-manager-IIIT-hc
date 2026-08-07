"use client";

// §2, made structural.
//
// "If an action can only be expressed in one view, it does not ship."
//
// The cheapest way to guarantee that is for there to be exactly one component
// that renders the actions, and for both views to mount it. The list row and the
// graph's detail panel both render <MemoryActionBar>, so action parity is not
// something to re-audit after every change — it is the same subtree twice.
//
// Everything here calls useMemoryActions(). Nothing here touches the API.

import { useEffect, useRef, useState } from "react";
import {
  Check,
  CircleCheckBig,
  Pencil,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

import { SCOPE_LABEL, SENSITIVITY_LABEL, STATUS_LABEL } from "@/lib/api";
import type { AssertionStatus, MemoryItem, Sensitivity } from "@/lib/api";
import { useMemoryActions, useMemoryStore } from "@/lib/memory-store";
import {
  SENSITIVITIES,
  STATUS_CHIP,
  STATUSES,
  isStale,
} from "@/lib/semantics";
import { Button } from "@/components/ui/button";
import { Chip, SelectChip, SourceChip } from "@/components/ui/chip";

export function MemoryActionBar({
  item,
  onRequestDelete,
  onLight = true,
  compact,
}: {
  item: MemoryItem;
  /** Delete opens a preview first (§4.5), which the workspace owns because the
   *  graph has to highlight the subgraph while it is open. */
  onRequestDelete: (item: MemoryItem) => void;
  /** Off-white card (true) or the dark app background (false). */
  onLight?: boolean;
  /** Drops the classification chips. Used where they are already on screen. */
  compact?: boolean;
}) {
  const actions = useMemoryActions();
  const { busy, blocks } = useMemoryStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const working = busy.has(item.id);
  const pending = item.review_state === "pending";
  const stale = isStale(item);

  useEffect(() => {
    if (editing) textarea.current?.focus();
  }, [editing]);

  const run = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "that did not go through");
    }
  };

  const variant = onLight ? "outlineInk" : "outline";

  if (editing) {
    return (
      <div className="space-y-3">
        <label className="block">
          <span className="meta mb-1 block text-ink-muted">Memory text</span>
          <textarea
            ref={textarea}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="w-full rounded-input border border-outline-ink bg-white p-3 text-body-sm text-ink"
          />
        </label>
        <p className="text-body-sm text-ink-muted">
          Saving a correction keeps the memory — you have already looked at it.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={working || !draft.trim()}
            onClick={run(async () => {
              await actions.editContent(item.id, draft.trim());
              setEditing(false);
            })}
          >
            <Check className="size-4" aria-hidden="true" />
            Save and keep
          </Button>
          <Button
            variant={variant}
            size="sm"
            onClick={() => {
              setDraft(item.content);
              setEditing(false);
            }}
          >
            <Undo2 className="size-4" aria-hidden="true" />
            Cancel
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-body-sm text-danger-ink">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!compact && (
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceChip source={item.source_type} onLight={onLight} />
          <SelectChip
            label="Block"
            value={item.block_name ?? "unclassified"}
            options={blocks.map((b) => [b, b] as const)}
            disabled={working}
            onLight={onLight}
            onChange={(v) => void run(() => actions.reclassify(item.id, { block_name: v }))()}
          />
          <SelectChip
            label="Status"
            value={item.status}
            options={STATUSES.map((s) => [s, STATUS_CHIP[s]] as const)}
            disabled={working}
            onLight={onLight}
            tone={stale ? "alert" : "neutral"}
            onChange={(v) =>
              void run(() =>
                actions.reclassify(item.id, { status: v as AssertionStatus }),
              )()
            }
          />
          <SelectChip
            label="Sensitivity"
            value={item.sensitivity}
            options={SENSITIVITIES.map((s) => [s, SENSITIVITY_LABEL[s]] as const)}
            disabled={working}
            onLight={onLight}
            onChange={(v) =>
              void run(() =>
                actions.reclassify(item.id, { sensitivity: v as Sensitivity }),
              )()
            }
          />
          <Chip tone={item.scope === "session" ? "alert" : "neutral"} onLight={onLight}>
            {SCOPE_LABEL[item.scope]}
          </Chip>
          <Chip onLight={onLight} className="tnum">
            {Math.round(item.confidence * 100)}% conf
          </Chip>
        </div>
      )}

      {/* §4.1: an IN PROGRESS item past the staleness threshold has to be
          impossible to miss. It is not a chip tint — it is a row with a fix in
          it, because the recovery from "this might not be true any more" is one
          tap and the user should not have to go looking for it. */}
      {stale && (
        <div className="flex flex-wrap items-center gap-2 rounded-input border border-stated/50 bg-stated-dim px-3 py-2">
          <span className="meta text-stated-ink">not confirmed recently</span>
          <span className="text-body-sm text-ink-muted">
            Still in progress, but nothing has re-asserted it. It will be dated
            rather than stated as current.
          </span>
          <Button
            variant={variant}
            size="sm"
            disabled={working}
            onClick={run(() => actions.confirm(item.id))}
          >
            <CircleCheckBig className="size-4" aria-hidden="true" />
            Still true
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {pending ? (
          <>
            <Button
              variant="primary"
              size="sm"
              disabled={working}
              onClick={run(() => actions.accept(item.id))}
            >
              <Check className="size-4" aria-hidden="true" />
              Keep
            </Button>
            <Button
              variant={variant}
              size="sm"
              disabled={working}
              onClick={run(() => actions.reject(item.id))}
            >
              <X className="size-4" aria-hidden="true" />
              Discard
            </Button>
          </>
        ) : (
          !stale && (
            <Button
              variant={variant}
              size="sm"
              disabled={working}
              onClick={run(() => actions.confirm(item.id))}
            >
              <CircleCheckBig className="size-4" aria-hidden="true" />
              Still true
            </Button>
          )
        )}

        <Button variant={variant} size="sm" disabled={working} onClick={() => setEditing(true)}>
          <Pencil className="size-4" aria-hidden="true" />
          Edit
        </Button>

        <Button
          variant={variant}
          size="sm"
          disabled={working}
          onClick={run(() =>
            actions.rescope(item.id, item.scope === "session" ? "persistent" : "session"),
          )}
        >
          {item.scope === "session" ? "Keep beyond this chat" : "Only this chat"}
        </Button>

        {/* §7 destructive-emphasis: danger colour, and pushed to its own end of
            the row so it is not adjacent to the action people press by habit. */}
        <Button
          variant={onLight ? "dangerInk" : "danger"}
          size="sm"
          disabled={working}
          className="sm:ml-auto"
          onClick={() => onRequestDelete(item)}
        >
          <Trash2 className="size-4" aria-hidden="true" />
          Delete…
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-body-sm text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}

/** Shared read-only summary line. Keeps the list row and the graph detail panel
 *  describing an item in the same words (§2: same state, two representations). */
export function MemorySummary({
  item,
  onLight = true,
}: {
  item: MemoryItem;
  onLight?: boolean;
}) {
  return (
    <p className={onLight ? "text-body-sm text-ink-muted" : "text-body-sm text-ink-invert-muted"}>
      {item.block_name ?? "unclassified"} · {STATUS_LABEL[item.status]} ·{" "}
      {SCOPE_LABEL[item.scope]}
      {item.review_state === "pending" && " · awaiting your review"}
      {item.needs_review && item.review_state !== "pending" && " · flagged for review"}
    </p>
  );
}
