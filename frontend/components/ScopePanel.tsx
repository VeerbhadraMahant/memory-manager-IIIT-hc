"use client";

// What this session can and cannot reach.
//
// "Session-only" is otherwise an invisible promise — the user is told something is
// confined and has no way to see it. This panel makes the boundary countable, and
// names what is out of reach rather than just omitting it. Showing the *titles* of
// hidden memories to their own owner is not a leak: they are the user's memories.
// The point is that this session cannot use them, not that they are secret from you.

import { useState } from "react";
import { api, type ScopeReport } from "@/lib/api";

export function ScopePanel({
  report,
  onChanged,
}: {
  report: ScopeReport | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [purged, setPurged] = useState<number | null>(null);

  if (!report) return null;

  const clean = report.items_from_ephemeral_turns_global === 0;

  return (
    <section
      aria-label="What this session can see"
      className="mb-4 rounded border border-neutral-200 p-2.5 dark:border-neutral-800"
    >
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
        This session
      </h2>

      <dl className="space-y-1 text-xs">
        <Row label="Can use" value={`${report.visible_persistent + report.visible_session}`} />
        <Row label="— remembered" value={`${report.visible_persistent}`} dim />
        <Row label="— this chat only" value={`${report.visible_session}`} dim />
        <Row
          label="Out of reach here"
          value={`${report.hidden_session_items.length}`}
          highlight={report.hidden_session_items.length > 0}
        />
      </dl>

      {report.hidden_session_items.length > 0 && (
        <ul className="mt-2 space-y-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          {report.hidden_session_items.slice(0, 5).map((h) => (
            <li key={h.id} className="text-[11px] text-neutral-500">
              <span className="line-through decoration-neutral-400">{h.content}</span>
              <span className="mt-0.5 block text-neutral-400">
                confined to &ldquo;{h.origin_chat_title ?? "another chat"}&rdquo;
              </span>
            </li>
          ))}
          {report.hidden_session_items.length > 5 && (
            <li className="text-[11px] text-neutral-400">
              +{report.hidden_session_items.length - 5} more
            </li>
          )}
        </ul>
      )}

      <p
        className={
          "mt-2 border-t pt-2 text-[11px] " +
          (clean
            ? "border-neutral-200 text-neutral-500 dark:border-neutral-800"
            : "border-red-300 text-red-700 dark:border-red-900 dark:text-red-400")
        }
      >
        <strong className="font-mono">
          {report.items_from_ephemeral_turns_global}
        </strong>{" "}
        memories derived from off-the-record turns, database-wide.
        {!clean && " This should be 0 — something is wrong."}
      </p>

      {report.ephemeral_turns > 0 && (
        <div className="mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          <p className="text-[11px] text-neutral-500">
            {report.ephemeral_turns} off-the-record{" "}
            {report.ephemeral_turns === 1 ? "turn" : "turns"} in this chat. Nothing was
            extracted from them, but the text is still in this transcript.
          </p>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await api.purgeEphemeral(report.chat_id);
                setPurged(r.redacted_turns);
                onChanged();
              } finally {
                setBusy(false);
              }
            }}
            className="mt-1.5 rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Redact them from the transcript too
          </button>
          {purged !== null && (
            <p role="status" className="mt-1 text-[11px] text-neutral-500">
              Redacted {purged}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Row({
  label,
  value,
  dim,
  highlight,
}: {
  label: string;
  value: string;
  dim?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between gap-2">
      <dt className={dim ? "text-neutral-400" : "text-neutral-600 dark:text-neutral-400"}>
        {label}
      </dt>
      <dd
        className={
          "font-mono tabular-nums " +
          (highlight ? "text-amber-700 dark:text-amber-400" : "")
        }
      >
        {value}
      </dd>
    </div>
  );
}
