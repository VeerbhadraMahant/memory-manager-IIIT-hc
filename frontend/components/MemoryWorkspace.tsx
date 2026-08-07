"use client";

// §2 — coequal views.
//
// "The list is not an accessibility fallback. Both views are complete
// representations of the same state, and every action must be reachable in
// both. View toggle is persistent, prominent, and remembered across sessions."
//
// Three things this component is responsible for, and nothing else:
//
//  1. Owning which view is showing, and remembering it in localStorage.
//  2. Owning the selected memory, so switching views keeps your place. That is
//     what makes them two representations of one state rather than two screens.
//  3. Owning the deletion preview, because the dialog and the graph highlight
//     are the same preview seen twice (§4.5).
//
// It deliberately does not own any memory *action*. Those all live in
// useMemoryActions(), which both views call directly.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, List, Network } from "lucide-react";

import type { MemoryItem, ProvenanceGraph } from "@/lib/api";
import { useMemoryStore } from "@/lib/memory-store";
import { cn } from "@/lib/utils";
import { DeletionPreviewDialog } from "@/components/DeletionPreview";
import { MemoryGraph } from "@/components/MemoryGraph";
import { MemoryList } from "@/components/MemoryList";

type View = "list" | "graph";
const STORAGE_KEY = "nam.memory-view";

// "Remembered across sessions" (§2) means localStorage, and localStorage does
// not exist during the prerender. Reading it in a useState initializer would
// hydrate wrong; reading it in an effect would flash the default view first.
// useSyncExternalStore is the one API that gets both right: it serves the
// server snapshot through hydration, then swaps to the stored value.
const viewStore = {
  subscribe(onChange: () => void) {
    // Cross-tab: two windows open on the same demo should not disagree about
    // which view the user picked.
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  },
  get(): View {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "graph" ? "graph" : "list";
  },
  // The list is the primary view (principle 6), so it is what an unconfigured
  // client renders — including with JavaScript still loading.
  server: (): View => "list",
};

