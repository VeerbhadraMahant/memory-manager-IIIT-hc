"use client";

// P6 stake-proportional verification.
//
// The draft is shown, but every claim that rests on a memory is broken out with
// the memory behind it and how complete the sentence made it sound. Claims that
// say more than the memory supports are marked and must be dealt with before the
// text is treated as ready.
//
// The comparison is done server-side in Python against the stored status, not by
// asking the model whether it overstated — a model grading its own accuracy is
// the check that fails quietly, and this is the exact failure the project exists
// to stop (D34, and CLAUDE.md's test constraints).
//
// Restyled onto the §1 tokens. The two states are distinguished by more than
// colour: the heading text says which one it is, and flagged claims carry an
// icon (§7 / WCAG 1.4.1).

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { api, STATUS_LABEL, type AssertionStatus, type VerifiedDraft } from "@/lib/api";
import { useMemoryActions, useMemoryStore } from "@/lib/memory-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";

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
      className={cn(
        "on-surface my-3 overflow-hidden rounded-card bg-surface text-ink",
        draft.needs_confirmation ? "border-t-4 border-t-danger" : "border-t-4 border-t-stated",
      )}
    >
      <h3 className="flex items-center gap-2 border-b border-outline-ink px-4 py-3">
        {draft.needs_confirmation ? (
          <AlertTriangle className="size-4 shrink-0 text-danger-ink" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-stated-ink" aria-hidden="true" />
        )}
        <span className="meta text-ink-muted">
          {draft.needs_confirmation
            ? `high-stakes draft — ${flagged.length} claim${flagged.length === 1 ? "" : "s"} to check`
            : "high-stakes draft — every claim matches its memory"}
        </span>
      </h3>

      <div className="px-4 py-4">
        <p className="measure whitespace-pre-wrap rounded-input border border-outline-ink bg-ink-invert/[0.04] p-3 text-body-md text-ink">
          {draft.draft}
        </p>

        {flagged.length > 0 && (
          <ul className="mt-4 space-y-2">
            {flagged.map((c, i) => (
              <ClaimRow key={i} claim={c} onConfirmed={onConfirmed} flagged />
            ))}
          </ul>
        )}

        {clean.length > 0 && (
          <details className="mt-4">
            <summary className="tap meta cursor-pointer rounded-input text-ink-muted">
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
          <p className="mt-4 text-body-sm text-ink-muted">
            Nothing in this draft rests on a stored memory.
          </p>
        )}
      </div>
    </section>
  );
}

const STAND_CHOICES: AssertionStatus[] = ["in_progress", "planned", "completed", "abandoned"];

/** F10. Replaces one-click confirm for an overstated claim: confirming "still true"
 *  would bless the wrong status, so the user states the real one. The edit goes to the
 *  memory through the existing PATCH; the claim is then marked resolved by the user.
 *  The server has NOT re-run its overstatement check at that point, and the copy says so. */
function StandChoice({
  source,
  onResolved,
}: {
  source: VerifiedDraft["claims"][number]["sources"][number];
  onResolved: (status: AssertionStatus) => void;
}) {
  const { refresh, announce } = useMemoryStore();
  const [choice, setChoice] = useState<AssertionStatus>(source.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (choice !== source.status) await api.edit(source.id, { status: choice });
      await refresh();
      announce(`Memory status set to ${STATUS_LABEL[choice]}.`);
      onResolved(choice);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save that");
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="mt-2 rounded-input border border-outline-ink p-2" disabled={busy}>
      <legend className="meta px-1 text-ink-muted">Where does this actually stand?</legend>
      <p className="text-body-sm text-ink-muted">{source.content}</p>
      <div className="mt-1 flex flex-wrap gap-x-4">
        {STAND_CHOICES.map((st) => (
          <label key={st} className="tap flex cursor-pointer items-center gap-1.5 text-body-sm text-ink">
            <input
              type="radio"
              name={`stand-${source.id}`}
              checked={choice === st}
              onChange={() => setChoice(st)}
              className="size-4"
            />
            {STATUS_LABEL[st]}
          </label>
        ))}
      </div>
      <Button variant="outlineInk" size="sm" className="mt-2" onClick={() => void save()}>
        {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
        {choice === source.status
          ? "Keep it as it is and mark resolved"
          : `Save as ${STATUS_LABEL[choice]} and mark resolved`}
      </Button>
      {error && (
        <p role="alert" className="mt-1 text-body-sm text-danger-ink">
          {error}
        </p>
      )}
    </fieldset>
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
  const actions = useMemoryActions();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [resolvedAs, setResolvedAs] = useState<AssertionStatus | null>(null);

  return (
    <li
      className={cn(
        "rounded-input border p-3",
        flagged ? "border-danger bg-danger-dim" : "border-outline-ink",
      )}
    >
      <p className="measure text-body-sm text-ink">&ldquo;{claim.text}&rdquo;</p>

      {claim.problem && (
        <p className="mt-1.5 flex items-start gap-1.5 text-body-sm font-medium text-danger-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {claim.problem}
        </p>
      )}

      <ul className="mt-2 space-y-1.5">
        {claim.sources.map((s) => (
          <li key={s.id} className="text-body-sm text-ink-muted">
            <span className="meta mr-1.5">from memory</span>
            {s.content}
            <span className="ml-1.5 inline-flex flex-wrap items-center gap-1.5 align-middle">
              <Chip onLight>{STATUS_LABEL[s.status]}</Chip>
              {s.is_stale && (
                <Chip tone="danger" onLight>
                  not confirmed recently
                </Chip>
              )}
            </span>
          </li>
        ))}
      </ul>

      {flagged && !done && !claim.overstates && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {claim.sources
            .filter((s) => s.is_stale)
            .map((s) => (
              <Button
                key={s.id}
                variant="outlineInk"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await actions.confirm(s.id);
                    setDone(true);
                    onConfirmed();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                Still true — confirm it
              </Button>
            ))}
        </div>
      )}

      {/* Overstated claims get the guided choice; the stale-source confirm above stays
          for claims that are only stale. A claim can be both: stating the real status
          also settles it, so the one-click confirm is not offered for overstated claims. */}
      {flagged && !done && claim.overstates && resolvedAs === null &&
        claim.sources.map((s) => (
          <StandChoice key={s.id} source={s} onResolved={(st) => {
            setResolvedAs(st);
            onConfirmed();
          }}
        />
        ))}

      {resolvedAs !== null && (
        <p role="status" className="mt-2 text-body-sm text-ink-muted">
          Marked resolved by you: the memory now says {STATUS_LABEL[resolvedAs]}. The
          server has not re-checked this draft&rsquo;s wording against it; ask for the
          draft again to run that check.
        </p>
      )}

      {done && (
        <p role="status" className="mt-2 text-body-sm text-ink-muted">
          Confirmed. Ask for the draft again to re-check it.
        </p>
      )}
    </li>
  );
}
