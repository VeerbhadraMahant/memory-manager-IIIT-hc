"use client";

// The three dialogs the sidebar opens: delete-a-chat, Profile, Settings.
//
// Kept out of SessionSidebar.tsx because the sidebar is rendered twice on some
// breakpoints (drawer + rail states share one component, but the tree is mounted
// once) and because a confirmation that owns a network call has different concerns
// from a list row.

import { useState } from "react";
import { Download, Loader2, Trash2 } from "lucide-react";

import { api, type Chat, type ChatDeleted, type Me } from "@/lib/api";
import { useMemoryConsent } from "@/lib/consent";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Deleting a chat is not just closing a tab — it tombstones the memories that were
 * confined to that chat. So the dialog states that consequence before the click
 * rather than reporting it after, and it distinguishes the two outcomes explicitly:
 * "this chat only" memories go, memories you kept do not.
 *
 * Phrased as consequence, not caution (principle 4). No "are you sure".
 */
export function DeleteChatDialog({
  chat,
  onClose,
  onConfirm,
}: {
  chat: Chat | null;
  onClose: () => void;
  onConfirm: (chat: Chat) => Promise<ChatDeleted>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open={!!chat}
      onOpenChange={(next) => {
        if (busy) return;
        if (!next) {
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent accent="danger">
        <DialogHeader>
          <DialogTitle>Delete “{chat?.title ?? "Untitled"}”?</DialogTitle>
          <DialogDescription>
            The conversation goes, and so do the memories that were kept to this chat
            only — they were never usable anywhere else. Memories you chose to keep
            beyond this chat stay, and so does the record that they came from here.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="px-6 text-body-sm text-danger-ink">
            Could not delete this chat: {error}. Nothing was deleted.
          </p>
        )}

        <DialogFooter>
          <Button variant="outlineInk" disabled={busy} onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="dangerInk"
            disabled={busy || !chat}
            onClick={async () => {
              if (!chat) return;
              setBusy(true);
              setError(null);
              try {
                await onConfirm(chat);
                onClose();
              } catch (e) {
                setError(e instanceof Error ? e.message : "delete failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="size-4" aria-hidden="true" />
            )}
            Delete chat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who you are acting as.
 *
 * Reports the `users` row from GET /me rather than inventing an account card. There
 * is no sign-in yet, and this says so in those words instead of showing a
 * placeholder avatar and a fake name — which would be the one thing an onboarding
 * flow about honest memory cannot afford to do.
 */
export function ProfileDialog({
  me,
  open,
  onClose,
  onSignOut,
}: {
  me: Me | null;
  open: boolean;
  onClose: () => void;
  /** Absent when no one is signed in (demo mode), so the button is not offered. */
  onSignOut?: () => void;
}) {
  const [busy, setBusy] = useState<"export" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");

  // The shared demo account cannot be erased (the server refuses with 403), and exporting
  // it would hand out other demo users' data, so neither is offered.
  const ownAccount = !!me && !me.is_demo_user;

  const close = () => {
    setConfirming(false);
    setTyped("");
    setError(null);
    onClose();
  };

  const exportData = async () => {
    setBusy("export");
    setError(null);
    try {
      const data = await api.exportData();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "negotiated-memory-export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    setBusy("delete");
    setError(null);
    try {
      await api.deleteAccount();
      close();
      onSignOut?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Deleting the account failed.");
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent accent={confirming ? "danger" : undefined}>
        <DialogHeader>
          <DialogTitle>Profile</DialogTitle>
          <DialogDescription>
            Everything on this screen is read from the database, not from the client.
          </DialogDescription>
        </DialogHeader>

        <dl className="space-y-2 px-6">
          <Field label="Signed in as" value={me?.name ?? me?.handle ?? "…"} />
          {me?.email && <Field label="Email" value={me.email} />}
          <Field label="User id" value={me?.id ?? "…"} mono />
          <Field
            label="Account created"
            value={me ? new Date(me.created_at).toLocaleString() : "…"}
          />
        </dl>

        {me?.is_demo_user && (
          <p className="mt-3 px-6 text-body-sm text-ink-muted">
            This is the shared demo account. The server is not requiring sign-in, so
            every request acts as this user — which is why there is nothing here to edit.
          </p>
        )}

        {ownAccount && (
          <div className="mt-5 space-y-3 px-6">
            <div className="flex items-center justify-between gap-3 border-t border-outline-ink pt-4">
              <p className="text-body-sm text-ink-muted">
                Everything stored about you — chats, memories, child notes and the audit
                trail — as one JSON file.
              </p>
              <Button variant="outlineInk" size="sm" onClick={exportData} disabled={busy !== null}>
                {busy === "export" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
                )}
                Download
              </Button>
            </div>

            {!confirming ? (
              <div className="flex items-center justify-between gap-3 border-t border-outline-ink pt-4">
                <p className="text-body-sm text-ink-muted">
                  Permanently erase your account and everything in it.
                </p>
                <Button variant="dangerInk" size="sm" onClick={() => setConfirming(true)} disabled={busy !== null}>
                  <Trash2 className="size-4" aria-hidden="true" />
                  Delete account
                </Button>
              </div>
            ) : (
              <div className="space-y-3 border-t border-outline-ink pt-4" role="group" aria-label="Confirm account deletion">
                <p className="text-body-sm text-ink">
                  This cannot be undone. Unlike deleting a single memory, nothing is kept as a
                  tombstone — your chats, memories and audit trail are erased. Download your data
                  first if you want a copy.
                </p>
                <label className="block text-body-sm text-ink-muted" htmlFor="confirm-delete">
                  Type <span className="font-mono text-ink">delete</span> to confirm
                </label>
                <input
                  id="confirm-delete"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoComplete="off"
                  className="min-h-11 w-full rounded-input border border-outline-ink bg-sunken px-3 text-body-sm text-ink"
                />
                <div className="flex gap-2">
                  <Button
                    variant="dangerInk"
                    size="sm"
                    onClick={deleteAccount}
                    disabled={typed.trim().toLowerCase() !== "delete" || busy !== null}
                  >
                    {busy === "delete" && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
                    Delete everything
                  </Button>
                  <Button
                    variant="ghostInk"
                    size="sm"
                    onClick={() => {
                      setConfirming(false);
                      setTyped("");
                    }}
                    disabled={busy !== null}
                  >
                    Keep my account
                  </Button>
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="text-body-sm text-danger-ink">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {onSignOut && (
            <Button variant="outlineInk" onClick={onSignOut}>
              Sign out
            </Button>
          )}
          <Button variant="outlineInk" onClick={close}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-outline-ink pb-2">
      <dt className="meta text-ink-muted">{label}</dt>
      <dd className={mono ? "meta text-ink" : "text-body-sm text-ink"}>{value}</dd>
    </div>
  );
}

/**
 * Settings.
 *
 * Contains only controls that do something today. The memory opt-in is *mirrored*
 * here rather than moved: the onboarding dialog promises it can be changed "from the
 * memory panel", and quietly relocating it would break that promise. Both surfaces
 * read the same store (lib/consent.ts), which notifies in-tab, so they cannot
 * disagree.
 */
export function SettingsDialog({
  open,
  onClose,
  onReplayOnboarding,
}: {
  open: boolean;
  onClose: () => void;
  onReplayOnboarding: () => void;
}) {
  const [consent, setConsent] = useMemoryConsent();
  const on = consent !== "declined";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Only what is wired up. Retention windows and account settings arrive with
            the features themselves rather than as switches that do nothing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-6">
          <section className="rounded-input border border-outline-ink p-3">
            <h3 className="text-body-sm font-medium text-ink">
              Memory is {on ? "on" : "off"}
            </h3>
            <p className="mt-1 text-body-sm text-ink-muted">
              {on
                ? "Facts are proposed after each turn and kept once you accept them."
                : "Every message starts off the record, so nothing new is extracted. Memories kept earlier are still here."}
            </p>
            <Button
              variant="outlineInk"
              size="sm"
              className="mt-2"
              onClick={() => setConsent(on ? "declined" : "accepted")}
            >
              Turn memory {on ? "off" : "on"}
            </Button>
          </section>

          <section className="rounded-input border border-outline-ink p-3">
            <h3 className="text-body-sm font-medium text-ink">
              Show the introduction again
            </h3>
            <p className="mt-1 text-body-sm text-ink-muted">
              Replays what this remembers, the disclaimer, and the opt-in choice.
              Your current decision stays until you change it on the last step.
            </p>
            <Button
              variant="outlineInk"
              size="sm"
              className="mt-2"
              onClick={() => {
                onReplayOnboarding();
                onClose();
              }}
            >
              Replay the introduction
            </Button>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outlineInk" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
