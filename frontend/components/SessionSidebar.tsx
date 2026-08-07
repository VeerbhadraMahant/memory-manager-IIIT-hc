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

import { useRef } from "react";
import { PanelLeftClose, PanelLeftOpen, SquarePen } from "lucide-react";

import type { Chat } from "@/lib/api";
import { useFocusTrap } from "@/lib/shell";
import { cn } from "@/lib/utils";

const VISIBLE_SESSIONS = 6;

export function SessionSidebar({
  chats,
  currentId,
  collapsed,
  open,
  overlay,
  onToggle,
  onSelect,
  onNew,
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
}) {
  const panel = useRef<HTMLElement>(null);
  useFocusTrap(panel, overlay && open, onToggle);

  const older = chats.length - VISIBLE_SESSIONS;

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

          {/* Capped at six. Test runs accumulate sessions quickly, and an
              unbounded list would push the product title off the bottom; older
              sessions stay accounted for through the count rather than
              vanishing silently. */}
          <nav aria-label="Session list" className="min-h-0">
            <ul className="space-y-1">
              {chats.slice(0, VISIBLE_SESSIONS).map((ch) => {
                const title = ch.title ?? "Untitled";
                const current = ch.id === currentId;
                return (
                  <li key={ch.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(ch.id)}
                      aria-current={current ? "true" : undefined}
                      // Always set, not only when collapsed. The visible label
                      // lives in a second <span> alongside the (hidden, but
                      // still in the DOM) avatar span, and Chrome's real
                      // accessibility tree returns an *empty* name for a button
                      // whose text is split across sibling elements like that —
                      // confirmed by inspecting the computed AX node directly,
                      // not assumed. An explicit aria-label is the one path that
                      // reliably works here regardless of that split.
                      aria-label={title}
                      title={collapsed ? title : undefined}
                      className={cn(
                        "tap flex w-full items-center gap-2 rounded-input px-3 text-left text-body-sm transition-colors duration-[var(--motion-micro)]",
                        current
                          ? "bg-accent-dim text-ink-invert"
                          : "text-ink-invert-muted hover:bg-raised hover:text-ink-invert",
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
                      <span className={cn("truncate", collapsed && "lg:hidden")}>
                        {title}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {older > 0 && (
              <p
                className={cn(
                  "meta tnum px-3 pt-2 text-ink-invert-muted",
                  collapsed && "lg:text-center lg:px-0",
                )}
              >
                +{older} <span className={cn(collapsed && "lg:hidden")}>older</span>
              </p>
            )}
          </nav>
        </div>

        {/* De-emphasised: the product name is orientation, not a heading the eye
            should return to. It is still the page's h1. */}
        <div
          className={cn(
            "shrink-0 border-t border-outline px-3 py-3",
            collapsed && "lg:hidden",
          )}
        >
          <h1 className="text-body-sm font-medium text-ink-invert-muted">
            Negotiated AI Memory
          </h1>
          <p className="mt-0.5 text-body-sm text-ink-invert-muted">
            You decide what is remembered, as it happens.
          </p>
        </div>
      </aside>
    </>
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
