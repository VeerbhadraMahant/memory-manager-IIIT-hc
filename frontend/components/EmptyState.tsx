"use client";

// The empty conversation.
//
// It was a dashed card holding one example line. The line was the right example
// — a mixed disclosure is the fastest way into the core loop — but a card that
// cannot be clicked leaves the reader retyping a sentence about escitalopram,
// which is not how a demo should start.
//
// So the three demo beats become the three cards. They fill the composer and
// stop: pressing Send is still the user's act, which is the same rule the
// pre-send intervention rests on — nothing reaches the model that the user did
// not choose to send.
//
// Heading and cards are separate exports rather than one component wrapping the
// composer, so the composer keeps its position in the tree when the first turn
// lands and does not remount out from under the focus.

import { BadgeCheck, Search, Split } from "lucide-react";

const BEATS = [
  {
    icon: Split,
    title: "Mixed disclosure",
    body: "Health and a project in one sentence. They should not be treated the same.",
    prompt:
      "I've been on 20mg escitalopram since March. Still writing the CHI paper with Priya, should wrap next month.",
  },
  {
    icon: Search,
    title: "Ask what it knows",
    body: "Start a new session first. What was kept to this chat should not follow you.",
    prompt: "What do you know about me so far?",
  },
  {
    icon: BadgeCheck,
    title: "High-stakes draft",
    body: "Tick High-stakes draft below, then every memory-derived claim gets checked.",
    prompt:
      "Write me a two-sentence conference bio, based on what you know about my work.",
  },
] as const;

export function EmptyHeading() {
  return (
    <div className="py-6">
      <h2 className="text-headline-lg text-ink-invert">
        Tell it something with a mix of things in it.
      </h2>
      <p className="measure mt-2 text-body-md text-ink-invert-muted">
        Health goes to this chat only. A paper in progress is kept as{" "}
        <em>in progress</em>, not as finished. You will see both happen, and you
        can change either one.
      </p>
    </div>
  );
}

export function SuggestionCards({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="pb-8">
      <h3 className="meta mb-2 text-ink-invert-muted">Three ways to start</h3>
      <ul className="grid gap-3 sm:grid-cols-3">
        {BEATS.map((beat) => (
          <li key={beat.title} className="flex">
            <button
              type="button"
              onClick={() => onPick(beat.prompt)}
              // Title and body live in two sibling <span>s; Chrome's
              // accessibility tree gives a button that shape an *empty* name
              // (checked directly against the AX node, not assumed) rather
              // than concatenating them, so the label is spelled out here.
              aria-label={`${beat.title}. ${beat.body}`}
              className="flex w-full flex-col items-start gap-1.5 rounded-card border border-outline bg-raised p-4 text-left transition-colors duration-[var(--motion-micro)] hover:border-outline-strong hover:bg-sunken"
            >
              <beat.icon className="size-5 text-accent" aria-hidden="true" />
              <span className="text-body-md font-medium text-ink-invert">
                {beat.title}
              </span>
              <span className="text-body-sm text-ink-invert-muted">{beat.body}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
