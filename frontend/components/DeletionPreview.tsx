"use client";

// §4.5 — deletion preview.
//
// "Selecting delete highlights the dependent subgraph before confirming. Same
// information must render as a plain text list. Per SYSTEM_DESIGN.md, dependents
// are tombstoned and flagged for review, not silently re-derived — the UI must
// say that honestly."
//
// Two things this deliberately does not do:
//
//  1. It does not claim re-derivation. CLAUDE.md's honesty constraints name this
//     exact temptation. A memory that had another source survives the delete and
//     is *marked*, and the copy says "flagged for you to check", not "updated".
//  2. It does not treat the graph as the source of truth. The text list below is
//     complete on its own; the highlight in the graph behind the dialog is the
//     supplementary view (principle 6). If the graph is closed, nothing is lost.

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";

import type { CascadePreview, GraphNode, MemoryItem, ProvenanceGraph } from "@/lib/api";
import { useMemoryActions } from "@/lib/memory-store";
import { RELATION_LABEL, SOURCE } from "@/lib/semantics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SourceGlyph } from "@/components/ui/chip";

export function DeletionPreviewDialog({
  item,
  onClose,
  onPreviewLoaded,
  onDeleted,
}: {
  item: MemoryItem | null;
  onClose: () => void;
  /** Hands the subgraph up so the graph view can highlight it while the dialog
   *  is open. Supplementary — the dialog is complete without it. */
  onPreviewLoaded: (graph: ProvenanceGraph | null) => void;
  onDeleted: (cascade: CascadePreview) => void;
}) {
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      {/* Keyed on the item, so opening the dialog on a different memory gets
          fresh state by remount rather than by an effect that resets it. There
          is then no render in which the previous memory's consequences are
          shown under the new memory's name. */}
      {item && (
        <PreviewBody
          key={item.id}
          item={item}
          onClose={onClose}
          onPreviewLoaded={onPreviewLoaded}
          onDeleted={onDeleted}
        />
      )}
    </Dialog>
  );
}

