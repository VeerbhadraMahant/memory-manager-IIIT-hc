"use client";

// §1 — Multi-step onboarding that explains, warns, and obtains informed consent
// before any extraction starts.
//
// Three steps:
//   1. Feature overview   — what memory is and how the three modes work.
//   2. Disclaimer         — concrete statement of what is stored, where, and for how long.
//   3. Consent / Opt-in   — the user explicitly chooses. A checkbox is required to
//                           confirm they read the disclaimer. Two outcomes: memory
//                           enabled (persistent) or declined (session-only for the
//                           life of this visit, shown as off-the-record by default).
//
// Design notes:
//   • Escape / outside-click on steps 1–2 goes to the next step, not close.
//     The modal cannot be dismissed without reaching the consent gate.
//   • Escape on the consent step has no effect — the user must make a choice.
//   • No "Later" — the app cannot operate honestly without the user knowing the
//     extraction layer exists. The choice of "decline" is always available.
//   • The consent outcome is stored under `nam.memory-consent` as
//     "accepted" | "declined". "declined" turns on ephemeral mode by default in
//     page.tsx (see useConsentDecision export below).

import { useCallback, useState, useSyncExternalStore } from "react";
import { Brain, Clock, Database, Eye, Info, Lock, Shield, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const ONBOARDED_KEY = "nam.onboarded";
export const CONSENT_KEY = "nam.memory-consent";

const store = {
  subscribe(onChange: () => void) {
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  },
  get: () => window.localStorage.getItem(ONBOARDED_KEY) === "1",
  server: () => true,
};

/** Returns the stored consent decision, or null if not yet set. */
export function useConsentDecision(): "accepted" | "declined" | null {
  const raw =
    typeof window !== "undefined"
      ? window.localStorage.getItem(CONSENT_KEY)
      : null;
  if (raw === "accepted" || raw === "declined") return raw;
  return null;
}

// ─── Step 1: Feature overview ─────────────────────────────────────────────────

function StepFeatures({ onNext }: { onNext: () => void }) {
  const modes = [
    {
      dot: "bg-red-500",
      ring: "border-red-200 bg-red-50",
      label: "Short-term memory",
      labelColor: "text-red-700",
      desc: "Uses only the active conversation as context. Nothing is extracted or persisted beyond this session.",
      Icon: Clock,
    },
    {
      dot: "bg-amber-500",
      ring: "border-amber-200 bg-amber-50",
      label: "Cross-session memory",
      labelColor: "text-amber-700",
      desc: "Relevant facts carry across conversations for continuity and personalised responses.",
      Icon: Brain,
    },
    {
      dot: "bg-emerald-500",
      ring: "border-emerald-200 bg-emerald-50",
      label: "Specialised workspace",
      labelColor: "text-emerald-700",
      desc: "A dedicated context with project-specific conversations, files and instructions.",
      Icon: Zap,
    },
  ];

  return (
    <>
      <DialogHeader>
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-lg">
          <Brain className="size-6 text-white" aria-hidden="true" />
        </div>
        <DialogTitle className="text-xl font-bold">Meet your AI memory</DialogTitle>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          This app can learn from your conversations. As you chat, it surfaces
          facts worth remembering — <strong className="font-semibold text-slate-700">you decide</strong> what
          stays, what is scoped to this session, and what is discarded.
          You are always in control.
        </p>
      </DialogHeader>

      <div className="space-y-2.5 px-6 py-3">
        {modes.map(({ dot, ring, label, labelColor, desc, Icon }) => (
          <div
            key={label}
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3.5",
              ring,
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
                dot,
              )}
            >
              <Icon className="size-3.5 text-white" aria-hidden="true" />
            </span>
            <div>
              <p className={cn("text-sm font-semibold", labelColor)}>{label}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      <DialogFooter>
        <Button
          variant="primary"
          autoFocus
          onClick={onNext}
          className="w-full sm:w-auto"
        >
          Next — privacy &amp; data handling →
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Step 2: Disclaimer ───────────────────────────────────────────────────────

function StepDisclaimer({ onNext }: { onNext: () => void }) {
  const points = [
    {
      Icon: Database,
      color: "text-blue-600",
      bg: "border-blue-200 bg-blue-50",
      title: "What is stored",
      body: "Facts you or the model assert — preferences, projects, status updates. Raw message text is kept only in this chat's transcript, not in the memory store.",
    },
    {
      Icon: Eye,
      color: "text-violet-600",
      bg: "border-violet-200 bg-violet-50",
      title: "What you always see",
      body: "Every extraction candidate appears as a review card before it is confirmed. You can edit, reject, or limit any item to this session only.",
    },
    {
      Icon: Lock,
      color: "text-amber-600",
      bg: "border-amber-200 bg-amber-50",
      title: "Session isolation",
      body: "Items marked “this session only” are never written to the persistent store. They vanish when the session ends — verifiably, not just hidden in the UI.",
    },
    {
      Icon: Shield,
      color: "text-emerald-600",
      bg: "border-emerald-200 bg-emerald-50",
      title: "Sensitive content handling",
      body: "Health, financial and legal disclosures default to session-only automatically. Hard secrets (card numbers, passwords) are caught by a local classifier before they leave your device.",
    },
    {
      Icon: Info,
      color: "text-slate-500",
      bg: "border-slate-200 bg-slate-50",
      title: "You can delete everything",
      body: "Any memory item, or all of them, can be removed at any time from the memory panel. Deletion cascades to dependent facts and clears attribution.",
    },
  ];

  return (
    <>
      <DialogHeader>
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg">
          <Shield className="size-6 text-white" aria-hidden="true" />
        </div>
        <DialogTitle className="text-xl font-bold">What you should know</DialogTitle>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          We believe in transparency. Please read how your data is handled
          before deciding whether to enable memory.
        </p>
      </DialogHeader>

      <div className="max-h-[38vh] space-y-2 overflow-y-auto px-6 py-2">
        {points.map(({ Icon, color, bg, title, body }) => (
          <div
            key={title}
            className={cn("flex items-start gap-3 rounded-xl border p-3.5", bg)}
          >
            <Icon
              className={cn("mt-0.5 size-4 shrink-0", color)}
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold text-slate-800">{title}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{body}</p>
            </div>
          </div>
        ))}
      </div>

      <DialogFooter>
        <Button
          variant="primary"
          autoFocus
          onClick={onNext}
          className="w-full sm:w-auto"
        >
          I&rsquo;ve read this — make my choice →
        </Button>
      </DialogFooter>
    </>
  );
}

// ─── Step 3: Consent / Opt-in ─────────────────────────────────────────────────

function StepConsent({ onDecide }: { onDecide: (accepted: boolean) => void }) {
  const [checked, setChecked] = useState(false);

  return (
    <>
      <DialogHeader>
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg">
          <Lock className="size-6 text-white" aria-hidden="true" />
        </div>
        <DialogTitle className="text-xl font-bold">Your choice</DialogTitle>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          You are in full control. Choose how you want this session to work.
          You can change this at any time from the memory panel.
        </p>
      </DialogHeader>

      <div className="space-y-3 px-6 py-4">
        {/* Consent checkbox — must be ticked before Enable is active */}
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-300 bg-slate-50 p-3.5 transition-colors hover:bg-slate-100">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 size-4 cursor-pointer accent-violet-600"
          />
          <span className="text-xs leading-relaxed text-slate-600">
            I have read and understood the memory disclaimer. I know that facts
            extracted from my messages will be shown to me before storage, that I
            can reject or delete any item, and that I can disable memory at any
            time.
          </span>
        </label>

        {/* Two choice cards */}
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <button
            type="button"
            disabled={!checked}
            onClick={() => onDecide(true)}
            className={cn(
              "flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-all",
              checked
                ? "cursor-pointer border-violet-300 bg-violet-50 hover:border-violet-400 hover:bg-violet-100"
                : "cursor-not-allowed border-slate-200 bg-slate-50 opacity-40",
            )}
          >
            <span className="flex items-center gap-2">
              <Brain
                className={cn("size-4 shrink-0", checked ? "text-violet-600" : "text-slate-400")}
                aria-hidden="true"
              />
              <span
                className={cn(
                  "text-sm font-semibold",
                  checked ? "text-violet-800" : "text-slate-500",
                )}
              >
                Enable memory
              </span>
            </span>
            <p className="text-xs leading-relaxed text-slate-500">
              Facts are extracted, shown for review, and stored with your
              consent. Cross-session personalisation is active.
            </p>
            {!checked && (
              <p className="text-xs font-medium text-slate-400 italic">
                Tick the checkbox above to enable this option.
              </p>
            )}
          </button>

          <button
            type="button"
            onClick={() => onDecide(false)}
            className="flex cursor-pointer flex-col items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-left transition-all hover:border-slate-300 hover:bg-slate-100"
          >
            <span className="flex items-center gap-2">
              <Clock className="size-4 shrink-0 text-slate-500" aria-hidden="true" />
              <span className="text-sm font-semibold text-slate-700">Not now</span>
            </span>
            <p className="text-xs leading-relaxed text-slate-500">
              Session-only mode. Nothing is extracted or persisted beyond this
              conversation. You can opt in later from the memory panel.
            </p>
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function Onboarding() {
  const stored = useSyncExternalStore(store.subscribe, store.get, store.server);
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const decide = useCallback((accepted: boolean) => {
    window.localStorage.setItem(CONSENT_KEY, accepted ? "accepted" : "declined");
    window.localStorage.setItem(ONBOARDED_KEY, "1");
    setDismissed(true);
  }, []);

  const open = !stored && !dismissed;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Steps 1 and 2: advance on outside-click / Escape rather than closing.
        // Step 3: cannot be dismissed without an explicit choice.
        if (!next) {
          if (step === 1) setStep(2);
          else if (step === 2) setStep(3);
          // Step 3: swallow — force an explicit choice from the user.
        }
      }}
    >
      <DialogContent
        showClose={false}
        className="max-w-md"
        // Step 3: block Escape and outside-click — the user must make a choice.
        onEscapeKeyDown={step === 3 ? (e) => e.preventDefault() : undefined}
        onPointerDownOutside={step === 3 ? (e) => e.preventDefault() : undefined}
        onInteractOutside={step === 3 ? (e) => e.preventDefault() : undefined}
      >
        {/* Progress bar */}
        <div className="flex items-center gap-1.5 px-6 pt-5">
          {([1, 2, 3] as const).map((s) => (
            <span
              key={s}
              className={cn(
                "h-1 flex-1 rounded-full transition-all duration-300",
                s <= step ? "bg-violet-500" : "bg-slate-200",
              )}
            />
          ))}
        </div>
        <p className="px-6 pt-1.5 text-[11px] font-medium uppercase tracking-widest text-slate-400">
          Step {step} of 3
        </p>

        {step === 1 && <StepFeatures onNext={() => setStep(2)} />}
        {step === 2 && <StepDisclaimer onNext={() => setStep(3)} />}
        {step === 3 && <StepConsent onDecide={decide} />}
      </DialogContent>
    </Dialog>
  );
}
