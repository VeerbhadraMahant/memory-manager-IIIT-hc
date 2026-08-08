"use client";

// §12 — a memory the user writes themselves.
//
// Everything else in this app arrives by extraction and is then negotiated. This
// is the other direction: the user asserts something directly. It matters for the
// same reason the review card does — if the only way to correct the model's
// picture of you is to wait for it to guess, the negotiation is one-sided.
//
// Three things it deliberately does not do:
//
//  * It does not create a message to hang the memory on. Principle 7 says every
//    item traces to a source message, so this cites the most recent real one
//    instead of inventing a turn that never happened — which is why the button
//    is disabled in a chat with no messages rather than silently fabricating an
//    anchor.
//  * It does not set confidence to anything but 1.0, or source_type to anything
//    but `stated`. The user said it; there is nothing to be uncertain about and
//    nothing was inferred.
//  * It does not go through review. `review_state: accepted` — asking someone to
//    approve the thing they just typed is the consent-fatigue failure mode
//    principle 2 is written against.

import { useState } from "react";
import { Loader2, Plus } from "lucide-react";

import {
  SENSITIVITY_LABEL,
  SCOPE_LABEL,
  api,
  type AssertionStatus,
  type Scope,
  type Sensitivity,
} from "@/lib/api";
import { useMemoryStore } from "@/lib/memory-store";
import {
  SCOPES,
  SENSITIVITIES,
  STATUSES,
  STATUS_CHIP,
  blockLabel,
} from "@/lib/semantics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Blank rather than pre-filled, so "required" means something: the user picks
 *  a status and a sensitivity rather than accepting whatever happened to be
 *  first in the list. */
const BLANK = {
  content: "",
  status: "" as AssertionStatus | "",
  sensitivity: "" as Sensitivity | "",
  block: "",
  scope: "persistent" as Scope,
};

export function AddMemoryButton({
  chatId,
  /** The most recent *real* message id in the active chat. Null disables the
   *  button — see the header comment on why nothing is fabricated. */
  sourceMessageId,
  onAdded,
}: {
  chatId: string | null;
  sourceMessageId: string | null;
  onAdded: (message: string) => void;
}) {
  const { blocks, refresh, announce } = useMemoryStore();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = !!chatId && !!sourceMessageId;
  const complete = !!form.content.trim() && !!form.status && !!form.sensitivity;

  const set = <K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    if (!complete || !chatId || !sourceMessageId) return;
    setBusy(true);
    setError(null);
    try {
      await api.createItem({
        content: form.content.trim(),
        source_type: "stated",
        status: form.status as AssertionStatus,
        sensitivity: form.sensitivity as Sensitivity,
        scope: form.scope,
        confidence: 1.0,
        source_message_id: sourceMessageId,
        block_name: form.block || null,
        // Required when session-scoped, rejected when persistent — the backend
        // enforces both, and a CHECK constraint enforces it again.
        session_chat_id: form.scope === "session" ? chatId : null,
        review_state: "accepted",
        needs_review: false,
      });
      await refresh();
      announce("Added to memory.");
      onAdded("Added to memory.");
      setForm(BLANK);
      setOpen(false);
    } catch (e) {
      // Modal stays open with everything the user typed still in it: retyping a
      // paragraph because a block name was wrong is not a reasonable cost.
      setError(e instanceof Error ? e.message : "could not add that memory");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={!ready}
        title={ready ? undefined : "Say something in the conversation first"}
      >
        <Plus className="size-4" aria-hidden="true" />
        Add memory
      </Button>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a memory</DialogTitle>
            <DialogDescription>
              This is kept as something you said, at full confidence, and is not
              sent for review — you wrote it.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 px-6">
            <label className="block">
              <span className="meta mb-1 block text-ink-muted">Memory text</span>
              <textarea
                value={form.content}
                onChange={(e) => set("content", e.target.value)}
                rows={3}
                autoFocus
                className="w-full rounded-input border border-outline-ink bg-white p-3 text-body-md text-ink"
              />
            </label>

            <div className="flex flex-wrap gap-3">
              <label className="min-w-[9rem] flex-1">
                <span className="meta mb-1 block text-ink-muted">Status</span>
                <select
                  value={form.status}
                  onChange={(e) => set("status", e.target.value as AssertionStatus)}
                  className="min-h-11 w-full rounded-input border border-outline-ink bg-white px-3 text-body-sm text-ink"
                >
                  <option value="">Choose…</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_CHIP[s]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="min-w-[9rem] flex-1">
                <span className="meta mb-1 block text-ink-muted">Sensitivity</span>
                <select
                  value={form.sensitivity}
                  onChange={(e) => set("sensitivity", e.target.value as Sensitivity)}
                  className="min-h-11 w-full rounded-input border border-outline-ink bg-white px-3 text-body-sm text-ink"
                >
                  <option value="">Choose…</option>
                  {SENSITIVITIES.map((s) => (
                    <option key={s} value={s}>
                      {SENSITIVITY_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              <label className="min-w-[9rem] flex-1">
                <span className="meta mb-1 block text-ink-muted">
                  Block <span className="normal-case">(optional)</span>
                </span>
                <select
                  value={form.block}
                  onChange={(e) => set("block", e.target.value)}
                  className="min-h-11 w-full rounded-input border border-outline-ink bg-white px-3 text-body-sm text-ink"
                >
                  {/* Empty means "let the server decide", and the server's
                      choice is the most restrictive block, not a neutral one
                      (D3) — so the copy says that rather than "none". */}
                  <option value="">Most restrictive</option>
                  {blocks.map((b) => (
                    <option key={b} value={b}>
                      {blockLabel(b)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="min-w-[9rem] flex-1">
                <span className="meta mb-1 block text-ink-muted">Scope</span>
                <select
                  value={form.scope}
                  onChange={(e) => set("scope", e.target.value as Scope)}
                  className="min-h-11 w-full rounded-input border border-outline-ink bg-white px-3 text-body-sm text-ink"
                >
                  {SCOPES.map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {error && (
              <p role="alert" className="text-body-sm text-danger-ink">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="ghostInk"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!complete || busy}
              onClick={() => void submit()}
            >
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              Add memory
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
