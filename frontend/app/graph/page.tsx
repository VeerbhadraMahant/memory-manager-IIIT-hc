"use client";

// The full-page graph explorer.
//
// Opened from the memory panel's "View memory graph" link (components/
// MemoryWorkspace.tsx), in a new browser tab rather than by navigating the
// conversation away. Its own tab because the graph is exploratory — panning,
// expanding blocks, following provenance — and that does not want to compete
// with the 420px panel width or with a conversation that is still running
// underneath.
//
// It reuses <MemoryWorkspace> rather than mounting <MemoryGraph> directly, on
// purpose: that component is what makes List and Graph coequal (§2) — same
// selection, same deletion preview, same action bar. A graph-only page here
// would be exactly the "reachable only via the graph" failure principle 6
// rules out. `initialView="graph"` opens straight to the graph without writing
// that choice to the shared `nam.memory-view` key, so this tab's starting view
// does not change what the side panel shows next time. `hideExpandLink` drops
// the "open in a new tab" link this page's own visitors would find pointing
// at itself.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { MemoryLiveRegion, MemoryProvider } from "@/lib/memory-store";
import { MemoryWorkspace } from "@/components/MemoryWorkspace";

export default function GraphPage() {
  return (
    <MemoryProvider>
      <div className="mx-auto flex h-dvh w-full max-w-[1600px] flex-col px-4 py-4 md:px-8">
        <header className="mb-4 flex shrink-0 items-center gap-3">
          <Link
            href="/"
            className="tap inline-flex items-center gap-1.5 rounded-input px-2 text-body-sm text-ink-invert-muted hover:bg-raised hover:text-ink-invert"
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
            Back to conversation
          </Link>
        </header>

        {/* No relevance highlighting here — the glow tiers are driven by which
            turn is in focus in the conversation (§4.4), and this tab has no
            conversation. Nothing is lost: the same information is on the
            attribution chips in the other tab. */}
        <MemoryWorkspace relevance={null} initialView="graph" hideExpandLink />
      </div>
      <MemoryLiveRegion />
    </MemoryProvider>
  );
}
