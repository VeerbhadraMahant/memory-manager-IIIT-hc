"use client";

// The review card. Memory formation is an in-conversation event (D1), so this
// renders inline in the transcript, directly under the turn it came from.
//
// Two groups, deliberately styled differently:
//   - auto-accepted: reported, collapsed, no action required. The interruption
//     budget (principle 2) is about not *asking*, not about hiding.
//   - pending: asked about, one card each, with the reason stated.
//
// Wording follows principle 5 — consequence, not caution. "Kept for this chat only"
// states what happens. "Are you sure?" would just transfer anxiety.

import { useState } from "react";
import {
  api,
  SCOPE_LABEL,
  SENSITIVITY_LABEL,
  STATUS_LABEL,
  type AssertionStatus,
  type MemoryItem,
  type Sensitivity,
} from "@/lib/api";

const STATUSES: AssertionStatus[] = [
  "in_progress",
  "completed",
  "planned",
  "abandoned",
  "hypothetical",
  "third_party",
];

const SENSITIVITIES: Sensitivity[] = ["low", "medium", "high", "special_category"];

// Mirrors migration 002. Fetching these would be more correct; hardcoding keeps the
// review card synchronous, which matters because it renders mid-conversation.
const blocks = ["unclassified", "health", "family", "learning", "work"];

