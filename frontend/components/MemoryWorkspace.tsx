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

import { useCallback, useState, useSyncExternalStore } from "react";
import { List, Network } from "lucide-react";

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
}: {
  relevance: Map<string, number> | null;
}) {
  const { items, loading } = useMemoryStore();
  const stored = useSyncExternalStore(
    viewStore.subscribe,
    viewStore.get,
    viewStore.server,
  );
  // Local override so a click is instant; the stored value is the fallback and
  // the cross-tab source.
  const [override, setOverride] = useState<View | null>(null);
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

  return (
    <section
      id="memory-workspace"
      aria-label="Memory"
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-headline-lg text-ink-invert">Memory</h2>
          <p className="text-body-sm text-ink-invert-muted">
            <span className="tnum">{items.length}</span>{" "}
            {items.length === 1 ? "thing" : "things"} it can use. Both views do
            everything; pick whichever answers your question.
          </p>
        </div>

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
          ? "bg-stated text-[color:var(--surface-sunken)]"
          : "text-ink-invert-muted hover:text-ink-invert",
      )}
    >
      {icon}
      {children}
    </button>
  );
}
