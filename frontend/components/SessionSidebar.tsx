"use client";

// Zone 1 of the shell — sessions.
//
// The switcher used to be a wrapping row of pills in the page <header>, which
// put it in competition with the conversation for horizontal space and pushed
// the transcript down the page as sessions accumulated. It is the same control
// with the same 6-item cap; only the axis changed.
//
// P3's claim — a session-only memory does not survive into a new conversation —
// is only demonstrable if switching sessions is one visible click away at all
// times, so this is a permanent zone at ≥1024px rather than something you open.
//
// Collapsed, it keeps every session reachable: the row becomes its first-letter
// avatar and the title moves into `title` + `aria-label`, so nothing is lost to
// a screen reader or to a pointer that hovers. The avatar carries the letter
// rather than a MessageSquare, because six identical glyphs in a 56px rail are
// not a session list — and with titles like "Session 3" the letter is thin
// information too, which is why the label is on the element rather than implied
// by it.

import { useEffect, useRef, useState } from "react";
import {
  Check,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Settings,
  SquarePen,
  Trash2,
  User,
  X,
} from "lucide-react";

import type { Chat } from "@/lib/api";
import { useFocusTrap } from "@/lib/shell";
import { cn } from "@/lib/utils";

export function SessionSidebar({
  chats,
  currentId,
  collapsed,
  open,
  overlay,
  onToggle,
  onSelect,
  onNew,
  onRename,
  onDelete,
  profileLabel,
  onOpenProfile,
  onOpenSettings,
}: {
  chats: Chat[];
  currentId: string | null;
  /** ≥1024px: 260px sidebar (false) or 56px icon rail (true). */
  collapsed: boolean;
  /** <1024px: is the drawer showing? */
  open: boolean;
  /** <1024px, where the sidebar covers the conversation instead of sitting beside it. */
  overlay: boolean;
  /** Collapses the rail on desktop, closes the drawer as an overlay. */
  onToggle: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  /** Opens the confirmation. Deleting also removes memories confined to the chat,
   *  so this never fires straight from a click in the list. */
  onDelete: (chat: Chat) => void;
  /** Who you are acting as. `null` while /me is still in flight. */
  profileLabel: string | null;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel, overlay && open, onToggle);

  return (
    <>
      {/* Scrim, drawer only. Not rendered at ≥1024px, where there is nothing to
          dismiss. */}
      {overlay && open && (
        <div
          aria-hidden="true"
          onClick={onToggle}
          className="fixed inset-0 z-30 bg-[color:var(--ink)]/40 lg:hidden"
        />
      )}

      <aside
        ref={panel}
        id="session-sidebar"
        aria-label="Sessions"
        // -1, not 0: the drawer takes focus when it opens over the conversation
        // (useFocusTrap) but is never a tab stop of its own on the way past.
        tabIndex={-1}
        className={cn(
          // Drawer below 1024px…
          // max-lg on the width for the same reason as the memory panel: an
          // unprefixed arbitrary w-[260px] sorts after lg:w-14 in Tailwind v4
          // and the rail would never narrow.
          "fixed inset-y-0 left-0 z-40 flex max-lg:w-[260px] flex-col border-r border-outline bg-sunken",
          // §5's blanket prefers-reduced-motion override in globals.css flattens
          // this to 1ms; there is no per-component opt-out to remember.
          "transition-[width,transform] duration-[var(--motion-state)]",
          open ? "translate-x-0" : "invisible -translate-x-full",
          // …and a column of the shell from 1024px up, where it is never absent,
          // only narrow. `visible` undoes the drawer's closed state, which does
          // not apply once it is in flow.
          "lg:visible lg:static lg:z-auto lg:translate-x-0",
          collapsed ? "lg:w-14" : "lg:w-[260px]",
        )}
      >
        <div
          className={cn(
            "flex shrink-0 items-center border-b border-outline px-2 py-2",
            collapsed ? "lg:justify-center" : "justify-end",
          )}
        >
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={overlay ? open : !collapsed}
            aria-controls="session-sidebar"
            aria-label={
              overlay
                ? "Hide sessions"
                : collapsed
                  ? "Expand the session sidebar"
                  : "Collapse the session sidebar"
            }
            title={
              overlay
                ? "Hide sessions"
                : collapsed
                  ? "Expand sessions"
                  : "Collapse sessions"
            }
            className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted hover:bg-raised hover:text-ink-invert"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-5" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
          {/* The primary affordance of this zone, so it is a filled button
              rather than the dashed pill it was in the header. */}
          <button
            type="button"
            onClick={onNew}
            title="New session"
            aria-label="New session"
            className={cn(
              "tap inline-flex shrink-0 items-center gap-2 rounded-input bg-accent px-3 text-body-sm font-medium text-white hover:brightness-110",
              collapsed && "lg:justify-center lg:px-0",
            )}
          >
            <SquarePen
              className={cn("shrink-0", collapsed ? "lg:size-5" : "size-4")}
              aria-hidden="true"
            />
            <span className={cn("truncate", collapsed && "lg:hidden")}>
              New session
            </span>
          </button>

          {/* The six-item cap is gone. It existed so an unbounded list could not
              push the product title off the bottom, and the title has moved to
              Profile/Settings below — but the real reason is that a chat you
              cannot see is a chat you cannot delete, which would make "manage
              chats" a feature you can only use on your seven most recent. The
              parent already scrolls, and the footer is a shrink-0 sibling, so
              nothing gets pushed anywhere. */}
          <nav aria-label="Session list" className="min-h-0">
            <ul className="space-y-1">
              {chats.map((ch) => (
                <SessionRow
                  key={ch.id}
                  chat={ch}
                  current={ch.id === currentId}
                  collapsed={collapsed}
                  onSelect={onSelect}
                  onRename={onRename}
                  onDelete={onDelete}
                />
              ))}
            </ul>
            {chats.length === 0 && (
              <p
                className={cn(
                  "px-3 pt-2 text-body-sm text-ink-invert-muted",
                  collapsed && "lg:hidden",
                )}
              >
                No sessions yet.
              </p>
            )}
          </nav>
        </div>

        {/* Identity and settings, pinned. Replaces the product blurb that used to
            sit here: orientation is worth one line, but not a permanent one at the
            bottom of every screen, and the h1 it carried is redundant with the
            document title. */}
        <div className="shrink-0 space-y-1 border-t border-outline p-2">
          <SidebarEntry
            icon={<User className="size-4 shrink-0" aria-hidden="true" />}
            label={profileLabel ?? "Profile"}
            collapsed={collapsed}
            onClick={onOpenProfile}
          />
          <SidebarEntry
            icon={<Settings className="size-4 shrink-0" aria-hidden="true" />}
            label="Settings"
            collapsed={collapsed}
            onClick={onOpenSettings}
          />
        </div>
      </aside>
    </>
  );
}

