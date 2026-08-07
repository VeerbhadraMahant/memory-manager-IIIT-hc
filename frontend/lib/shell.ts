"use client";

// Shell plumbing for the three-zone layout.
//
// Everything positional lives in CSS. These are the three things CSS cannot do:
// remember the memory panel across reloads, tell behaviour (not layout) which
// breakpoint it is in, and trap focus inside an overlay.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";

const PANEL_KEY = "nam.memory-panel";

/** ≥1280px is where the memory panel fits *beside* the conversation. Below it,
 *  the panel opens over the conversation instead. */
export const WIDE_QUERY = "(min-width: 1280px)";
/** ≥1024px is where the session sidebar is permanent rather than a drawer. */
export const DESKTOP_QUERY = "(min-width: 1024px)";

// Same construction as MemoryWorkspace's viewStore, for the same reason:
// localStorage does not exist during the prerender, a useState initializer would
// hydrate wrong, and an effect would paint the default first.
//
// The server snapshot is *closed*, not the responsive default. The prerender
// cannot know the viewport, so one of the two initial states has to be wrong at
// ≥1280px, and closed-then-open is the cheap direction: a panel that appears is
// a layout settling, a panel that visibly retracts looks like the app changed
// its mind about a choice the user already made. Paired with
// useAnimateAfterFirstPaint below, the correction lands before the first paint
// rather than as a 240ms slide.
const panelStore = {
  subscribe(onChange: () => void) {
    window.addEventListener("storage", onChange);
    // Without this, a window resized across 1280px keeps whichever default it
    // booted with — the panel would be beside the conversation with no room.
    const mq = window.matchMedia(WIDE_QUERY);
    mq.addEventListener("change", onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      mq.removeEventListener("change", onChange);
    };
  },
  get(): boolean {
    const saved = window.localStorage.getItem(PANEL_KEY);
    if (saved === "open") return true;
    if (saved === "closed") return false;
    // Unset: expanded where there is room for it, collapsed where there is not.
    return window.matchMedia(WIDE_QUERY).matches;
  },
  server: (): boolean => false,
};

/** Open/closed for the memory panel, persisted under `nam.memory-panel`. */
export function useMemoryPanel(): [boolean, (open: boolean) => void] {
  const stored = useSyncExternalStore(
    panelStore.subscribe,
    panelStore.get,
    panelStore.server,
  );
  // Local override so a click is instant; the stored value is the fallback and
  // the cross-tab source.
  const [override, setOverride] = useState<boolean | null>(null);
  const set = useCallback((open: boolean) => {
    setOverride(open);
    window.localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
  }, []);
  return [override ?? stored, set];
}

/** A media query as state. For behaviour only — layout uses Tailwind breakpoints,
 *  which need no JavaScript and cannot disagree with what is on screen. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    [query],
  );
  const get = useCallback(() => window.matchMedia(query).matches, [query]);
  return useSyncExternalStore(subscribe, get, () => false);
}

/**
 * False for the first painted frame, true afterwards.
 *
 * The panel's real state arrives one render after hydration (see panelStore), and
 * without this the correction animates: every load at ≥1280px would open with a
 * 240ms slide. Gating the transition class on a rAF puts the class in a later
 * commit than the width change, so the first state is instant and every state
 * after it animates.
 */
export function useAnimateAfterFirstPaint(): boolean {
  const [animate, setAnimate] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return animate;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Focus trap + Escape for a zone that is currently an overlay.
 *
 * Only active when the zone actually covers the conversation. At ≥1280px the
 * memory panel is a column beside the conversation, and trapping focus in a
 * column that is not covering anything would be a bug rather than a courtesy —
 * hence `active` rather than `open`.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onClose: () => void,
) {
  // Held in a ref rather than a dependency, and this is load-bearing rather
  // than tidiness: callers pass an inline arrow, so `onClose` is a new function
  // on every render. As a dependency it tore the effect down and set it up again
  // each time — every teardown restores focus to wherever it was when the
  // overlay opened, so the panel visibly took focus and then handed it straight
  // back, and any re-render from the memory store did it again.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;

    const restoreTo = document.activeElement as HTMLElement | null;
    // Recomputed per keypress: the panel's contents change while it is open
    // (a memory is accepted, the list filters down), so a list captured on
    // open goes stale immediately.
    const tabbable = () =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );

    // The zone itself takes focus, not the first control inside it. Two reasons,
    // and the first one is why the opening focus previously went nowhere: which
    // of the panel's controls is visible depends on the breakpoint and on which
    // memory view is showing, so `tabbable()[0]` is a guess that can come back
    // empty on the frame the panel opens. The container is always there. It is
    // also the labelled element, so a screen reader announces "Memory" rather
    // than whichever button happened to be first.
    node.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // The deletion preview and the PII gate are dialogs *inside* this zone
        // with their own Escape handling. Closing both at once would take the
        // user two steps back for one keypress.
        if (document.querySelector('[role="dialog"][data-state="open"]')) return;
        close.current();
        return;
      }
      if (e.key !== "Tab") return;

      const items = tabbable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];

      // Sitting on the container counts as being at the front of the zone:
      // forwards, the browser already moves into the first control, so only
      // backwards needs catching or focus would walk straight out.
      const atFront = document.activeElement === node || document.activeElement === first;

      if (!node.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && atFront) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreTo?.focus?.();
    };
  }, [active, ref]);
}
