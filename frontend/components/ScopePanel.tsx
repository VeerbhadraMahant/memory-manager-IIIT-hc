"use client";

// What this session can and cannot reach.
//
// "Session-only" is otherwise an invisible promise — the user is told something
// is confined and has no way to see it. This panel makes the boundary countable,
// and names what is out of reach rather than just omitting it. Showing the
// titles of hidden memories to their own owner is not a leak: they are the
// user's memories. The point is that this session cannot use them, not that they
// are secret from you.
//
// Restyled onto the §1 tokens; the numbers are .tnum so a count changing does
// not reflow the row it sits in.

import { useState } from "react";
import { EyeOff, Layers, Loader2 } from "lucide-react";

import { api, type ScopeReport } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

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
      className="rounded-card border border-outline bg-raised p-4"
    >
      <h2 className="meta mb-3 flex items-center gap-1.5 text-ink-invert-muted">
        <Layers className="size-4" aria-hidden="true" />
        This session
      </h2>

      {/* "Can use in this session", not "Can use" — the workspace header counts
          the whole store, and two unlabelled totals side by side read as a
          counting bug instead of as scoping working. */}
      <dl className="space-y-1.5">
        <Row
          label="Can use in this session"
          value={report.visible_persistent + report.visible_session}
        />
        <Row label="— remembered" value={report.visible_persistent} dim />
        <Row label="— this chat only" value={report.visible_session} dim />
        <Row
          label="Out of reach here"
          value={report.hidden_session_items.length}
          highlight={report.hidden_session_items.length > 0}
        />
      </dl>

      {report.hidden_session_items.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-outline pt-3">
          {report.hidden_session_items.slice(0, 5).map((h) => (
            <li key={h.id} className="flex items-start gap-2">
              <EyeOff
                aria-hidden="true"
                className="mt-0.5 size-3.5 shrink-0 text-ink-invert-muted"
              />
              <span>
                {/* Strikethrough already says "not available here". Dropping the
                    contrast as well put this under the 4.5:1 floor for the one
                    thing on the panel that has to be readable — the memory the
                    user is being told they cannot reach. */}
                <span className="block text-body-sm text-ink-invert line-through decoration-[color:var(--danger)] decoration-2">
                  {h.content}
                </span>
                <span className="meta text-ink-invert-muted">
                  confined to {h.origin_chat_title ?? "another chat"}
                </span>
              </span>
            </li>
          ))}
          {report.hidden_session_items.length > 5 && (
            <li className="meta tnum text-ink-invert-muted">
              +{report.hidden_session_items.length - 5} more
            </li>
          )}
        </ul>
      )}

      {/* The leak counter. It is on screen rather than in a test log because a
          number that is supposed to be zero is only reassuring if you can watch
          it stay zero (P3). */}
      <p
        className={cn(
          "mt-3 border-t pt-3 text-body-sm",
          clean
            ? "border-outline text-ink-invert-muted"
            : "border-danger text-danger-on-bg",
        )}
      >
        <span className="meta tnum">
          {report.items_from_ephemeral_turns_global}
        </span>{" "}
        memories derived from off-the-record turns, database-wide.
        {!clean && " This should be 0 — something is wrong."}
      </p>

      {report.ephemeral_turns > 0 && (
        <div className="mt-3 border-t border-outline pt-3">
          <p className="text-body-sm text-ink-invert-muted">
            <span className="tnum">{report.ephemeral_turns}</span> off-the-record{" "}
            {report.ephemeral_turns === 1 ? "turn" : "turns"} in this chat. Nothing
            was extracted from them, but the text is still in this transcript.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
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
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
            Redact them from the transcript too
          </Button>
          {purged !== null && (
            <p role="status" className="mt-2 text-body-sm text-ink-invert-muted">
              Redacted <span className="tnum">{purged}</span>.
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
  value: number;
  dim?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt
        // `dim` used to add opacity-70, which took --ink-invert-muted from
        // 4.76:1 to about 3.5:1. Hierarchy is carried by the indent and the em
        // dash instead; nothing on this panel goes under the floor.
        className={cn("text-body-sm text-ink-invert-muted", dim && "pl-3")}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "meta tnum",
          highlight ? "text-alert-ink" : "text-ink-invert",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