/**
 * One session: select, rename in place, or delete.
 *
 * Rename is inline rather than a dialog, matching how the review card and the
 * memory action bar already handle a correction — the thing you are changing stays
 * on screen while you change it.
 *
 * The two action buttons are always rendered, never hover-only. Hover-only controls
 * are unreachable by keyboard and by touch, and this row is the only route to
 * deleting a chat.
 */
function SessionRow({
  chat,
  current,
  collapsed,
  onSelect,
  onRename,
  onDelete,
}: {
  chat: Chat;
  current: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (chat: Chat) => void;
}) {
  const title = chat.title ?? "Untitled";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const begin = () => {
    setDraft(title);
    setEditing(true);
  };

  const commit = async () => {
    const next = draft.trim();
    // Unchanged or emptied is a cancel, not an error. The server rejects a blank
    // title too (ChatUpdate), but bothering the user with a 422 for pressing Enter
    // on an empty box would be the interface blaming them for its own affordance.
    if (!next || next === title) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onRename(chat.id, next);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (editing && !collapsed) {
    return (
      <li>
        <div className="flex items-center gap-1 rounded-input bg-raised px-1 py-1">
          <label className="sr-only" htmlFor={`rename-${chat.id}`}>
            Rename session
          </label>
          <input
            id={`rename-${chat.id}`}
            ref={input}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commit();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                // Stopped here so Escape renames-cancel rather than also closing
                // the drawer this row sits inside.
                e.stopPropagation();
                setEditing(false);
              }
            }}
            className="min-w-0 flex-1 rounded-input border border-outline-strong bg-bg px-2 py-1 text-body-sm text-ink-invert"
          />
          <button
            type="button"
            onClick={() => void commit()}
            disabled={busy}
            aria-label="Save session name"
            title="Save"
            className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted hover:text-ink-invert"
          >
            <Check className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={busy}
            aria-label="Cancel renaming"
            title="Cancel"
            className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted hover:text-ink-invert"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={cn(
        "group flex items-center gap-1 rounded-input transition-colors duration-[var(--motion-micro)]",
        current ? "bg-accent-dim" : "hover:bg-raised",
      )}
    >
      <button
        type="button"
        onClick={() => onSelect(chat.id)}
        aria-current={current ? "true" : undefined}
        // Always set, not only when collapsed. The visible label lives in a second
        // <span> alongside the (hidden, but still in the DOM) avatar span, and
        // Chrome's real accessibility tree returns an *empty* name for a button
        // whose text is split across sibling elements like that — confirmed by
        // inspecting the computed AX node directly, not assumed.
        aria-label={title}
        title={collapsed ? title : undefined}
        className={cn(
          "tap flex min-w-0 flex-1 items-center gap-2 rounded-input px-3 text-left text-body-sm",
          current ? "text-ink-invert" : "text-ink-invert-muted group-hover:text-ink-invert",
          collapsed && "lg:justify-center lg:px-0",
        )}
      >
        <span
          className={cn(
            "hidden shrink-0 items-center justify-center rounded-input border border-outline-strong text-body-sm font-medium",
            collapsed && "lg:flex lg:size-8",
          )}
        >
          {title.slice(0, 1).toUpperCase()}
        </span>
        <span className={cn("truncate", collapsed && "lg:hidden")}>{title}</span>
      </button>

      {/* Hidden on the 56px rail: there is no room, and both actions stay reachable
          by expanding the sidebar. */}
      <span className={cn("flex shrink-0 items-center pr-1", collapsed && "lg:hidden")}>
        <button
          type="button"
          onClick={begin}
          aria-label={`Rename ${title}`}
          title="Rename"
          className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted opacity-60 hover:bg-sunken hover:text-ink-invert focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(chat)}
          aria-label={`Delete ${title}`}
          title="Delete"
          className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted opacity-60 hover:bg-sunken hover:text-danger-on-bg focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}

/** A footer row. Icon-only on the rail, icon + label when expanded. */
function SidebarEntry({
  icon,
  label,
  collapsed,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={collapsed ? label : undefined}
      className={cn(
        "tap flex w-full items-center gap-2 rounded-input px-3 text-left text-body-sm text-ink-invert-muted hover:bg-raised hover:text-ink-invert",
        collapsed && "lg:justify-center lg:px-0",
      )}
    >
      {icon}
      <span className={cn("truncate", collapsed && "lg:hidden")}>{label}</span>
    </button>
  );
}

/** Opens the drawer. Lives in the conversation's top bar, because below 1024px
 *  the sidebar is off screen and needs a way back that is not off screen too. */
export function SidebarOpenButton({
  open,
  onOpen,
}: {
  open: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-expanded={open}
      aria-controls="session-sidebar"
      aria-label="Show sessions"
      title="Show sessions"
      className="tap inline-flex items-center justify-center rounded-input text-ink-invert-muted hover:bg-raised hover:text-ink-invert lg:hidden"
    >
      <PanelLeftOpen className="size-5" aria-hidden="true" />
    </button>
  );
}
