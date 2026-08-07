"use client";

// §4.3 — pre-send PII intervention, tiered.
//
// The brief's "subtle ambient glow" is under-weighted for something you cannot
// take back, and a modal is over-weighted for a health disclosure that is the
// entire point of the message. So there are two tiers, and the axis they are
// split on is CLAUDE.md principle 3: *friction proportional to irreversibility,
// not to sensitivity*.
//
//   irreversible  → modal, focus-trapped, 4px --danger top border.
//                   "Redact & send" primary, "Send as-is" ghost.
//                   Never Cancel-only: the user must always be able to proceed.
//
//   sensitive     → inline strip above the composer. No focus steal, no modal,
//                   dismissible. Sends freely; handled at the storage layer with
//                   a session-only default.
//
// And principle 4, which is the one people skip: a dismissed category stays
// silent for the rest of the session. A warning that reappears after being
// answered trains the user to dismiss it unread, which is worse than never
// having warned at all.
//
// Everything it acts on comes from lib/pii.ts, which does no I/O. Nothing here
// reaches the network; the model only ever sees text the user chose to send.

import { ShieldAlert, X } from "lucide-react";

import {
  CATEGORY_LABEL,
  redact,
  type PiiCategory,
  type PiiFinding,
} from "@/lib/pii";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Chip } from "@/components/ui/chip";

/** Tier 1. Focus-trapped, and it always offers both ways out. */
export function PiiModal({
  open,
  text,
  findings,
  onSend,
  onCancel,
}: {
  open: boolean;
  text: string;
  findings: PiiFinding[];
  /** `dismissedCategory` is set when the user chose to send as-is, so the caller
   *  can stop asking about that category for the rest of the session. */
  onSend: (text: string, dismissedCategories: PiiCategory[]) => void;
  onCancel: () => void;
}) {
  const irreversible = findings.filter((f) => f.tier === "irreversible");
  const categories = [...new Set(irreversible.map((f) => f.category))];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent accent="danger" showClose={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="size-5 text-danger-ink" aria-hidden="true" />
            {categories.length === 1
              ? `That looks like a ${CATEGORY_LABEL[categories[0]]}`
              : "That message has some things you cannot take back"}
          </DialogTitle>
          {/* Principle 5: state what happens, offer the action, do not moralise.
              No "Are you sure?", no warning triangle lecture. */}
          <DialogDescription>
            {irreversible[0]?.consequence} Chat history is not something this app
            can un-send for you.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6">
          <ul className="space-y-2">
            {irreversible.map((f, i) => (
              <li
                key={`${f.start}-${i}`}
                className="flex flex-wrap items-center gap-2 rounded-input border border-outline-ink p-3"
              >
                <Chip tone="danger" onLight>
                  {CATEGORY_LABEL[f.category]}
                </Chip>
                <code className="font-mono text-body-sm text-ink">
                  {mask(f.match)}
                </code>
                <span className="meta ml-auto text-ink-muted">
                  → {f.redaction}
                </span>
              </li>
            ))}
          </ul>

          {/* The honest caveat, in the interface rather than only in the README:
              this is a regex and a checksum, not a classifier. Saying so is what
              makes "Send as-is" a reasonable button rather than a trap. */}
          <p className="mt-4 text-body-sm text-ink-muted">
            This check ran on your device — a pattern match and a checksum,
            nothing was sent anywhere to produce it. It can be wrong in both
            directions.
          </p>
        </div>

        <DialogFooter>
          {/* Ghost, not disabled, not absent. §4.3: never Cancel-only. If the
              detector is wrong, one press gets past it, and that category then
              stays quiet for the session. */}
          <Button variant="ghostInk" onClick={() => onSend(text, categories)}>
            Send as-is
          </Button>
          {/* Focused on open. Radix would otherwise land on the first tabbable
              node, which is "Send as-is" — so a user who hits Enter out of habit
              would send the thing the modal exists to catch. The safe action
              takes the default; the other one is still one Tab away. */}
          <Button
            variant="primary"
            autoFocus
            onClick={() => onSend(redact(text, irreversible), [])}
          >
            Redact &amp; send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Tier 2. An inline strip above the composer.
 *
 * Explicitly does not steal focus and does not block the send. The message goes
 * out either way; what this offers is the storage-layer choice, phrased as the
 * consequence it actually has.
 */
export function PiiStrip({
  findings,
  sessionOnly,
  onSessionOnly,
  onDismiss,
}: {
  findings: PiiFinding[];
  sessionOnly: boolean;
  onSessionOnly: (v: boolean) => void;
  onDismiss: (categories: PiiCategory[]) => void;
}) {
  const sensitive = findings.filter((f) => f.tier === "sensitive");
  const categories = [...new Set(sensitive.map((f) => f.category))];

  if (sensitive.length === 0) return null;

  return (
    <div
      role="status"
      className="anim-enter mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-input border border-stated/40 bg-stated-dim px-3 py-2"
    >
      <span className="meta text-stated-on-dark">
        {categories.map((c) => CATEGORY_LABEL[c]).join(", ")}
      </span>
      <span className="text-body-sm text-ink-invert-muted">
        {sensitive[0].consequence}
      </span>

      <label className="ml-auto flex min-h-11 items-center gap-2 text-body-sm text-ink-invert">
        <input
          type="checkbox"
          checked={sessionOnly}
          onChange={(e) => onSessionOnly(e.target.checked)}
          className="size-4 accent-[color:var(--stated)]"
        />
        Keep to this session
      </label>

      <button
        onClick={() => onDismiss(categories)}
        className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted hover:text-ink-invert"
        aria-label={`Stop warning about ${categories.map((c) => CATEGORY_LABEL[c]).join(" and ")} for this session`}
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Show enough to recognise, not enough to be the disclosure itself. */
function mask(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 8) return trimmed;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