function PreviewBody({
  item,
  onClose,
  onPreviewLoaded,
  onDeleted,
}: {
  item: MemoryItem;
  onClose: () => void;
  onPreviewLoaded: (graph: ProvenanceGraph | null) => void;
  onDeleted: (cascade: CascadePreview) => void;
}) {
  const actions = useMemoryActions();
  const [graph, setGraph] = useState<ProvenanceGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  // Two failures, two messages. They shared one state and the preview's wording
  // won, so a delete that failed reported "Could not load the preview" — which
  // sends the user looking for the wrong problem, and reads as though nothing
  // had been attempted when in fact the delete was.
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const itemId = item.id;
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const g = await actions.previewDeletion(itemId);
        if (!live) return;
        setGraph(g);
        onPreviewLoaded(g);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "preview failed");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // onPreviewLoaded is a stable setter from the workspace; including it would
    // refetch the preview on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, actions]);

  const cascade = graph?.cascade ?? null;
  const byId = new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
  const dies = (cascade?.cascade_delete ?? []).map((id) => byId.get(id)).filter(Boolean) as GraphNode[];
  const flagged = (cascade?.flag_for_review ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean) as GraphNode[];
  const related = (cascade?.relationship_affected ?? [])
    .map((id) => byId.get(id))
    .filter(Boolean) as GraphNode[];

  const total = dies.length + flagged.length + related.length;

  return (
    <DialogContent accent="danger" aria-describedby="deletion-consequences">
      <>
        <DialogHeader>
          <DialogTitle>Delete this memory?</DialogTitle>
          <DialogDescription id="deletion-consequences">
            {loading
              ? "Working out what else this touches…"
              : total === 0
                ? "Nothing else was built on this one. Deleting it affects only itself."
                : `Deleting this affects ${total} other ${total === 1 ? "memory" : "memories"}.`}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6">
          <p className="rounded-input border border-outline-ink bg-black/[0.03] p-3 text-body-md text-ink">
            {item.content}
          </p>

          {loading && (
            <p className="mt-4 flex items-center gap-2 text-body-sm text-ink-muted">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Reading the provenance edges…
            </p>
          )}

          {error && (
            <p role="alert" className="mt-4 text-body-sm text-danger-ink">
              Could not load the preview: {error}
            </p>
          )}

          {/* The lossless text equivalent. This list is the primary artefact —
              the graph highlight behind the dialog repeats it, not the reverse. */}
          {!loading && !error && (
            <div className="mt-4 space-y-4">
              <ConsequenceGroup
                heading={`Deleted along with it — ${dies.length}`}
                explanation="These have no other source. They exist only because this one did."
                nodes={dies}
                tone="danger"
              />
              <ConsequenceGroup
                heading={`Flagged for you to check — ${flagged.length}`}
                explanation={
                  "These have another source, so they survive. They are NOT " +
                  "automatically re-derived — nothing recalculates them. They are " +
                  "marked for review so you can decide whether they still hold."
                }
                nodes={flagged}
                tone="warn"
              />
              <ConsequenceGroup
                heading={`Relationships left one-sided — ${related.length}`}
                explanation="These contradict or update the memory you are deleting. The fact survives; the relationship between the two loses one end."
                nodes={related}
                tone="warn"
              />

              {cascade && cascade.attribution_count > 0 && (
                <p className="flex items-start gap-2 text-body-sm text-ink-muted">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger-ink" aria-hidden="true" />
                  <span>
                    <span className="tnum font-medium text-ink">
                      {cascade.attribution_count}
                    </span>{" "}
                    past {cascade.attribution_count === 1 ? "answer" : "answers"} used
                    one of these. Deleting the memory does not rewrite what was
                    already said.
                  </span>
                </p>
              )}

              <p className="border-t border-outline-ink pt-3 text-body-sm text-ink-muted">
                Deleted memories are tombstoned, not erased: they stop being
                retrievable and their embedding is dropped, and the audit record
                that they existed stays.
              </p>
            </div>
          )}
        </div>

        {deleteError && (
          <p role="alert" className="px-6 pt-4 text-body-sm text-danger-ink">
            Could not delete this memory: {deleteError}. Nothing was deleted.
          </p>
        )}

        <DialogFooter>
          <Button variant="outlineInk" onClick={onClose} disabled={deleting}>
            Keep it
          </Button>
          <Button
            variant="dangerInk"
            disabled={deleting || loading}
            onClick={async () => {
              setDeleting(true);
              try {
                onDeleted(await actions.remove(item.id));
                onClose();
              } catch (e) {
                setDeleteError(e instanceof Error ? e.message : "delete failed");
              } finally {
                setDeleting(false);
              }
            }}
          >
            {deleting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-4" aria-hidden="true" />
            )}
            {dies.length > 0
              ? `Delete these ${dies.length + 1}`
              : "Delete this memory"}
          </Button>
        </DialogFooter>
      </>
    </DialogContent>
  );
}

function ConsequenceGroup({
  heading,
  explanation,
  nodes,
  tone,
}: {
  heading: string;
  explanation: string;
  nodes: GraphNode[];
  tone: "danger" | "warn";
}) {
  if (nodes.length === 0) return null;
  return (
    <section>
      <h3
        className={
          // `warn` was --stated-ink, which was orange under the old palette and
          // is green under this one (D45) — so "Flagged for you to check" was
          // being painted in the colour that means "you said this". Amber is the
          // warning tone the palette swap introduced for exactly this.
          "meta " + (tone === "danger" ? "text-danger-ink" : "text-alert-ink")
        }
      >
        {heading}
      </h3>
      <p className="mt-1 text-body-sm text-ink-muted">{explanation}</p>
      <ul className="mt-2 space-y-1.5">
        {nodes.map((n) => (
          <li key={n.id} className="flex items-start gap-2 text-body-sm text-ink">
            <SourceGlyph source={n.source_type} onLight className="mt-1.5" />
            <span>
              {n.content}
              <span className="meta ml-2 text-ink-muted">
                {SOURCE[n.source_type].label}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Relation wording, exported for the graph's edge labels so the two surfaces
 *  describe an edge identically. */
export const relationLabel = (r: string) => RELATION_LABEL[r] ?? r;
