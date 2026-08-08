"use client";

// Onboarding: explain the memory layer, disclose what it does, ask, and record
// the answer. Four things, in that order, before the first turn.
//
//   1. What memory is    — the three mechanisms that actually exist here.
//   2. Disclaimer        — what is stored, what is not, and where it falls short.
//   3. Opt in or decline — an explicit choice, not a dismissal.
//   4. Informed consent  — the choice is only available once the disclaimer has
//                          been acknowledged, and it changes what the app does.
//
// The load-bearing rule, and the one this file previously broke: **declining has
// to mean something**. The decision is written to lib/consent.ts, the composer
// reads it and defaults to off-the-record when declined, and the memory panel can
// change it later. A consent dialog whose outcome nothing reads is decoration,
// and it is the exact "fake UI implying functionality" that CLAUDE.md forbids.
//
// Copy accuracy is treated as a correctness property here, because this dialog is
// where the project makes its promises. Three claims an earlier draft made that
// the code does not support, all now corrected:
//
//   * "caught by a local classifier" — lib/pii.ts says, in its own header, that
//     it is regex + Luhn and explicitly NOT a classifier. Overclaiming the
//     detector is called out by name in CLAUDE.md.
//   * "they vanish when the session ends" — session-scoped items are written and
//     fenced (filtered in SQL for every other chat), not deleted. They persist.
//   * "a specialised workspace with files and instructions" — no such feature
//     exists anywhere in this project.
//
// Escape and outside-click advance rather than close on steps 1–2, and do nothing
// on step 3: the dialog cannot be dismissed into an undecided state, because
// "undecided" is not a mode the app can honestly run in. Both choices are always
// one click away, so this is a required decision, not a trap.

import { useCallback, useState } from "react";
import {
  ArrowLeft,
  Brain,
  Check,
  EyeOff,
  Layers,
  ScrollText,
  ShieldAlert,
  Trash2,
} from "lucide-react";

import { useMemoryConsent } from "@/lib/consent";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const ONBOARDED_KEY = "nam.onboarded";

/** The mechanisms that exist. Each one is a real, demonstrable behaviour. */
const MECHANISMS = [
  {
    Icon: ScrollText,
    title: "It proposes, you decide",
    body:
      "After a turn, facts worth keeping are pulled out and shown to you as a review card. You accept, edit, or discard each one. Low-risk, high-confidence items are kept quietly so you are not asked about everything.",
  },
  {
    Icon: Layers,
    title: "Two scopes",
    body:
      "A memory is either remembered across conversations, or confined to this one. Confined items are filtered out of every other chat, and you can move an item between the two at any time.",
  },
  {
    Icon: EyeOff,
    title: "Off the record",
    body:
      "Tick this on a message and nothing is extracted from it at all — the extraction step returns before the model ever sees it.",
  },
] as const;

/** Disclosure. Every line here has to be true of the code as it stands. */
const DISCLOSURES = [
  {
    Icon: Brain,
    title: "What is stored",
    body:
      "Short factual statements derived from your messages — preferences, projects, status. Each one keeps a reference to the message it came from, so you can always see why it exists.",
  },
  {
    Icon: Layers,
    title: "What “this chat only” actually means",
    body:
      "The item is still written to the database, anchored to this conversation, and excluded from retrieval everywhere else. It is fenced, not deleted — so treat it as “not reused”, not as “gone”.",
  },
  {
    Icon: ShieldAlert,
    title: "The pre-send check is a pattern match",
    body:
      "Card numbers, credentials and ID numbers are caught on your device by regular expressions and a checksum — not by a classifier. It will miss things phrased unusually, and it will occasionally flag a harmless number. Nothing is sent anywhere to run it.",
  },
  {
    Icon: Trash2,
    title: "Deleting is tombstoning",
    body:
      "A deleted memory stops being retrievable and its embedding is dropped, but the record that it existed remains. Answers already given are not rewritten.",
  },
  {
    Icon: ScrollText,
    title: "Off-the-record still means in the transcript",
    body:
      "Nothing is extracted from an off-the-record message, so nothing about it survives into another conversation. The text itself stays in this chat's history, where you can clear it separately.",
  },
] as const;

// ─── Step 1 ───────────────────────────────────────────────────────────────────

