"use client";

// The list view. §2 and CLAUDE.md principle 6: "List view is primary and must be
// complete. Keyboard-navigable, screen-reader safe, WCAG 2.2 AA."
//
// Complete means every memory operation is reachable here, keyboard only — which
// it is, because the per-row controls are the shared <MemoryActionBar> and there
// is no action in this file that the graph's detail panel does not also mount.
//
// Two things worth knowing about the interaction model:
//
//  * Rows are <details>/<summary>. That buys correct expand/collapse semantics,
//    Enter and Space, and the expanded state announced — none of which a div
//    with an onClick would have, and all of which would otherwise be hand-built
//    ARIA that goes stale.
//  * Filtering runs client-side over the already-loaded list rather than
//    refetching. Typing in a search box should not be able to produce a network
//    error, and the whole store is 200 rows.

import { useDeferredValue, useMemo, useState } from "react";
import { CheckCheck, Filter, Search, X } from "lucide-react";

import {
  SCOPE_LABEL,
  SENSITIVITY_LABEL,
  type AssertionStatus,
  type MemoryItem,
  type Scope,
  type Sensitivity,
} from "@/lib/api";
import { useMemoryActions, useMemoryStore } from "@/lib/memory-store";
import {
  SCOPES,
  SENSITIVITIES,
  STATUSES,
  STATUS_CHIP,
  blockLabel,
  describeMemory,
  isStale,
  lastConfirmedLabel,
  statusTone,
} from "@/lib/semantics";
import { cn } from "@/lib/utils";
import { MemoryActionBar } from "@/components/MemoryActionBar";
import { Button } from "@/components/ui/button";
import { Chip, SourceChip, SourceGlyph } from "@/components/ui/chip";

interface Filters {
  q: string;
  block: string | null;
  status: AssertionStatus | null;
  sensitivity: Sensitivity | null;
  scope: Scope | null;
  pendingOnly: boolean;
  staleOnly: boolean;
}

const EMPTY: Filters = {
  q: "",
  block: null,
  status: null,
  sensitivity: null,
  scope: null,
  pendingOnly: false,
  staleOnly: false,
};

