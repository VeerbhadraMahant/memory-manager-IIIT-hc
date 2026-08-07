"use client";

// P6 stake-proportional verification.
//
// The draft is shown, but every claim that rests on a memory is broken out with the
// memory behind it and how complete the sentence made it sound. Claims that say more
// than the memory supports are marked and must be dealt with before the text is
// treated as ready.
//
// The comparison is done server-side in Python against the stored status, not by
// asking the model whether it overstated — a model grading its own accuracy is the
// check that fails quietly, and this is the exact failure the project exists to stop.

import { useState } from "react";
import {
  api,
  STATUS_LABEL,
  type VerifiedDraft,
} from "@/lib/api";

export function DraftPanel({
  draft,
  onConfirmed,
}: {
  draft: VerifiedDraft;
  onConfirmed: () => void;
}) {
  const flagged = draft.claims.filter((c) => c.overstates || c.stale_source);
  const clean = draft.claims.filter(
    (c) => c.sources.length > 0 && !c.overstates && !c.stale_source,
  );

  return (
    <section
      aria-label="Verified draft"
      className={
        "my-3 rounded-lg border " +
        (draft.needs_confirmation
          ? "border-red-300 bg-red-50/50 dark:border-red-900/60 dark:bg-red-950/20"
          : "border-emerald-300 bg-emerald-50/40 dark:border-emerald-900/60 dark:bg-emerald-950/20")
      }
    >
      <h3
        className={
          "border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide " +
          (draft.needs_confirmation
            ? "border-red-300/60 text-red-900 dark:border-red-900/40 dark:text-red-200"
            : "border-emerald-300/60 text-emerald-900 dark:border-emerald-900/40 dark:text-emerald-200")
        }
      >
        {draft.needs_confirmation
          ? `High-stakes draft — ${flagged.length} claim${flagged.length === 1 ? "" : "s"} need${flagged.length === 1 ? "s" : ""} checking`
          : "High-stakes draft — every claim matches its memory"}
      </h3>

      <div className="px-4 py-3">
        <p className="whitespace-pre-wrap rounded border border-neutral-200 bg-white/70 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900/40">
          {draft.draft}
        </p>

        {flagged.length > 0 && (
          <ul className="mt-3 space-y-2">
            {flagged.map((c, i) => (
              <ClaimRow key={i} claim={c} onConfirmed={onConfirmed} flagged />
            ))}
          </ul>
        )}

        {clean.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200">
              {clean.length} claim{clean.length === 1 ? "" : "s"} checked out
            </summary>
            <ul className="mt-2 space-y-2">
              {clean.map((c, i) => (
                <ClaimRow key={i} claim={c} onConfirmed={onConfirmed} />
              ))}
            </ul>
          </details>
        )}

        {draft.claims.every((c) => c.sources.length === 0) && (
          <p className="mt-3 text-xs text-neutral-500">
            Nothing in this draft rests on a stored memory.
          </p>
        )}
      </div>
    </section>
  );
}

function ClaimRow({
  claim,
  onConfirmed,
  flagged,
}: {
  claim: VerifiedDraft["claims"][number];
  onConfirmed: () => void;
  flagged?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <li
      className={
        "rounded border p-2.5 text-xs " +
        (flagged
          ? "border-red-300 bg-white/60 dark:border-red-900/50 dark:bg-neutral-900/40"
          : "border-neutral-200 dark:border-neutral-800")
      }
    >
      <p className="text-neutral-800 dark:text-neutral-200">
        &ldquo;{claim.text}&rdquo;
      </p>

      {claim.problem && (
        <p className="mt-1 font-medium text-red-800 dark:text-red-300">
          {claim.problem}
        </p>
      )}

      <ul className="mt-1.5 space-y-0.5">
        {claim.sources.map((s) => (
          <li key={s.id} className="text-neutral-500">
            <span className="text-neutral-400">from memory:</span> {s.content}{" "}
            <span className="text-neutral-400">({STATUS_LABEL[s.status]})</span>
            {s.is_stale && (
              <span className="ml-1 text-amber-700 dark:text-amber-400">
                not confirmed recently
              </span>
            )}
          </li>
        ))}
      </ul>

      {flagged && !done && (
        <div className="mt-2 flex flex-wrap gap-2">
          {claim.sources.filter((s) => s.is_stale).map((s) => (
            <button
              key={s.id}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.confirm(s.id);
                  setDone(true);
                  onConfirmed();
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-100 disabled:opacity-40 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Still true — confirm it
            </button>
          ))}
          {claim.overstates && (
            <p className="text-[11px] text-neutral-600 dark:text-neutral-400">
              Fix the wording, or correct the memory&rsquo;s status if the draft is right.
            </p>
          )}
        </div>
      )}

      {done && (
        <p role="status" className="mt-1.5 text-[11px] text-neutral-500">
          Confirmed. Ask for the draft again to re-check it.
        </p>
      )}
    </li>
  );
}
