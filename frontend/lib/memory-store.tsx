"use client";

// §2 — the architectural rule, as code.
//
// "Build one useMemoryActions() hook containing every operation (accept, reject,
// edit, rescope, delete, confirm, reclassify). Both views call it. No action
// lives inside a view component."
//
// This file is the enforcement point for that. The list, the graph, the review
// card and the draft panel all mutate memory through this hook; none of them
// imports the API client for a memory operation. That is what makes "coequal
// views" a property of the architecture rather than a promise in a README — an
// action that exists in only one view would have to be built by breaking this
// boundary, which is visible in a diff.
//
// The check is one grep:
//     grep -rn 'api\.\(accept\|reject\|edit\|rescope\|confirm\|remove\)' components
// It must return nothing.
//
// The aria-live announcement lives here too (§6). Announcing at the action
// rather than at the view means a memory state change is narrated exactly once,
// no matter which surface triggered it, and a new surface gets it for free.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  api,
  SCOPE_LABEL,
  STATUS_LABEL,
  type AssertionStatus,
  type Block,
  type CascadePreview,
  type MemoryItem,
  type ProvenanceGraph,
  type Scope,
  type Sensitivity,
} from "./api";
import { FALLBACK_BLOCKS } from "./semantics";

export interface MemoryActions {
  /** "Yes, keep this." Resolves a pending candidate. */
  accept: (id: string) => Promise<void>;
  /** Tombstone + audit. Not a hard delete — see the backend's reject_item. */
  reject: (id: string) => Promise<void>;
  /** Correct the wording. A correction is an acceptance. */
  editContent: (id: string, content: string) => Promise<void>;
  /** Move between session and persistent. */
  rescope: (id: string, scope: Scope) => Promise<void>;
  /** "Still true." Resets the decay clock. */
  confirm: (id: string) => Promise<void>;
  /** One-tap reclassification — the chips that display are the controls. */
  reclassify: (
    id: string,
    patch: Partial<{
      block_name: string;
      status: AssertionStatus;
      sensitivity: Sensitivity;
    }>,
  ) => Promise<void>;
  /** What deleting this would do, before doing it (§4.5). */
  previewDeletion: (id: string) => Promise<ProvenanceGraph>;
  /** Tombstone + cascade. Returns what actually happened. */
  remove: (id: string) => Promise<CascadePreview>;
}

interface MemoryStore {
  items: MemoryItem[];
  graph: ProvenanceGraph | null;
  blocks: string[];
  loading: boolean;
  error: string | null;
  /** Set of ids with an action in flight — views disable their controls on it
   *  rather than each inventing a local busy flag. */
  busy: ReadonlySet<string>;
  refresh: () => Promise<void>;
  actions: MemoryActions;
  /** Latest announcement, rendered by <MemoryLiveRegion>. */
  announcement: string;
  announce: (message: string) => void;
}

const Ctx = createContext<MemoryStore | null>(null);

