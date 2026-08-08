"use client";

// §4.2 — the candidate review card. The core loop (P1).
//
// Inline in the conversation, attached below the turn it came from (D1: memory
// formation is an in-conversation event, not a settings page). On mobile the
// same card becomes a sticky bottom sheet, because a card below the fold on a
// phone is a card nobody answers.
//
// The design decision that matters most here is what does NOT render:
//
//   "Auto-accepted items do not render a card. They log quietly with a small
//    mono line ('3 remembered') that expands on click. This is the interruption
//    budget — if every extraction shows a card, the design has failed regardless
//    of how good the card looks."
//
// So the auto-accepted group is one line of mono text with a disclosure, and the
// pending group is the only thing that asks for anything. Reversing that ratio
// would be the failure mode CLAUDE.md principle 2 is written against.
//
// Wording follows principle 5 throughout: consequence, not caution. "Kept for
// this chat only" says what happens. "Are you sure?" only transfers anxiety.

import { useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Pencil, Undo2, X } from "lucide-react";

import {
  SCOPE_LABEL,
  SENSITIVITY_LABEL,
  type AssertionStatus,
  type MemoryItem,
  type Sensitivity,
} from "@/lib/api";
import { useMemoryActions, useMemoryStore } from "@/lib/memory-store";
import { FALLBACK_BLOCKS, STATUSES, STATUS_CHIP, blockLabel } from "@/lib/semantics";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Chip, SelectChip, SourceChip } from "@/components/ui/chip";