export function ReviewCard({
  pending,
  autoAccepted,
  onResolved,
}: {
  pending: MemoryItem[];
  autoAccepted: MemoryItem[];
  onResolved: (id: string) => void;
}) {
  const [showAuto, setShowAuto] = useState(false);

  if (pending.length === 0 && autoAccepted.length === 0) return null;

  return (
    <section
      aria-label="New memories from this turn"
      className="my-3 ml-0 sm:ml-10 rounded-lg border border-amber-300/70 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/5"
    >
      <h3 className="border-b border-amber-300/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-amber-900 dark:border-amber-500/20 dark:text-amber-200">
        From this turn
      </h3>

      {autoAccepted.length > 0 && (
        <div className="border-b border-amber-300/40 px-4 py-2.5 dark:border-amber-500/20">
          <button
            onClick={() => setShowAuto((v) => !v)}
            aria-expanded={showAuto}
            className="flex w-full items-center gap-2 text-left text-sm text-neutral-700 hover:text-neutral-950 dark:text-neutral-300 dark:hover:text-neutral-50"
          >
            <span aria-hidden="true" className="text-xs">
              {showAuto ? "▾" : "▸"}
            </span>
            <span>
              {autoAccepted.length} remembered without asking
            </span>
            <span className="ml-auto text-xs text-neutral-500">
              {showAuto ? "hide" : "show"}
            </span>
          </button>

          {showAuto && (
            <ul className="mt-2 space-y-2">
              {autoAccepted.map((it) => (
                <li
                  key={it.id}
                  className="rounded border border-neutral-200 bg-white/70 p-2.5 text-sm dark:border-neutral-800 dark:bg-neutral-900/50"
                >
                  <p>{it.content}</p>
                  <p className="mt-1 text-xs text-neutral-500">
                    {it.review_reason}
                  </p>
                  <div className="mt-1.5 flex gap-3">
                    <button
                      onClick={() =>
                        api.reject(it.id).then(() => onResolved(it.id))
                      }
                      className="text-xs text-neutral-600 underline underline-offset-2 hover:text-red-700 dark:text-neutral-400 dark:hover:text-red-400"
                    >
                      Forget this
                    </button>
                    <button
                      onClick={() =>
                        api.rescope(it.id, "session").then(() => onResolved(it.id))
                      }
                      className="text-xs text-neutral-600 underline underline-offset-2 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-100"
                    >
                      Only this chat
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {pending.length > 0 && (
        <ul className="divide-y divide-amber-300/40 dark:divide-amber-500/20">
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content);
  const [status, setStatus] = useState<AssertionStatus>(item.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [corrected, setCorrected] = useState<string | null>(null);

  /** `resolve` false keeps the card open — a reclassification is a correction, not a
   *  decision to keep, and dismissing the card would rob the user of the accept step. */
  const run = async (fn: () => Promise<unknown>, resolve = true) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (resolve) {
        onResolved(item.id);
      } else {
        setCorrected("corrected");
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      setBusy(false);
    }
  };

  return (
    <li className="px-4 py-3">
      {editing ? (
        <div className="space-y-2">
          <label className="block">
            <span className="sr-only">Memory text</span>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              autoFocus
              className="w-full rounded border border-neutral-300 bg-white p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-neutral-600 dark:text-neutral-400">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AssertionStatus)}
              className="rounded border border-neutral-300 bg-white px-1.5 py-1 dark:border-neutral-700 dark:bg-neutral-900"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : (
        <>
          <p className="text-sm">{item.content}</p>
          {item.evidence && (
            <p className="mt-1 border-l-2 border-neutral-300 pl-2 text-xs italic text-neutral-500 dark:border-neutral-700">
              &ldquo;{item.evidence}&rdquo;
            </p>
          )}
        </>
      )}

      <p className="mt-2 text-xs text-amber-900/80 dark:text-amber-200/70">
        {item.review_reason}
      </p>

      {/* P2 one-tap correction. Misclassification has to be fixable where it is
          visible, not in a separate view — so the chips that *show* the
          classification are the controls that change it. Native selects: one
          interaction, keyboard-operable, and screen-reader labelled for free. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        <SelectChip
          label="Block"
          value={item.block_name ?? "unclassified"}
          options={blocks.map((b) => [b, b])}
          disabled={busy}
          onChange={(v) => run(() => api.edit(item.id, { block_name: v }), false)}
        />
        <SelectChip
          label="Status"
          value={item.status}
          options={STATUSES.map((s) => [s, STATUS_LABEL[s]])}
          disabled={busy}
          onChange={(v) =>
            run(() => api.edit(item.id, { status: v as AssertionStatus }), false)
          }
        />
        <SelectChip
          label="Sensitivity"
          value={item.sensitivity}
          options={SENSITIVITIES.map((s) => [s, SENSITIVITY_LABEL[s]])}
          disabled={busy}
          onChange={(v) =>
            run(() => api.edit(item.id, { sensitivity: v as Sensitivity }), false)
          }
        />
        <Chip>{item.source_type}</Chip>
        <Chip highlight={item.scope === "session"}>{SCOPE_LABEL[item.scope]}</Chip>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {corrected && (
        <p role="status" className="mt-1.5 text-[11px] text-neutral-500">
          Reclassified. Still yours to keep or discard.
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap gap-2">
        {editing ? (
          <>
            <Action
              primary
              disabled={busy}
              onClick={() =>
                run(() =>
                  api.edit(item.id, {
                    content: draft,
                    ...(status !== item.status ? { status } : {}),
                  }),
                )
              }
            >
              Save and keep
            </Action>
            <Action disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </Action>
          </>
        ) : (
          <>
            <Action
              primary
              disabled={busy}
              onClick={() => run(() => api.accept(item.id))}
            >
              Keep
            </Action>
            <Action disabled={busy} onClick={() => run(() => api.reject(item.id))}>
              Discard
            </Action>
            <Action disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Action>
            <Action
              disabled={busy}
              onClick={() =>
                run(() =>
                  api.rescope(
                    item.id,
                    item.scope === "session" ? "persistent" : "session",
                  ),
                )
              }
            >
              {item.scope === "session" ? "Keep beyond this chat" : "Only this chat"}
            </Action>
          </>
        )}
      </div>
    </li>
  );
}

function SelectChip({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="inline-flex items-center rounded bg-neutral-200/70 dark:bg-neutral-800">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer appearance-none bg-transparent px-1.5 py-0.5 text-[11px] text-neutral-700 outline-none focus:ring-1 focus:ring-neutral-500 disabled:opacity-40 dark:text-neutral-300"
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function Chip({
  children,
  highlight,
}: {
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <span
      className={
        highlight
          ? "rounded bg-amber-200/80 px-1.5 py-0.5 font-medium text-amber-950 dark:bg-amber-400/20 dark:text-amber-100"
          : "rounded bg-neutral-200/70 px-1.5 py-0.5 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      }
    >
      {children}
    </span>
  );
}

function Action({
  children,
  onClick,
  disabled,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={
        "rounded px-2.5 py-1 text-xs font-medium transition disabled:opacity-40 " +
        (primary
          ? "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          : "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800")
      }
    >
      {children}
    </button>
  );
}