export function MemoryWorkspace({
  /** §4.4: which memories shaped the turn currently in focus, and how strongly.
   *  Drives the graph's glow tiers. Null means "not highlighting anything". */
  relevance,
  /** Opens straight to this view without touching the stored preference, so the
   *  full-page graph route (app/graph) can start on Graph without changing what
   *  the side panel shows next time — only an explicit tab click writes to
   *  localStorage (`choose`, below). */
  initialView,
  /** Hides the "open in a new tab" link. Set on the full-page route itself —
   *  opening a new tab from the page that already *is* the new tab is a no-op
   *  wearing a link. */
  hideExpandLink,
}: {
  relevance: Map<string, number> | null;
  initialView?: View;
  hideExpandLink?: boolean;
}) {
  const { items, loading } = useMemoryStore();
  const stored = useSyncExternalStore(
    viewStore.subscribe,
    viewStore.get,
    viewStore.server,
  );
  // Local override so a click is instant; the stored value is the fallback and
  // the cross-tab source.
  const [override, setOverride] = useState<View | null>(initialView ?? null);
  const view = override ?? stored;

  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MemoryItem | null>(null);
  const [preview, setPreview] = useState<ProvenanceGraph | null>(null);

  // Derived, not stored-and-cleaned-up. A memory that no longer exists cannot
  // stay selected — after a cascade delete the graph would otherwise hold a
  // detail panel open on a tombstone — and deriving it means there is no window
  // in which the two can disagree.
  const selectedId =
    requestedId && items.some((i) => i.id === requestedId) ? requestedId : null;

  const choose = useCallback((next: View) => {
    setOverride(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  // §4.4: a chip's "show in graph" opens the collapsed panel (page.tsx) — but
  // opening it is not the same as *showing* anything if the stored preference
  // is List, which was the discovered failure: the panel opened, the highlight
  // was set, and the graph glow had no canvas to render on. The click accomplishes
  // nothing the user can see. The ref catches the null→set transition rather than
  // every relevance change, so clearing and re-setting the same highlight while
  // already on the graph does not fight a manual switch back to List.
  const wasHighlighting = useRef(false);
  useEffect(() => {
    const isHighlighting = relevance !== null;
    if (isHighlighting && !wasHighlighting.current) choose("graph");
    wasHighlighting.current = isHighlighting;
  }, [relevance, choose]);

  return (
    <section
      id="memory-workspace"
      aria-label="Memory"
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-headline-lg text-ink-invert">Memory</h2>
          {/* Scoped explicitly. This number counts every memory in the store;
              the session panel counts the subset this chat can reach, and the
              two disagreeing without labels read as a bug rather than as the
              point of session scoping. */}
          <p className="text-body-sm text-ink-invert-muted">
            <span className="tnum">{items.length}</span>{" "}
            {items.length === 1 ? "memory" : "memories"} in total, across every
            session. Both views do everything; pick whichever answers your
            question.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Prominent, persistent, and a real tablist — arrow keys move between
              tabs, which is the pattern a screen-reader user will expect from
              something announced as one. */}
          <div
            role="tablist"
            aria-label="Memory view"
            className="inline-flex rounded-pill border border-outline bg-raised p-1"
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                choose(view === "list" ? "graph" : "list");
              }
            }}
          >
            <ViewTab
              active={view === "list"}
              onClick={() => choose("list")}
              icon={<List className="size-4" aria-hidden="true" />}
            >
              List
            </ViewTab>
            <ViewTab
              active={view === "graph"}
              onClick={() => choose("graph")}
              icon={<Network className="size-4" aria-hidden="true" />}
            >
              Graph
            </ViewTab>
          </div>

          {/* Escape hatch to the full-page graph explorer. A real anchor with
              target="_blank", not a router push: the graph is exploratory and the
              conversation underneath should keep running rather than being
              navigated away from. List stays reachable on the new tab too — see
              app/graph/page.tsx — so this is a bigger canvas for the same coequal
              view, not a graph-only surface (principle 6). */}
          {!hideExpandLink && (
            <a
              href="/graph"
              target="_blank"
              rel="noopener noreferrer"
              title="Open the memory graph in a new tab"
              // The visible text below and aria-label say the same thing on
              // purpose (not a redundancy to trim): checked directly against
              // Chrome's accessibility tree, a link whose text is split across
              // a bare text node plus a sr-only <span> gets an empty computed
              // name here and falls back to `title` — dropping "opens in a new
              // tab", the one thing a screen-reader user most needs warned
              // about before this link fires. aria-label is what actually wins.
              aria-label="View memory graph — opens in a new tab"
              className="tap inline-flex items-center gap-1.5 rounded-input px-2 text-body-sm text-ink-invert-muted hover:bg-raised hover:text-ink-invert"
            >
              <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
              View memory graph
            </a>
          )}
        </div>
      </header>

      {/* Both panels stay mounted; the inactive one is hidden rather than
          unmounted, so switching views does not throw away scroll position,
          filter state or the graph's viewport. `hidden` also keeps the inactive
          panel out of the tab order and out of the accessibility tree, which a
          CSS-only `display:none` swap would not guarantee. */}
      <div
        role="tabpanel"
        aria-label="Memory list"
        hidden={view !== "list"}
        className={cn("min-h-0 flex-1", view !== "list" && "hidden")}
      >
        <MemoryList
          selectedId={selectedId}
          onSelect={setRequestedId}
          onRequestDelete={setDeleteTarget}
        />
      </div>

      <div
        role="tabpanel"
        aria-label="Memory graph"
        hidden={view !== "graph"}
        className={cn("flex min-h-0 flex-1 flex-col", view !== "graph" && "hidden")}
      >
        {/* Mounted lazily on first use: React Flow measures its container, and a
            container that has never been visible measures zero. */}
        {view === "graph" && !loading && (
          <MemoryGraph
            selectedId={selectedId}
            onSelect={setRequestedId}
            preview={preview}
            relevance={relevance}
            onRequestDelete={setDeleteTarget}
          />
        )}
      </div>

      <DeletionPreviewDialog
        item={deleteTarget}
        onClose={() => {
          setDeleteTarget(null);
          setPreview(null);
        }}
        onPreviewLoaded={setPreview}
        onDeleted={() => setRequestedId(null)}
      />
    </section>
  );
}

function ViewTab({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      // Only the active tab is a tab stop; arrows move between them. Standard
      // roving tabindex, so the tablist is one stop rather than two.
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-pill px-4 text-body-sm font-medium transition-colors duration-[var(--motion-micro)]",
        active
          ? "bg-accent text-white"
          : "text-ink-invert-muted hover:text-ink-invert",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
