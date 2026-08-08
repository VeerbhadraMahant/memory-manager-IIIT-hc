"use client";

// What the turn did to memory, as a list of steps instead of a spinner.
//
// Replaces "thinking…" and the five scattered status lines that used to sit around a
// turn (extraction running, nothing-extracted, nothing-worth-remembering, kept to
// session, extraction failed). Those were each true and individually fine, but the
// user had to assemble the story from fragments — and for anything structural they
// had to open the graph, which principle 6 says should never be the only route.
//
// Every step's state and every number below is derived from the turn's real payload:
// `retrieval` comes from services/retrieval.py, and the stored/pending items come
// from the candidates poll. Nothing here is a guess about timing:
//
//   • Retrieval and the answer arrive in one response, so both resolve together.
//     Retrieval is shown "working" during the request because it demonstrably runs
//     first server-side; the answer stays "waiting" rather than claiming to know the
//     LLM call has begun.
//   • The extraction step reflects `extraction_running`, which the server sets — not
//     a client-side timer.
//
// The linking step is the honest one: `memory_edges` is real in the schema and read
// by the deletion cascade, but **nothing writes it** — no pass detects that one
// memory updates or contradicts another. So this reports that plainly rather than
// drawing arrows between memories that the database does not relate.

import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronRight,
  Database,
  EyeOff,
  Loader2,
  Search,
  Unlink,
} from "lucide-react";

import type { CandidatesResponse, MemoryItem, RetrievalTrace } from "@/lib/api";
import { blockLabel } from "@/lib/semantics";
import { cn } from "@/lib/utils";

type State = "waiting" | "working" | "done" | "skipped" | "failed";

/** `finance → wants to buy a BMW`. The arrow is decorative; the row carries a
 *  readable label so a screen reader gets "finance, contains, …" rather than a
 *  glyph with no name. */
function Arrow({
  from,
  to,
  dim,
  trailing,
}: {
  from: string;
  to: string;
  dim?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <li
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
      aria-label={`${from} contains ${to}`}
    >
      <span className="meta shrink-0 text-ink-invert-muted">{from}</span>
      <ArrowRight
        aria-hidden="true"
        className="size-3 shrink-0 translate-y-0.5 text-ink-invert-muted"
      />
      <span
        className={cn(
          "min-w-0 flex-1 text-body-sm",
          dim ? "text-ink-invert-muted" : "text-ink-invert",
        )}
      >
        {to}
      </span>
      {trailing}
    </li>
  );
}

function StateIcon({ state }: { state: State }) {
  if (state === "working")
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden="true" />;
  if (state === "done")
    return <Check className="size-3.5 shrink-0 text-stated-on-bg" aria-hidden="true" />;
  if (state === "failed")
    return <AlertTriangle className="size-3.5 shrink-0 text-danger-on-bg" aria-hidden="true" />;
  if (state === "skipped")
    return <EyeOff className="size-3.5 shrink-0 text-ink-invert-muted" aria-hidden="true" />;
  return (
    <span
      aria-hidden="true"
      className="size-3.5 shrink-0 rounded-full border border-outline-strong"
    />
  );
}

function Step({
  state,
  icon,
  label,
  detail,
  children,
}: {
  state: State;
  icon: React.ReactNode;
  label: string;
  /** One line, always visible. The step has to be readable without expanding. */
  detail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const expandable = !!children;

  const head = (
    <>
      <StateIcon state={state} />
      {icon}
      <span
        className={cn(
          "meta shrink-0",
          state === "waiting" ? "text-ink-invert-muted/60" : "text-ink-invert-muted",
        )}
      >
        {label}
      </span>
      {detail && (
        <span className="min-w-0 flex-1 truncate text-body-sm text-ink-invert-muted">
          {detail}
        </span>
      )}
    </>
  );

  return (
    <li>
      {expandable ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="tap flex w-full items-center gap-1.5 rounded-input px-1 text-left hover:bg-raised"
          >
            {head}
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 text-ink-invert-muted transition-transform duration-[var(--motion-micro)]",
                open && "rotate-90",
              )}
            />
          </button>
          {open && <div className="ml-6 mt-1 space-y-1 border-l border-outline pl-3">{children}</div>}
        </>
      ) : (
        <div className="flex items-center gap-1.5 px-1">{head}</div>
      )}
    </li>
  );
}