export function MemoryList({
  selectedId,
  onSelect,
  onRequestDelete,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRequestDelete: (item: MemoryItem) => void;
}) {
  const { items, blocks, loading, error } = useMemoryStore();
  const actions = useMemoryActions();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Keeps typing responsive on a long list without debouncing by hand, and
  // without the "search lags one character behind" bug that a manual debounce
  // usually ships with.
  const q = useDeferredValue(filters.q).trim().toLowerCase();

  const shown = useMemo(
    () =>
      items.filter((i) => {
        if (q && !i.content.toLowerCase().includes(q)) return false;
        if (filters.block && (i.block_name ?? "unclassified") !== filters.block) return false;
        if (filters.status && i.status !== filters.status) return false;
        if (filters.sensitivity && i.sensitivity !== filters.sensitivity) return false;
        if (filters.scope && i.scope !== filters.scope) return false;
        if (filters.pendingOnly && i.review_state !== "pending") return false;
        if (filters.staleOnly && !isStale(i)) return false;
        return true;
      }),
    [items, q, filters],
  );

  const active =
    !!filters.q ||
    !!filters.block ||
    !!filters.status ||
    !!filters.sensitivity ||
    !!filters.scope ||
    filters.pendingOnly ||
    filters.staleOnly;

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const toggle = (id: string) =>
    setSelection((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Bulk actions run sequentially rather than with Promise.all: each one is an
   *  announced state change, and firing twenty at once produces twenty
   *  overlapping aria-live messages that say nothing. */
  const bulk = async (fn: (id: string) => Promise<unknown>) => {
    setBulkBusy(true);
    try {
      for (const id of selection) await fn(id);
      setSelection(new Set());
    } finally {
      setBulkBusy(false);
    }
  };

  const selectedPending = [...selection].filter(
    (id) => items.find((i) => i.id === id)?.review_state === "pending",
  );

  return (
    <section aria-label="All memory" className="flex min-h-0 flex-1 flex-col gap-4">
      {/* --------------------------------------------------------- filters */}
      <div className="rounded-card border border-outline bg-raised p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="meta mb-1.5 block text-ink-invert-muted">
              Search memory
            </span>
            <span className="relative block">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-invert-muted"
              />
              <input
                type="search"
                value={filters.q}
                onChange={(e) => set("q", e.target.value)}
                placeholder="what does it know about…"
                className="min-h-11 w-full rounded-input border border-outline-strong bg-sunken pl-9 pr-3 text-body-md text-ink-invert placeholder:text-ink-invert-muted"
              />
            </span>
          </label>

          {active && (
            <Button variant="outline" onClick={() => setFilters(EMPTY)}>
              <X className="size-4" aria-hidden="true" />
              Clear filters
            </Button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="meta flex items-center gap-1.5 text-ink-invert-muted">
            <Filter className="size-3.5" aria-hidden="true" />
            Filter
          </span>
          <FilterSelect
            label="Block"
            value={filters.block}
            options={blocks.map((b) => [b, blockLabel(b)] as const)}
            onChange={(v) => set("block", v)}
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            options={STATUSES.map((s) => [s, STATUS_CHIP[s]] as const)}
            onChange={(v) => set("status", v as AssertionStatus | null)}
          />
          <FilterSelect
            label="Sensitivity"
            value={filters.sensitivity}
            options={SENSITIVITIES.map((s) => [s, SENSITIVITY_LABEL[s]] as const)}
            onChange={(v) => set("sensitivity", v as Sensitivity | null)}
          />
          <FilterSelect
            label="Scope"
            value={filters.scope}
            options={SCOPES.map((s) => [s, SCOPE_LABEL[s]] as const)}
            onChange={(v) => set("scope", v as Scope | null)}
          />
          <FilterToggle
            pressed={filters.pendingOnly}
            onPressedChange={(v) => set("pendingOnly", v)}
          >
            Awaiting review
          </FilterToggle>
          <FilterToggle
            pressed={filters.staleOnly}
            onPressedChange={(v) => set("staleOnly", v)}
          >
            Stale
          </FilterToggle>
        </div>

        {/* The result count is a live region: a filter change that returns
            nothing must be audible, not just visible (§6). */}
        <p aria-live="polite" className="meta mt-3 tnum text-ink-invert-muted">
          {loading
            ? "loading…"
            : `${shown.length} of ${items.length} ${items.length === 1 ? "memory" : "memories"}`}
        </p>
      </div>

      {/* ----------------------------------------------------- bulk actions */}
      {selection.size > 0 && (
        <div
          role="group"
          aria-label="Actions for selected memories"
          className="flex flex-wrap items-center gap-2 rounded-card border border-accent/40 bg-accent-dim p-3"
        >
          <span className="meta tnum text-accent">
            {selection.size} selected
          </span>
          {selectedPending.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              disabled={bulkBusy}
              onClick={() => void bulk(actions.accept)}
            >
              <CheckCheck className="size-4" aria-hidden="true" />
              Keep {selectedPending.length}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={bulkBusy}
            onClick={() => void bulk((id) => actions.rescope(id, "session"))}
          >
            Only this chat
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkBusy}
            onClick={() => void bulk(actions.confirm)}
          >
            Still true
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={bulkBusy}
            onClick={() => void bulk(actions.reject)}
          >
            Discard
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setSelection(new Set())}
          >
            Clear selection
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-card border border-danger bg-danger-dim p-3 text-body-sm text-danger-on-bg">
          {error}
        </p>
      )}

      {/* ------------------------------------------------------------ rows */}
      {shown.length === 0 ? (
        <div className="rounded-card border border-dashed border-outline-strong p-8 text-center">
          <p className="text-body-md text-ink-invert">
            {items.length === 0
              ? "Nothing is remembered yet."
              : "No memory matches those filters."}
          </p>
          <p className="mt-1 text-body-sm text-ink-invert-muted">
            {items.length === 0
              ? "Say something in the conversation and decide what it keeps."
              : "Widen the filters, or clear them."}
          </p>
          {active && items.length > 0 && (
            <Button variant="outline" className="mt-4" onClick={() => setFilters(EMPTY)}>
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map((item) => (
            <Row
              key={item.id}
              item={item}
              open={item.id === selectedId}
              onOpenChange={(open) => onSelect(open ? item.id : null)}
              checked={selection.has(item.id)}
              onCheck={() => toggle(item.id)}
              onRequestDelete={onRequestDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Row({
  item,
  open,
  onOpenChange,
  checked,
  onCheck,
  onRequestDelete,
}: {
  item: MemoryItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checked: boolean;
  onCheck: () => void;
  onRequestDelete: (item: MemoryItem) => void;
}) {
  const stale = isStale(item);
  const pending = item.review_state === "pending";

  return (
    <li>
      <div
        className={cn(
          "overflow-hidden rounded-card border bg-raised transition-colors duration-[var(--motion-micro)]",
          open ? "border-stated" : "border-outline",
          stale && !open && "border-danger/50",
        )}
      >
        <div className="flex items-start gap-2 p-2 pl-3">
          {/* The bulk-select checkbox sits outside the <summary>, or expanding
              the row and selecting it would be the same activation. */}
          <label className="tap flex items-center justify-center">
            <span className="sr-only">Select for bulk action: {item.content}</span>
            <input
              type="checkbox"
              checked={checked}
              onChange={onCheck}
              className="size-4 accent-[color:var(--stated)]"
            />
          </label>

          <details
            open={open}
            onToggle={(e) => onOpenChange((e.currentTarget as HTMLDetailsElement).open)}
            className="min-w-0 flex-1"
          >
            <summary
              className="tap flex cursor-pointer list-none flex-col gap-1.5 rounded-input px-2 py-2 marker:hidden hover:bg-black/[0.04] [&::-webkit-details-marker]:hidden"
              // The full sentence, so a screen reader gets the whole memory from
              // the row without expanding it (§6, and the same string the graph
              // node is labelled with).
              aria-label={describeMemory(item)}
            >
              <span className="flex items-start gap-2">
                <SourceGlyph source={item.source_type} className="mt-1.5" />
                <span className="measure text-body-md text-ink-invert">
                  {item.content}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <Chip>{blockLabel(item.block_name ?? "unclassified")}</Chip>
                <Chip tone={statusTone(item)}>
                  {STATUS_CHIP[item.status]}
                  {stale && " · stale"}
                </Chip>
                {item.scope === "session" && <Chip tone="alert">this chat only</Chip>}
                {pending && <Chip tone="alert">awaiting review</Chip>}
                {item.needs_review && !pending && (
                  <Chip tone="danger">flagged for review</Chip>
                )}
                <SourceChip source={item.source_type} />
              </span>
            </summary>

            {open && (
              <div className="on-surface anim-enter mt-2 rounded-card bg-surface p-4">
                {item.evidence && (
                  <p className="mb-3 border-l-2 border-stated pl-3 text-body-sm italic text-ink-muted">
                    &ldquo;{item.evidence}&rdquo;
                    <span className="meta ml-2 not-italic">from your message</span>
                  </p>
                )}
                {item.review_reason && (
                  <p className="mb-3 text-body-sm text-ink-muted">
                    {item.review_reason}
                  </p>
                )}
                {/* Decay, made legible. "Still true" resets this clock, so the
                    user needs to see what the clock currently says before
                    deciding whether pressing it is warranted. */}
                <p className="meta mb-3 text-ink-muted">
                  Last confirmed: {lastConfirmedLabel(item.last_confirmed_at)}
                </p>
                <MemoryActionBar item={item} onRequestDelete={onRequestDelete} />
              </div>
            )}
          </details>
        </div>
      </div>
    </li>
  );
}

/** A filter is a native select with an "any" option, not a popover of
 *  checkboxes: one interaction, keyboard-operable, and it announces its own
 *  current value without a word of ARIA. */
function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: readonly (readonly [string, string])[];
  onChange: (v: string | null) => void;
}) {
  return (
    <label
      className={cn(
        "meta inline-flex min-h-11 items-center gap-1.5 rounded-pill px-3 ring-1",
        value ? "bg-accent-dim text-accent ring-accent/40" : "bg-black/5 text-ink-invert-muted ring-outline",
      )}
    >
      <span>{label}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="meta cursor-pointer bg-transparent text-inherit outline-none"
        aria-label={`Filter by ${label.toLowerCase()}`}
      >
        <option value="">any</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** aria-pressed rather than a checkbox: this toggles a view, it does not record
 *  a value, and the two are announced differently. */
function FilterToggle({
  pressed,
  onPressedChange,
  children,
}: {
  pressed: boolean;
  onPressedChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "meta min-h-11 rounded-pill px-3 ring-1 transition-colors duration-[var(--motion-micro)]",
        pressed
          ? "bg-accent-dim text-accent ring-accent/40"
          : "bg-black/5 text-ink-invert-muted ring-outline hover:text-ink-invert",
      )}
    >
      {children}
    </button>
  );
}
