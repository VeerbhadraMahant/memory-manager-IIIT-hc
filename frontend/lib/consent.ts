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

import { useAuth } from "@/lib/auth-context";

// Per user, not per browser. This used to be one global key, so on a shared browser the
// second person to sign in silently inherited the first person's answer — consent they
// were never asked for. The key now carries the account id (from the auth gate, which
// only renders the app once it knows who is signed in), so each account is asked once
// and a decision never crosses accounts.
//
// Limits worth knowing: it is still browser storage, so a new device asks again (the
// safe direction), and the backend never sees it — the opt-in is honoured by the client
// (composer defaults to off-the-record when declined), not enforced server-side.
const LEGACY_KEY = "nam.memory-consent";
const keyFor = (userId: string) => `${LEGACY_KEY}:${userId}`;

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

function read(userId: string, isDemo: boolean): MemoryConsent {
  // The un-keyed value from before this change cannot be attributed to a person, so it
  // is honoured only for the shared demo account — which is where it came from when
  // there was no sign-in — and never for a real account.
  const raw =
    window.localStorage.getItem(keyFor(userId)) ??
    (isDemo ? window.localStorage.getItem(LEGACY_KEY) : null);
  return raw === "accepted" || raw === "declined" ? raw : null;
}

// Treated as already-decided on the server so the dialog is never part of the
// prerendered HTML; the client corrects it on the first commit.
const serverSnapshot = (): MemoryConsent => "accepted";

export function useMemoryConsent(): [
  MemoryConsent,
  (next: Exclude<MemoryConsent, null>) => void,
] {
  const { userId, isDemo } = useAuth();
  const consent = useSyncExternalStore(
    subscribe,
    () => read(userId, isDemo),
    serverSnapshot,
  );

  const set = useCallback(
    (next: Exclude<MemoryConsent, null>) => {
      window.localStorage.setItem(keyFor(userId), next);
      notify();
    },
    [userId],
  );

  return [consent, set];
}
