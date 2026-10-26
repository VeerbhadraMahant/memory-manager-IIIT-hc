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
import { Bot, Check, ChevronRight, Pencil, PenLine, Undo2, X } from "lucide-react";

import {
  SCOPE_LABEL,
  SENSITIVITY_LABEL,
  type AssertionStatus,
  type EdgeProposal,
  type MemoryItem,
  type Sensitivity,
} from "@/lib/api";
import { useMemoryActions, useMemoryStore } from "@/lib/memory-store";
import {
  FALLBACK_BLOCKS,
  ORIGIN,
  STATUSES,
  STATUS_CHIP,
  blockLabel,
  premisesOf,
} from "@/lib/semantics";
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
        "sticky bottom-2 z-20 sm:static sm:z-auto",
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
                        void actions
                          .reject(it.id)
                          .then(() => onResolved(it.id))
                          .catch(() => undefined) // item stays listed, so the user can retry
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
                          .catch(() => undefined)
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

export { PendingItem as ReviewItem };

function PendingItem({
  item,
  onResolved,
  queue,
}: {
  item: MemoryItem;
  onResolved: (id: string) => void;
  /** F11: set by the review queue. Makes the row a focus target that answers
   *  single keys, but only while the row itself (not a control inside it) has
   *  focus, so the keys cannot collide with typing or screen-reader commands. */
  queue?: { onNavigate: (step: 1 | -1) => void; helpId: string };
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

  // In the queue, choosing a scope is also the decision to keep: rescoping alone
  // leaves the item pending, and the queue would bring it straight back.
  const scopeAndResolve = async (scope: "session" | "persistent") => {
    await actions.rescope(item.id, scope);
    if (queue) await actions.accept(item.id);
  };

  const onQueueKey = (e: React.KeyboardEvent<HTMLLIElement>) => {
    if (!queue || e.target !== e.currentTarget) return;
    if (e.ctrlKey || e.metaKey || e.altKey || busy || editing) return;
    const k = e.key.toLowerCase();
    const go = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowRight") go(() => queue.onNavigate(1));
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") go(() => queue.onNavigate(-1));
    else if (k === "k") go(() => void run(() => actions.accept(item.id)));
    else if (k === "d") go(() => void run(() => actions.reject(item.id)));
    else if (k === "e") go(() => setEditing(true));
    else if (k === "t" && item.scope !== "session")
      go(() => void run(() => scopeAndResolve("session")));
  };

  return (
    <li
      className="px-4 py-4"
      {...(queue
        ? {
            tabIndex: 0,
            "data-queue-item": "",
            "aria-label": "Memory to review",
            "aria-describedby": queue.helpId,
            "aria-keyshortcuts": "K D E T ArrowDown ArrowUp",
            onKeyDown: onQueueKey,
          }
        : {})}
    >
      {editing ? (
        <div className="space-y-3">
          <label className="block">
            <span className="meta mb-1 block text-ink-muted">Memory text</span>
            <textarea
              ref={textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              className="w-full rounded-input border border-outline-ink bg-sunken p-3 text-body-md text-ink"
            />
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <span className="meta text-ink-muted">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AssertionStatus)}
              className="min-h-11 rounded-input border border-outline-ink bg-sunken px-3 text-body-sm text-ink"
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

      <MemoryInsights item={item} onDone={onResolved} />

      {/* P2 one-tap correction: the chips that *show* the classification are the
          controls that change it. Native selects — one interaction, keyboard
          operable, screen-reader labelled without a line of ARIA. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <SourceChip source={item.source_type} onLight />
        <OriginTag origin={item.content_origin} onLight />
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
                  scopeAndResolve(item.scope === "session" ? "persistent" : "session"),
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

/** F9: who worded the stored text. Text plus glyph, never colour alone; renders
 *  nothing when the origin is unknown. */
export function OriginTag({
  origin,
  onLight,
}: {
  origin: MemoryItem["content_origin"];
  onLight?: boolean;
}) {
  if (!origin) return null;
  const enc = ORIGIN[origin];
  const Icon = enc.glyph === "bot" ? Bot : enc.glyph === "pencil" ? Pencil : PenLine;
  return (
    <Chip onLight={onLight}>
      <Icon className="size-3" aria-hidden="true" />
      {enc.label}
    </Chip>
  );
}

/**
 * F4, F7, F8 for one memory, shared by the review card, the list row and the
 * graph's detail panel so the three surfaces cannot drift apart (section 2
 * parity). Everything goes through useMemoryActions().
 */
export function MemoryInsights({
  item,
  onLight = true,
  onDone,
}: {
  item: MemoryItem;
  onLight?: boolean;
  onDone?: (id: string) => void;
}) {
  const { graph, proposals } = useMemoryStore();
  const mine = proposals.filter(
    (p) => p.from_item_id === item.id || p.to_item_id === item.id,
  );
  const premises = item.source_type === "inferred" ? premisesOf(graph, item.id) : [];
  const offerAbstract =
    item.review_state === "pending" &&
    item.status === "third_party" &&
    !!item.abstracted &&
    item.abstracted !== item.content;
  if (!mine.length && !premises.length && !offerAbstract) return null;

  const ink = onLight ? "text-ink" : "text-ink-invert";
  const muted = onLight ? "text-ink-muted" : "text-ink-invert-muted";

  return (
    <div className="mt-3 space-y-3">
      {premises.length > 0 && (
        <p className={cn("text-body-sm", muted)}>
          <span className="meta">Inferred from:</span>{" "}
          {premises.map((c, i) => (
            <span key={i} className={ink}>
              {i > 0 && "; "}&ldquo;{c}&rdquo;
            </span>
          ))}
        </p>
      )}
      {mine.map((p) => (
        <ProposalPrompt key={p.id} item={item} proposal={p} onLight={onLight} />
      ))}
      {offerAbstract && <AbstractedChoice item={item} onLight={onLight} onDone={onDone} />}
    </div>
  );
}

function useGuarded() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "that did not go through");
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, go };
}

function ProposalPrompt({
  item,
  proposal: p,
  onLight,
}: {
  item: MemoryItem;
  proposal: EdgeProposal;
  onLight: boolean;
}) {
  const actions = useMemoryActions();
  const { busy, error, go } = useGuarded();
  const variant = onLight ? "outlineInk" : "outline";
  const ink = onLight ? "text-ink" : "text-ink-invert";
  const muted = onLight ? "text-ink-muted" : "text-ink-invert-muted";
  const isTo = p.to_item_id === item.id;
  const other = isTo ? p.from_content : p.to_content;
  const updates = p.relation === "updates";
  const contradicts = p.relation === "contradicts";

  const heading = updates
    ? isTo
      ? "This looks like it updates an earlier memory."
      : "A newer memory may replace this one."
    : contradicts
      ? "This looks like it contradicts another memory."
      : "This looks related to another memory.";

  const decide = (state: "confirmed" | "rejected") =>
    void go(() => actions.decideEdge(p.id, state));

  return (
    <div
      role="group"
      aria-label={`Suggested link: ${heading}`}
      className={cn(
        "rounded-input border p-3",
        onLight ? "border-outline-ink" : "border-outline",
      )}
    >
      <p className={cn("text-body-sm font-medium", ink)}>{heading}</p>
      <dl className={cn("mt-1 space-y-1 text-body-sm", muted)}>
        {updates ? (
          <>
            <div>
              <dt className="meta inline">Older:</dt>{" "}
              <dd className="inline">&ldquo;{p.from_content}&rdquo;</dd>
            </div>
            <div>
              <dt className="meta inline">Newer:</dt>{" "}
              <dd className="inline">&ldquo;{p.to_content}&rdquo;</dd>
            </div>
          </>
        ) : (
          <div>
            <dt className="meta inline">Other memory:</dt>{" "}
            <dd className="inline">&ldquo;{other}&rdquo;</dd>
          </div>
        )}
      </dl>
      <div className="mt-2 flex flex-wrap gap-2">
        {updates && (
          <Button variant={variant} size="sm" disabled={busy} onClick={() => decide("rejected")}>
            Keep both
          </Button>
        )}
        <Button variant={variant} size="sm" disabled={busy} onClick={() => decide("confirmed")}>
          {updates ? "Replace the older one" : contradicts ? "Record the conflict" : "Link them"}
        </Button>
        <Button variant={variant} size="sm" disabled={busy} onClick={() => decide("rejected")}>
          Not related
        </Button>
      </div>
      <p className={cn("mt-2 text-body-sm", muted)}>
        {updates
          ? "Replace: the older fact stays stored but stops being used in answers. Keep both: both are still used."
          : contradicts
            ? "Recording the conflict removes nothing; both stay stored."
            : "Linking them removes nothing."}{" "}
        Not related: nothing is linked and this is not suggested again.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-body-sm text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}

function AbstractedChoice({
  item,
  onLight,
  onDone,
}: {
  item: MemoryItem;
  onLight: boolean;
  onDone?: (id: string) => void;
}) {
  const actions = useMemoryActions();
  const { busy, error, go } = useGuarded();
  const variant = onLight ? "outlineInk" : "outline";
  const muted = onLight ? "text-ink-muted" : "text-ink-invert-muted";
  const finish = (fn: () => Promise<unknown>) =>
    void go(async () => {
      await fn();
      onDone?.(item.id);
    });

  return (
    <div
      role="group"
      aria-label="This is about someone else"
      className={cn(
        "rounded-input border p-3",
        onLight ? "border-outline-ink" : "border-outline",
      )}
    >
      <p className={cn("text-body-sm", onLight ? "text-ink" : "text-ink-invert")}>
        This is about someone who cannot see or remove it. A less identifying
        version is available.
      </p>
      <p className={cn("mt-1 text-body-sm", muted)}>
        <span className="meta">Less identifying:</span> &ldquo;{item.abstracted}&rdquo;
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant={variant}
          size="sm"
          disabled={busy}
          onClick={() => finish(() => actions.accept(item.id))}
        >
          Keep the specific version
        </Button>
        <Button
          variant={variant}
          size="sm"
          disabled={busy}
          onClick={() =>
            finish(() => actions.editContent(item.id, item.abstracted ?? item.content))
          }
        >
          Keep the less identifying version
        </Button>
        <Button
          variant={variant}
          size="sm"
          disabled={busy}
          onClick={() => finish(() => actions.reject(item.id))}
        >
          Do not keep
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-body-sm text-danger-ink">
          {error}
        </p>
      )}
    </div>
  );
}