export function MemoryTimeline({
  ephemeral,
  reply,
  error,
  retrieval,
  extractionRunning,
  extraction,
  sessionOnlyApplied,
}: {
  ephemeral: boolean;
  reply: string | null;
  error: string | null;
  retrieval: RetrievalTrace | null;
  extractionRunning: boolean;
  extraction: CandidatesResponse | null;
  sessionOnlyApplied: number | null;
}) {
  const inFlight = reply === null && !error;

  // ---- retrieval -----------------------------------------------------------
  const retrievalState: State = retrieval ? "done" : inFlight ? "working" : "waiting";
  const injected = retrieval?.considered.filter(
    (c) => c.verdict === "injected" || c.verdict === "pinned",
  ) ?? [];
  const withheld = retrieval?.considered.filter((c) => c.verdict === "private_block") ?? [];
  const nearMisses = retrieval?.considered.filter((c) => c.verdict === "too_distant") ?? [];

  // ---- extraction ----------------------------------------------------------
  const stored: MemoryItem[] = extraction?.auto_accepted ?? [];
  const pending: MemoryItem[] = extraction?.candidates ?? [];
  const extractionState: State = ephemeral
    ? "skipped"
    : extraction?.status === "failed"
      ? "failed"
      : extraction?.status === "done"
        ? "done"
        : extractionRunning
          ? "working"
          : "waiting";
  const keptState: State =
    ephemeral || extraction?.status === "failed"
      ? "skipped"
      : extraction?.status === "done"
        ? "done"
        : "waiting";

  return (
    <ol
      aria-label="What this turn did to memory"
      className="ml-0 space-y-1 rounded-card border border-outline p-2 sm:ml-10"
    >
      {/* 1 — what memory was searched and what came back */}
      <Step
        state={retrievalState}
        icon={<Search className="size-3.5 shrink-0 text-ink-invert-muted" aria-hidden="true" />}
        label="retrieved"
        detail={
          retrieval
            ? retrieval.embedding_failed
              ? "memory was not searched — the embedding call failed"
              : `${injected.length} of ${retrieval.considered.length} used${
                  withheld.length ? ` · ${withheld.length} withheld` : ""
                }`
            : inFlight
              ? "searching memory…"
              : undefined
        }
      >
        {retrieval && !retrieval.embedding_failed && (
          <>
            {injected.length > 0 && (
              <>
                <p className="meta text-stated-on-bg">used in the answer</p>
                <ul className="space-y-0.5">
                  {injected.map((c) => (
                    <Arrow
                      key={c.id}
                      from={blockLabel(c.block_name ?? "unclassified")}
                      to={c.content}
                      trailing={
                        <span className="meta tnum shrink-0 text-ink-invert-muted">
                          {c.distance.toFixed(2)}
                        </span>
                      }
                    />
                  ))}
                </ul>
              </>
            )}

            {withheld.length > 0 && (
              <>
                <p className="meta mt-1 text-danger-on-bg">
                  withheld — private block, never sent to the model
                </p>
                <ul className="space-y-0.5">
                  {withheld.map((c) => (
                    <Arrow
                      key={c.id}
                      dim
                      from={blockLabel(c.block_name ?? "unclassified")}
                      to={c.content}
                    />
                  ))}
                </ul>
              </>
            )}

            {nearMisses.length > 0 && (
              <>
                <p className="meta mt-1 text-ink-invert-muted">
                  considered, not close enough (cut-off {retrieval.max_distance})
                </p>
                <ul className="space-y-0.5">
                  {nearMisses.slice(0, 5).map((c) => (
                    <Arrow
                      key={c.id}
                      dim
                      from={blockLabel(c.block_name ?? "unclassified")}
                      to={c.content}
                      trailing={
                        <span className="meta tnum shrink-0 text-ink-invert-muted">
                          {c.distance.toFixed(2)}
                        </span>
                      }
                    />
                  ))}
                </ul>
              </>
            )}

            {retrieval.fenced_to_another_chat > 0 && (
              <p className="meta mt-1 text-ink-invert-muted">
                {retrieval.fenced_to_another_chat} fenced to another chat — not
                reachable from here
              </p>
            )}
            {injected.length === 0 && withheld.length === 0 && (
              <p className="text-body-sm text-ink-invert-muted">
                Nothing was close enough to use. This answer drew on no memory.
              </p>
            )}
          </>
        )}
      </Step>

      {/* 2 — the answer itself, so the sequence reads in order */}
      <Step
        state={reply !== null ? "done" : error ? "failed" : "waiting"}
        icon={<ArrowRight className="size-3.5 shrink-0 text-ink-invert-muted" aria-hidden="true" />}
        label="answered"
        detail={error ? "the call failed" : reply !== null ? undefined : "waiting on the model"}
      />

      {/* 3 — reading the turn back for anything worth keeping */}
      <Step
        state={extractionState}
        icon={<Database className="size-3.5 shrink-0 text-ink-invert-muted" aria-hidden="true" />}
        label="read for new facts"
        detail={
          ephemeral
            ? "skipped — this turn was off the record, the extractor never ran"
            : extraction?.status === "failed"
              ? `failed: ${extraction.error}`
              : extraction?.status === "done"
                ? stored.length + pending.length === 0
                  ? "nothing worth remembering from this turn"
                  : `${stored.length + pending.length} found`
                : extractionRunning
                  ? "reading the turn…"
                  : undefined
        }
      />

      {/* 4 — what actually changed in the store, and why */}
      <Step
        state={keptState}
        icon={<Check className="size-3.5 shrink-0 text-ink-invert-muted" aria-hidden="true" />}
        label="pushed to memory"
        detail={
          ephemeral
            ? "nothing — off the record"
            : extraction?.status === "done"
              ? [
                  stored.length ? `${stored.length} kept` : null,
                  pending.length ? `${pending.length} awaiting your review` : null,
                  sessionOnlyApplied ? `${sessionOnlyApplied} kept to this chat only` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "nothing changed"
              : undefined
        }
      >
        {(stored.length > 0 || pending.length > 0) && (
          <>
            {stored.length > 0 && (
              <>
                <p className="meta text-stated-on-bg">kept without interrupting you</p>
                <ul className="space-y-1">
                  {stored.map((i) => (
                    <Arrow
                      key={i.id}
                      from={blockLabel(i.block_name ?? "unclassified")}
                      to={i.content}
                      trailing={
                        // The justification, verbatim from the policy layer — not a
                        // phrase this component composed.
                        i.review_reason ? (
                          <span className="meta w-full text-ink-invert-muted">
                            because: {i.review_reason}
                          </span>
                        ) : undefined
                      }
                    />
                  ))}
                </ul>
              </>
            )}

            {pending.length > 0 && (
              <>
                <p className="meta mt-1 text-alert-ink">waiting for you to decide</p>
                <ul className="space-y-1">
                  {pending.map((i) => (
                    <Arrow
                      key={i.id}
                      dim
                      from={blockLabel(i.block_name ?? "unclassified")}
                      to={i.content}
                      trailing={
                        i.review_reason ? (
                          <span className="meta w-full text-ink-invert-muted">
                            because: {i.review_reason}
                          </span>
                        ) : undefined
                      }
                    />
                  ))}
                </ul>
                <p className="meta mt-1 text-ink-invert-muted">
                  nothing above is retrievable until you keep it
                </p>
              </>
            )}
          </>
        )}
      </Step>

      {/* 5 — the step that has to say "no", because the writer does not exist */}
      {extraction?.status === "done" && stored.length + pending.length > 0 && (
        <Step
          state="skipped"
          icon={<Unlink className="size-3.5 shrink-0 text-ink-invert-muted" aria-hidden="true" />}
          label="linked"
          detail="nothing — provenance edges are not written yet"
        >
          <p className="text-body-sm text-ink-invert-muted">
            The schema has <span className="meta">memory_edges</span> and the deletion
            cascade reads it, but no pass writes one — nothing detects that a new fact
            updates or contradicts an existing one. So these memories are stored
            side-by-side and unrelated, and the deletion preview will correctly report
            zero dependents. This is a gap, not a design.
          </p>
        </Step>
      )}
    </ol>
  );
}
