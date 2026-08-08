"use client";

// The memory opt-in decision, as state the rest of the app can act on.
//
// This lives outside <Onboarding> on purpose. A consent choice that only the
// consent dialog can see is decoration — the whole point is that declining
// changes what the app does, and that requires the decision to be readable from
// the composer (which defaults to off-the-record when declined) and writable
// from the memory panel (so the choice can be withdrawn later, which is what
// makes it consent rather than a one-time gate).
//
// Note the module-level listener set, which is the part that is easy to get
// wrong: `window`'s "storage" event fires in *other* tabs, never in the tab that
// did the writing. A store that subscribes only to that event therefore updates
// every window except the one the user is clicking in. This had exactly that
// bug — the memory panel flipped the decision and the composer went on
// defaulting to the old one until a reload. So `set` notifies local subscribers
// itself, and "storage" is kept purely for the cross-tab case.
//
// Consequence worth stating: because every subscriber reads the same
// localStorage value and is notified together, there is no per-component
// override to drift. One decision, one source.

import { useCallback, useSyncExternalStore } from "react";

const CONSENT_KEY = "nam.memory-consent";

/** `null` means the user has not been asked yet. */
export type MemoryConsent = "accepted" | "declined" | null;

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function read(): MemoryConsent {
  const raw = window.localStorage.getItem(CONSENT_KEY);
  return raw === "accepted" || raw === "declined" ? raw : null;
}

// Treated as already-decided on the server so the dialog is never part of the
// prerendered HTML; the client corrects it on the first commit.
const serverSnapshot = (): MemoryConsent => "accepted";

export function useMemoryConsent(): [
  MemoryConsent,
  (next: Exclude<MemoryConsent, null>) => void,
] {
  const consent = useSyncExternalStore(subscribe, read, serverSnapshot);

  const set = useCallback((next: Exclude<MemoryConsent, null>) => {
    window.localStorage.setItem(CONSENT_KEY, next);
    notify();
  }, []);

  return [consent, set];
}