export function ReviewCard({
  pending,
  autoAccepted,
  onResolved,
}: {
  pending: MemoryItem[];
  autoAccepted: MemoryItem[];
  onResolved: (id: string) => void;
}) {
  const actions = useMemoryActions();
  const [showAuto, setShowAuto] = useState(false);
  const card = useRef<HTMLElement>(null);
  const announced = useRef(false);

  // §4.2: "On appear: focus moves to the card, aria-live='polite' announces
  // '1 new memory to review.'"
  //
  // Focus moves to the card container, not to the Keep button. Landing on a
  // destructive-adjacent control the user has not read yet is how a
  // "just press Enter" habit turns into an accidental accept.
  useEffect(() => {
    if (pending.length > 0 && !announced.current) {
      announced.current = true;
      card.current?.focus();
    }
  }, [pending.length]);

  if (pending.length === 0 && autoAccepted.length === 0) return null;

  return (
    <section
      ref={card}
      tabIndex={-1}
      aria-label={
        pending.length > 0
          ? `${pending.length} new ${pending.length === 1 ? "memory" : "memories"} to review`
          : "What was remembered from this turn"
      }
      className={cn(
        "on-surface anim-enter rounded-card bg-surface text-ink",
        // Desktop: attached below the turn, indented to read as belonging to it.
        "my-3 sm:ml-10",
        // Mobile: sticky bottom sheet. Sticky rather than fixed so it cannot
        // cover the transcript permanently or fight the composer for the
        // bottom edge.
        "sticky bottom-2 z-20 shadow-xl sm:static sm:z-auto sm:shadow-none",
        pending.length > 0 && "ring-2 ring-[color:var(--stated)]",
      )}
    >
      <h3 className="meta border-b border-outline-ink px-4 py-3 text-ink-muted">
        {pending.length > 0
          ? `${pending.length} to review`
          : "remembered from this turn"}
      </h3>

      {/* ------------------------------------------- the interruption budget */}
      {autoAccepted.length > 0 && (
        <div className="border-b border-outline-ink px-4 py-2">
          <button
            onClick={() => setShowAuto((v) => !v)}
            aria-expanded={showAuto}
            className="on-surface tap flex w-full items-center gap-2 rounded-input text-left"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-4 text-ink-muted transition-transform duration-[var(--motion-micro)]",
                showAuto && "rotate-90",
              )}
            />
            <span className="meta tnum text-ink-muted">
              {autoAccepted.length} remembered
            </span>
            <span className="text-body-sm text-ink-muted">
              — high confidence, nothing sensitive
            </span>
          </button>

          {showAuto && (
            <ul className="mb-2 mt-2 space-y-2">
              {autoAccepted.map((it) => (
                <li
                  key={it.id}
                  className="rounded-input border border-outline-ink p-3"
                >
                  <p className="text-body-sm text-ink">{it.content}</p>
                  <p className="mt-1 text-body-sm text-ink-muted">
                    {it.review_reason}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      variant="outlineInk"
                      size="sm"
                      onClick={() =>
                        void actions.reject(it.id).then(() => onResolved(it.id))
                      }
                    >
                      Forget this
                    </Button>
                    <Button
                      variant="outlineInk"
                      size="sm"
                      onClick={() =>
                        void actions
                          .rescope(it.id, "session")
                          .then(() => onResolved(it.id))
                      }
                    >
                      Only this chat
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <ul className="divide-y divide-[color:var(--outline-ink)]">
          {pending.map((it) => (
            <PendingItem key={it.id} item={it} onResolved={onResolved} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PendingItem({
  item,
  onResolved,
}: {
  item: MemoryItem;
  onResolved: (id: string) => void;
}) {
  const actions = useMemoryActions();
  const { blocks } = useMemoryStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [status, setStatus] = useState<AssertionStatus>(item.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [corrected, setCorrected] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) textarea.current?.focus();
  }, [editing]);

  /** `resolve: false` keeps the card open — a reclassification is a correction,
   *  not a decision to keep, and dismissing the card would rob the user of the
   *  accept step they have not taken yet. */
  const run = async (fn: () => Promise<unknown>, resolve = true) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (resolve) {
        onResolved(item.id);
      } else {
        setCorrected(true);
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "that did not go through");
      setBusy(false);
    }
  };

  // The review card cannot wait on a blocks fetch mid-conversation, so it uses
  // whatever the store has and falls back to the seeded names.
  const blockOptions = (blocks.length ? blocks : FALLBACK_BLOCKS).map(
    (b) => [b, blockLabel(b)] as const,
  );

  return (
    <li className="px-4 py-4">
      {editing ? (
        <div className="space-y-3">
          <label className="block">
            <span className="meta mb-1 block text-ink-muted">Memory text</span>
            <textarea
              ref={textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              className="w-full rounded-input border border-outline-ink bg-white p-3 text-body-md text-ink"
            />
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <span className="meta text-ink-muted">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AssertionStatus)}
              className="min-h-11 rounded-input border border-outline-ink bg-white px-3 text-body-sm text-ink"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_CHIP[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <>
          <p className="measure text-body-md text-ink">{item.content}</p>
          {item.evidence && (
            // Principle 7, made visible: the item is traceable to what you said,
            // so the card shows the phrase rather than asking for trust.
            <p className="mt-2 border-l-2 border-stated pl-3 text-body-sm italic text-ink-muted">
              &ldquo;{item.evidence}&rdquo;
            </p>
          )}
        </>
      )}

      {item.review_reason && (
        <p className="mt-2 text-body-sm text-ink-muted">{item.review_reason}</p>
      )}

      {/* P2 one-tap correction: the chips that *show* the classification are the
          controls that change it. Native selects — one interaction, keyboard
          operable, screen-reader labelled without a line of ARIA. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <SourceChip source={item.source_type} onLight />
        <SelectChip
          label="Block"
          value={item.block_name ?? "unclassified"}
          options={blockOptions}
          disabled={busy}
          onLight
          onChange={(v) => void run(() => actions.reclassify(item.id, { block_name: v }), false)}
        />
        <SelectChip
          label="Status"
          value={item.status}
          options={STATUSES.map((s) => [s, STATUS_CHIP[s]] as const)}
          disabled={busy}
          onLight
          onChange={(v) =>
            void run(() => actions.reclassify(item.id, { status: v as AssertionStatus }), false)
          }
        />
        <SelectChip
          label="Sensitivity"
          value={item.sensitivity}
          options={SENSITIVITIES_OPTIONS}
          disabled={busy}
          onLight
          onChange={(v) =>
            void run(() => actions.reclassify(item.id, { sensitivity: v as Sensitivity }), false)
          }
        />
        <Chip tone={item.scope === "session" ? "alert" : "neutral"} onLight>
          {SCOPE_LABEL[item.scope]}
        </Chip>
        <Chip onLight className="tnum">
          {Math.round(item.confidence * 100)}% conf
        </Chip>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-body-sm text-danger-ink">
          {error}
        </p>
      )}
      {corrected && (
        <p role="status" className="mt-2 text-body-sm text-ink-muted">
          Reclassified. Still yours to keep or discard.
        </p>
      )}

      {/* All four actions at ≥44px (§4.2). Keep is the only primary. */}
      <div className="mt-4 flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button
              variant="primary"
              disabled={busy || !draft.trim()}
              onClick={() =>
                run(async () => {
                  // Two calls rather than one PATCH, because the hook exposes
                  // the two operations the vocabulary names — correcting the
                  // wording and correcting the status are different acts, and
                  // each gets its own announcement.
                  if (status !== item.status) {
                    await actions.reclassify(item.id, { status });
                  }
                  await actions.editContent(item.id, draft.trim());
                })
              }
            >
              <Check className="size-4" aria-hidden="true" />
              Save and keep
            </Button>
            <Button
              variant="outlineInk"
              disabled={busy}
              onClick={() => {
                setDraft(item.content);
                setStatus(item.status);
                setEditing(false);
              }}
            >
              <Undo2 className="size-4" aria-hidden="true" />
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => run(() => actions.accept(item.id))}
            >
              <Check className="size-4" aria-hidden="true" />
              Keep
            </Button>
            <Button
              variant="outlineInk"
              disabled={busy}
              onClick={() => run(() => actions.reject(item.id))}
            >
              <X className="size-4" aria-hidden="true" />
              Discard
            </Button>
            <Button
              variant="outlineInk"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-4" aria-hidden="true" />
              Edit
            </Button>
            <Button
              variant="outlineInk"
              disabled={busy}
              onClick={() =>
                run(() =>
                  actions.rescope(
                    item.id,
                    item.scope === "session" ? "persistent" : "session",
                  ),
                )
              }
            >
              {/* "Only this chat", not "Session only": §13 requires the label to
                  name the consequence, and it must match the wording the action
                  bar and the bulk actions already use for the same operation. */}
              {item.scope === "session" ? "Keep beyond this chat" : "Only this chat"}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

const SENSITIVITIES_OPTIONS = (
  ["low", "medium", "high", "special_category"] as Sensitivity[]
).map((s) => [s, SENSITIVITY_LABEL[s]] as const);