function StepMemory({ onNext }: { onNext: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Brain className="size-5 shrink-0 text-accent" aria-hidden="true" />
          This app remembers things you tell it
        </DialogTitle>
        <DialogDescription>
          Not silently, though. Memory here is something you negotiate — you see
          each fact before it is kept, and you can change or remove it afterwards.
        </DialogDescription>
      </DialogHeader>

      <ul className="space-y-2 px-6">
        {MECHANISMS.map(({ Icon, title, body }) => (
          <li
            key={title}
            className="flex items-start gap-3 rounded-input border border-outline-ink p-3"
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
            <span>
              <span className="block text-body-sm font-medium text-ink">{title}</span>
              <span className="mt-0.5 block text-body-sm text-ink-muted">{body}</span>
            </span>
          </li>
        ))}
      </ul>

      <DialogFooter>
        <Button variant="primary" autoFocus onClick={onNext}>
          Next: what to be aware of
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Step 2 ───────────────────────────────────────────────────────────────────

function StepDisclaimer({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ShieldAlert className="size-5 shrink-0 text-alert-ink" aria-hidden="true" />
          Before you decide
        </DialogTitle>
        <DialogDescription>
          Including the parts that are weaker than you might assume. You should
          know these before opting in, not after.
        </DialogDescription>
      </DialogHeader>

      <ul className="max-h-[40vh] space-y-2 overflow-y-auto px-6">
        {DISCLOSURES.map(({ Icon, title, body }) => (
          <li
            key={title}
            className="flex items-start gap-3 rounded-input border border-outline-ink p-3"
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
            <span>
              <span className="block text-body-sm font-medium text-ink">{title}</span>
              <span className="mt-0.5 block text-body-sm text-ink-muted">{body}</span>
            </span>
          </li>
        ))}
      </ul>

      <DialogFooter>
        <Button variant="ghostInk" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </Button>
        <Button variant="primary" autoFocus onClick={onNext}>
          Next: your choice
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Step 3 ───────────────────────────────────────────────────────────────────

function StepConsent({
  onBack,
  onDecide,
}: {
  onBack: () => void;
  onDecide: (accepted: boolean) => void;
}) {
  // The gate on "Turn memory on" only. Declining never requires an
  // acknowledgement — making someone tick a box to opt *out* would be a dark
  // pattern, and the safe choice must always be the cheap one.
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Do you want this on?</DialogTitle>
        <DialogDescription>
          Either way you can change it later from the memory panel, and either way
          you keep the review step for anything that does get remembered.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 px-6">
        <label className="flex cursor-pointer items-start gap-3 rounded-input border border-outline-ink p-3">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-[color:var(--accent)]"
          />
          <span className="text-body-sm text-ink-muted">
            I have read what is stored and where it falls short, and I understand
            I can review, re-scope or delete any memory at any time.
          </span>
        </label>

        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            disabled={!acknowledged}
            onClick={() => onDecide(true)}
            className={cn(
              "flex flex-col items-start gap-1 rounded-input border p-3 text-left transition-colors duration-[var(--motion-micro)]",
              acknowledged
                ? "border-accent bg-accent-dim hover:brightness-95"
                : "cursor-not-allowed border-outline-ink opacity-50",
            )}
          >
            <span className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <Check className="size-4 shrink-0" aria-hidden="true" />
              Turn memory on
            </span>
            <span className="text-body-sm text-ink-muted">
              Facts are proposed after each turn and kept once you accept them.
            </span>
            {!acknowledged && (
              <span className="meta text-ink-muted">
                Confirm the box above first
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onDecide(false)}
            className="flex flex-col items-start gap-1 rounded-input border border-outline-ink p-3 text-left transition-colors duration-[var(--motion-micro)] hover:bg-black/[0.03]"
          >
            <span className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <EyeOff className="size-4 shrink-0" aria-hidden="true" />
              Not now
            </span>
            <span className="text-body-sm text-ink-muted">
              Every message starts off the record, so nothing is extracted until
              you say otherwise.
            </span>
          </button>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghostInk" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Host ─────────────────────────────────────────────────────────────────────

export function Onboarding({
  /** Settings → "Replay the introduction". Shows the flow again for someone who has
   *  already decided, without clearing the decision first — clearing it would make
   *  the app behave as un-consented for however long they spend reading, which is
   *  the opposite of what re-reading should cost. */
  forceOpen = false,
  onReplayFinished,
}: {
  forceOpen?: boolean;
  onReplayFinished?: () => void;
} = {}) {
  const [consent, setConsent] = useMemoryConsent();
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const decide = useCallback(
    (accepted: boolean) => {
      // Order matters only in that both must be written before the dialog can
      // close; `consent` is what the app reads, `nam.onboarded` is only a record
      // that the explanation has been seen.
      setConsent(accepted ? "accepted" : "declined");
      window.localStorage.setItem(ONBOARDED_KEY, "1");
      // Rewound on the way out, not on the way in. A replay has to start at step 1,
      // and doing it here — where the dialog actually closes — avoids syncing
      // `forceOpen` into state from an effect, which fires an extra render on every
      // change and is what the react-hooks/set-state-in-effect rule is guarding
      // against.
      setStep(1);
      onReplayFinished?.();
    },
    [setConsent, onReplayFinished],
  );

  // Driven by the consent decision itself rather than a separate `dismissed`
  // flag, so there is one source of truth: if the app knows what you chose, the
  // dialog is done. `forceOpen` is the one override, and it still exits only
  // through an explicit choice on step 3.
  const open = forceOpen || consent === null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (step === 1) setStep(2);
        else if (step === 2) setStep(3);
        // Step 3 swallows it — the choice has to be made, and both options are
        // on screen.
      }}
    >
      <DialogContent
        showClose={false}
        className="max-w-lg"
        onEscapeKeyDown={step === 3 ? (e) => e.preventDefault() : undefined}
        onPointerDownOutside={step === 3 ? (e) => e.preventDefault() : undefined}
        onInteractOutside={step === 3 ? (e) => e.preventDefault() : undefined}
      >
        <div className="flex items-center gap-1.5 px-6 pt-5" aria-hidden="true">
          {([1, 2, 3] as const).map((s) => (
            <span
              key={s}
              className={cn(
                "h-1 flex-1 rounded-pill transition-colors duration-[var(--motion-state)]",
                s <= step ? "bg-accent" : "bg-black/10",
              )}
            />
          ))}
        </div>
        <p className="meta px-6 pt-2 text-ink-muted">Step {step} of 3</p>

        {step === 1 && <StepMemory onNext={() => setStep(2)} />}
        {step === 2 && (
          <StepDisclaimer onBack={() => setStep(1)} onNext={() => setStep(3)} />
        )}
        {step === 3 && (
          <StepConsent onBack={() => setStep(2)} onDecide={decide} />
        )}
      </DialogContent>
    </Dialog>
  );
}