export function MemoryProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [graph, setGraph] = useState<ProvenanceGraph | null>(null);
  const [blocks, setBlocks] = useState<string[]>(FALLBACK_BLOCKS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");

  // A repeated identical string is not re-announced by screen readers, which is
  // wrong here: rejecting two items in a row is two events. The counter forces a
  // distinct node value without putting a number in front of the user.
  const nonce = useRef(0);
  const announce = useCallback((message: string) => {
    nonce.current += 1;
    setAnnouncement(nonce.current % 2 ? message : `${message} `);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [list, g] = await Promise.all([
        api.items({ limit: "200" }),
        // The graph is fetched alongside the list, not on view switch: toggling
        // between coequal views must not cost a round trip, or one of them
        // starts feeling like the secondary one.
        api.graph().catch(() => null),
      ]);
      setItems(list);
      setGraph(g);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not load memory");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load. This is the legitimate use of an effect — subscribing to an
  // external system — and every setState below happens in a later task, after
  // the awaits, not synchronously in the effect body.
  useEffect(() => {
    let live = true;
    void (async () => {
      await refresh();
      try {
        const bs: Block[] = await api.blocks();
        if (live) setBlocks(bs.map((b) => b.name));
      } catch {
        /* fall back to the seeded names; the chips must still render */
      }
    })();
    return () => {
      live = false;
    };
  }, [refresh]);

  const withBusy = useCallback(
    async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
      setBusy((s) => new Set(s).add(id));
      try {
        return await fn();
      } finally {
        setBusy((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }
    },
    [],
  );

  /** Patch one row in place. Avoids a full refetch flashing the list back to the
   *  top mid-interaction, which loses the user's scroll and their place. */
  const patch = useCallback((updated: MemoryItem) => {
    setItems((cur) => cur.map((i) => (i.id === updated.id ? updated : i)));
  }, []);

  const actions = useMemo<MemoryActions>(() => {
    /** Every mutation goes through here, so every mutation announces. */
    const run = async (
      id: string,
      fn: () => Promise<MemoryItem>,
      say: (item: MemoryItem) => string,
    ) => {
      const updated = await withBusy(id, fn);
      patch(updated);
      announce(say(updated));
    };

    return {
      accept: (id) =>
        run(id, () => api.accept(id), (i) => `Kept: ${i.content}`),

      reject: async (id) => {
        const item = await withBusy(id, () => api.reject(id));
        // Rejected items leave the live list entirely rather than lingering as a
        // greyed row — the tombstone is an audit record, not a UI state.
        setItems((cur) => cur.filter((i) => i.id !== id));
        announce(`Discarded: ${item.content}`);
      },

      editContent: (id, content) =>
        run(id, () => api.edit(id, { content }), (i) => `Updated to: ${i.content}`),

      rescope: (id, scope) =>
        run(
          id,
          () => api.rescope(id, scope),
          (i) => `${i.content} — now ${SCOPE_LABEL[i.scope]}`,
        ),

      confirm: (id) =>
        run(id, () => api.confirm(id), (i) => `Confirmed as still true: ${i.content}`),

      reclassify: (id, patchBody) =>
        run(
          id,
          () => api.edit(id, patchBody),
          (i) =>
            `Reclassified: ${i.content} — ${i.block_name ?? "unclassified"}, ${STATUS_LABEL[i.status]}`,
        ),

      previewDeletion: (id) => api.itemGraph(id),

      remove: async (id) => {
        const cascade = await withBusy(id, () => api.remove(id));
        // A cascade can touch rows the caller never named, so this one refetches
        // rather than patching — guessing which rows changed is how a list and a
        // graph end up showing different truths.
        await refresh();
        const also = cascade.cascade_delete.length;
        const flagged =
          cascade.flag_for_review.length + cascade.relationship_affected.length;
        announce(
          `Deleted. ${also} memor${also === 1 ? "y" : "ies"} deleted with it, ` +
            `${flagged} flagged for review.`,
        );
        return cascade;
      },
    };
  }, [withBusy, patch, announce, refresh]);

  const value = useMemo<MemoryStore>(
    () => ({
      items,
      graph,
      blocks,
      loading,
      error,
      busy,
      refresh,
      actions,
      announcement,
      announce,
    }),
    [items, graph, blocks, loading, error, busy, refresh, actions, announcement, announce],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMemoryStore(): MemoryStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMemoryStore must be used inside <MemoryProvider>");
  return ctx;
}

/**
 * The hook §2 names. Deliberately returns actions only: a view that wants to
 * *act* asks for this, a view that wants to *render* asks for the store. Keeping
 * them separate is what stops a component quietly growing its own fetch.
 */
export function useMemoryActions(): MemoryActions {
  return useMemoryStore().actions;
}

/** §6: memory state changes announced via aria-live. Mounted once, app-wide. */
export function MemoryLiveRegion() {
  const { announcement } = useMemoryStore();
  return (
    <p aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </p>
  );
}
