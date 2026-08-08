"use client";

// The conversation, plus the memory workspace it feeds.
//
// P1 core loop + P3 session scoping + P6 attribution + P7 pre-send intervention.
//
// The session switcher is not a convenience feature — P3's whole claim is that a
// session-only memory does not survive into a new conversation, and that is not
// demonstrable without somewhere else to stand.
//
// Layout: three zones — sessions left, conversation centre, memory right.
//
// Two earlier arrangements and what each got wrong. The workspace first sat
// *below* the conversation, which put the graph under the fold: a memory forming
// and the graph reacting to it could never be on screen together, which is the
// whole point of retrieval highlighting. A permanent 50/50 split fixed that and
// introduced the opposite problem — memory competed with the conversation at
// every moment, including the moments when the conversation was the thing to
// read, and on a projector the transcript lost.
//
// So memory keeps its column and the column collapses (components/MemoryPanel).
// The conversation is capped at 760px and centred in what is left, and the
// session switcher moved out of the page header into a real sidebar, where it
// stops competing with the transcript for horizontal space.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Cpu, EyeOff, Info, Loader2, Send } from "lucide-react";

import { AttributionChips } from "@/components/Attribution";
import { DraftPanel } from "@/components/DraftPanel";
import { EmptyHeading, SuggestionCards } from "@/components/EmptyState";
import { MemoryPanel, MemoryPanelToggle } from "@/components/MemoryPanel";
import { Onboarding } from "@/components/Onboarding";
import { PiiModal, PiiStrip } from "@/components/PiiIntervention";
import { ReviewCard } from "@/components/ReviewCard";
import {
  DeleteChatDialog,
  ProfileDialog,
  SettingsDialog,
} from "@/components/SessionDialogs";
import { SessionSidebar, SidebarOpenButton } from "@/components/SessionSidebar";
import { MemoryTimeline } from "@/components/MemoryTimeline";
import { ThinkingPanel } from "@/components/TurnInsight";
import { Button } from "@/components/ui/button";
import {
  MemoryLiveRegion,
  MemoryProvider,
  useMemoryStore,
} from "@/lib/memory-store";
import { useMemoryConsent } from "@/lib/consent";
import {
  DESKTOP_QUERY,
  WIDE_QUERY,
  useMediaQuery,
  useMemoryPanel,
} from "@/lib/shell";
import { scanForPii, worstTier, type PiiCategory, type PiiFinding } from "@/lib/pii";
import { cn } from "@/lib/utils";
import {
  api,
  type Chat,
  type CandidatesResponse,
  type Me,
  type Message,
  type Provider,
  type RetrievalTrace,
  type ProvidersResponse,
  type ScopeReport,
  type TurnResponse,
  type VerifiedDraft as VerifiedDraftT,
} from "@/lib/api";

interface Turn {
  id: string;
  userText: string;
  ephemeral: boolean;
  reply: string | null;
  used: TurnResponse["used_memories"];
  extraction: CandidatesResponse | null;
  extractionRunning: boolean;
  error: string | null;
  fromHistory: boolean;
  // Which model answered this specific turn. Recorded per turn rather than read
  // from the current selection, so switching mid-conversation leaves the earlier
  // replies correctly labelled with the model that actually wrote them (D32).
  model: string | null;
  provider: string | null;
  assistantMessageId: string | null;
  // The model's own scratchpad and the retrieval funnel for this turn. Both come
  // straight from the response; neither is ever synthesised client-side.
  reasoning: string;
  retrieval: RetrievalTrace | null;
  // P6: kept so "here is what I would have said without that" is shown, not claimed.
  previousReply: string | null;
  regenerating: boolean;
  draft: VerifiedDraftT | null;
  // §4.3 tier 2: the user asked for this turn's memories to stay in the session.
  // Applied after extraction resolves, because the items do not exist until then.
  sessionOnlyIntent: boolean;
  sessionOnlyApplied: number | null;
}

const emptyTurn = (): Omit<Turn, "id" | "userText" | "ephemeral" | "fromHistory"> => ({
  reply: null,
  used: [],
  extraction: null,
  extractionRunning: false,
  error: null,
  // Null until the response names the model; historical turns keep it null because
  // the DB does not record which model wrote a stored message, and guessing from
  // the current selection would relabel the past every time the user switches.
  model: null,
  provider: null,
  assistantMessageId: null,
  reasoning: "",
  retrieval: null,
  previousReply: null,
  regenerating: false,
  draft: null,
  sessionOnlyIntent: false,
  sessionOnlyApplied: null,
});

/** Pair a flat message list into turns. Assistant replies follow their user turn. */
function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      turns.push({
        id: m.id,
        userText: m.content,
        ephemeral: m.session_ephemeral,
        fromHistory: true,
        ...emptyTurn(),
      });
    } else if (m.role === "assistant" && turns.length > 0) {
      turns[turns.length - 1].reply = m.content;
      turns[turns.length - 1].assistantMessageId = m.id;
    }
  }
  return turns;
}

export default function Page() {
  return (
    <MemoryProvider>
      <Workbench />
      <MemoryLiveRegion />
    </MemoryProvider>
  );
}

function Workbench() {
  // `items` here is only for the composer's count line (§16); every memory
  // *operation* still goes through useMemoryActions() inside the panel.
  const { refresh, items: memoryItems } = useMemoryStore();
  const memoryCount = memoryItems.length;

  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [highStakes, setHighStakes] = useState(false);

  // Declining the memory opt-in has to change what the app does, or the consent
  // step is theatre. It defaults every turn to off-the-record, which is the
  // mechanism that actually stops extraction (the pass returns before the LLM
  // call), rather than a flag that merely hides the result.
  const [consent] = useMemoryConsent();
  const declined = consent === "declined";

  // Derived, not synced. `null` means "follow the consent decision"; a boolean is
  // the user having overridden it for themselves, which then sticks. Doing this
  // with an effect that pushed `declined` into state would fire a second render
  // on every consent change and fight the user's own click on the way past.
  const [ephemeralOverride, setEphemeralOverride] = useState<boolean | null>(null);
  const ephemeral = ephemeralOverride ?? declined;
  const setEphemeral = useCallback((v: boolean) => setEphemeralOverride(v), []);
  const [sending, setSending] = useState(false);
  const [scope, setScope] = useState<ScopeReport | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState<string | null>(null);

  // §4.4: which memories to glow in the graph, and how strongly.
  const [relevance, setRelevance] = useState<Map<string, number> | null>(null);
  const [highlightTurn, setHighlightTurn] = useState<string | null>(null);

  // §4.3 / principle 4: categories the user has already waved through. Page
  // lifetime is the session, which is the right scope — a reload is a new
  // conversation with the warning system as much as with the model.
  const [dismissed, setDismissed] = useState<Set<PiiCategory>>(new Set());
  const [sessionOnly, setSessionOnly] = useState(false);
  const [gate, setGate] = useState<{ text: string; findings: PiiFinding[] } | null>(null);

  // ------------------------------------------------------------------ shell
  //
  // Layout is Tailwind breakpoints; these two queries drive *behaviour* only —
  // whether a zone is covering the conversation, and therefore whether it needs
  // a focus trap and an Escape key.
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const wide = useMediaQuery(WIDE_QUERY);
  const [memoryOpen, setMemoryOpen] = useMemoryPanel();
  // Two separate states, because at ≥1024px the sidebar is never absent (260px
  // or a 56px rail) and below it is never a rail (drawer or nothing). One
  // boolean would need a different default on each side of the breakpoint.
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Sidebar chrome: who you are, and the three dialogs it can open.
  const [me, setMe] = useState<Me | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Chat | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [replayOnboarding, setReplayOnboarding] = useState(false);

  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  // §12: the most recent message id that actually exists server-side, for a
  // user-written memory to cite (principle 7 — no orphaned facts).
  //
  // Not simply `turns.at(-1).id`: a turn dispatched locally carries a
  // crypto.randomUUID() until the response lands, so citing it would send the
  // backend a foreign key that does not exist. An assistant id is always real
  // when present; a user id is real only on a turn that came from history.
  const sourceMessageId = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t.assistantMessageId) return t.assistantMessageId;
      if (t.fromHistory) return t.id;
    }
    return null;
  }, [turns]);

  const refreshSidebar = useCallback(
    (id: string | null) => {
      void refresh();
      if (id) api.scopeReport(id).then(setScope).catch(() => {});
    },
    [refresh],
  );

  // Boot: reuse the most recent chat rather than spawning a new one on every reload,
  // otherwise the chat list fills with empties during a demo.
  useEffect(() => {
    (async () => {
      try {
        const existing = await api.chats();
        const chat = existing[0] ?? (await api.createChat("Session 1"));
        const list = existing.length ? existing : [chat];
        setChats(list);
        setChatId(chat.id);
        setTurns(toTurns(await api.messages(chat.id)));
        refreshSidebar(chat.id);
      } catch (e) {
        setFatal(e instanceof Error ? e.message : "failed to reach the backend");
      }
    })();
  }, [refreshSidebar]);

  // Identity for the sidebar footer. Non-fatal on failure: the app is usable
  // without knowing who you are, and the entry falls back to "Profile".
  useEffect(() => {
    api.me().then(setMe).catch(() => {});
  }, []);

  // Which providers exist depends on which keys the server has, so the switcher is
  // populated from the backend rather than hardcoded — a missing key means the
  // option is absent, not present-and-broken.
  useEffect(() => {
    api
      .providers()
      .then((r: ProvidersResponse) => {
        setProviders(r.providers);
        setProvider((p) => p ?? r.default);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns.length]);

  // ------------------------------------------------------------------ PII
  //
  // Runs on every keystroke, on device, with no network involved. Deferred so a
  // long message does not make typing feel heavy — the scan is cheap but it is
  // still regex over the whole buffer on each change.
  const deferredInput = useDeferredValue(input);
  const findings = useMemo(
    () => (ephemeral ? [] : scanForPii(deferredInput, dismissed)),
    [deferredInput, dismissed, ephemeral],
  );
  const tier = worstTier(findings);

  const patchTurn = (id: string, patch: Partial<Turn>) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const switchTo = async (id: string) => {
    // Picking a session is the drawer's only job, so it stands down afterwards.
    setDrawerOpen(false);
    setChatId(id);
    setTurns([]);
    setScope(null);
    setRelevance(null);
    try {
      setTurns(toTurns(await api.messages(id)));
      refreshSidebar(id);
    } catch (e) {
      setFatal(e instanceof Error ? e.message : "failed to load session");
    }
  };

  const newSession = async () => {
    setDrawerOpen(false);
    setMemoryOpen(false);
    try {
      const chat = await api.createChat(`Session ${chats.length + 1}`);
      setChats((cs) => [chat, ...cs]);
      setChatId(chat.id);
      setTurns([]);
      setRelevance(null);
      refreshSidebar(chat.id);
    } catch (e) {
      setFatal(e instanceof Error ? e.message : "failed to start a session");
    }
  };

  const renameSession = async (id: string, title: string) => {
    const updated = await api.renameChat(id, title);
    setChats((cs) => cs.map((c) => (c.id === id ? updated : c)));
  };

  const deleteSession = async (chat: Chat) => {
    const result = await api.deleteChat(chat.id);
    const remaining = chats.filter((c) => c.id !== chat.id);
    setChats(remaining);

    // Deleting the chat you are looking at has to land you somewhere real. Falling
    // back to the newest remaining one keeps the transcript non-empty; with nothing
    // left, a fresh session is better than an interface with no conversation in it.
    if (chat.id === chatId) {
      if (remaining[0]) await switchTo(remaining[0].id);
      else await newSession();
    }

    // The store has to be refetched, not patched: the tombstoned items are whatever
    // the server decided, and the count in the reply is the only honest source for
    // what actually happened.
    void refresh();
    if (chatId && chat.id !== chatId) refreshSidebar(chatId);
    return result;
  };

  const pollCandidates = useCallback(
    async (turnId: string, chat: string, messageId: string, sessionOnlyIntent: boolean) => {
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const res = await api.candidates(chat, messageId);
          if (res.status === "done" || res.status === "failed") {
            patchTurn(turnId, { extraction: res, extractionRunning: false });

            // §4.3 tier 2, the storage-layer half: sensitive-but-legitimate
            // content sends freely, and the scoping happens to the *items*, once
            // they exist. This is why the strip does not block the send.
            if (sessionOnlyIntent && res.status === "done") {
              const all = [...res.candidates, ...res.auto_accepted].filter(
                (it) => it.scope !== "session",
              );
              await Promise.all(
                all.map((it) => api.rescope(it.id, "session").catch(() => null)),
              );
              patchTurn(turnId, { sessionOnlyApplied: all.length });
            }

            refreshSidebar(chat);
            return;
          }
        } catch {
          /* transient failure should not kill the indicator */
        }
      }
      patchTurn(turnId, { extractionRunning: false });
    },
    [refreshSidebar],
  );

  /** The actual send. Called either directly or by the PII modal once the user
   *  has chosen redact-or-not — the model never sees text that has not been
   *  through this function. */
  const dispatch = async (text: string, keepToSession: boolean) => {
    if (!chatId || sending) return;

    const turnId = crypto.randomUUID();
    const wasEphemeral = ephemeral;
    const wasHighStakes = highStakes;
    setTurns((ts) => [
      ...ts,
      {
        id: turnId,
        userText: text,
        ephemeral: wasEphemeral,
        fromHistory: false,
        ...emptyTurn(),
        sessionOnlyIntent: keepToSession,
      },
    ]);
    setInput("");
    setSessionOnly(false);
    setSending(true);

    try {
      if (wasHighStakes) {
        // Different endpoint, not a flag on the same one: a high-stakes request
        // produces an artifact plus a per-claim check, which is a different shape of
        // answer from a conversational reply. It is also not provider-switchable —
        // the claim decomposition feeds the overstatement check (D33).
        const d = await api.verifiedDraft(chatId, text);
        patchTurn(turnId, { reply: "", draft: d });
      } else {
        const res = await api.sendTurn(chatId, text, wasEphemeral, provider ?? undefined);
        patchTurn(turnId, {
          reply: res.assistant_message.content,
          assistantMessageId: res.assistant_message.id,
          used: res.used_memories,
          extractionRunning: res.extraction_running,
          // From the response, not from local state: the server may have fallen back.
          model: res.model,
          provider: res.provider,
          reasoning: res.reasoning ?? "",
          retrieval: res.retrieval,
        });
        if (res.extraction_running) {
          void pollCandidates(turnId, chatId, res.user_message.id, keepToSession);
        }
      }
      refreshSidebar(chatId);
    } catch (e) {
      patchTurn(turnId, { error: e instanceof Error ? e.message : "request failed" });
    } finally {
      setSending(false);
    }
  };

  /** Submit handler. The only place that decides whether to interrupt. */
  const submit = () => {
    const text = input.trim();
    if (!text || !chatId || sending) return;

    // §4.3: hard interruption only for the irreversible tier. Everything else
    // goes straight out — friction proportional to irreversibility, not to
    // sensitivity (principle 3).
    if (tier === "irreversible") {
      setGate({ text, findings });
      return;
    }
    void dispatch(text, sessionOnly);
  };

  const revoke = async (turn: Turn, itemId: string) => {
    if (!chatId || !turn.assistantMessageId) return;
    patchTurn(turn.id, { regenerating: true });
    try {
      const r = await api.regenerate(chatId, turn.assistantMessageId, [itemId]);
      patchTurn(turn.id, {
        previousReply: r.previous,
        reply: r.regenerated,
        used: r.used_memories,
        regenerating: false,
      });
      refreshSidebar(chatId);
    } catch (e) {
      patchTurn(turn.id, {
        regenerating: false,
        error: e instanceof Error ? e.message : "regenerate failed",
      });
    }
  };

  const resolveItem = (turnId: string, itemId: string) => {
    setTurns((ts) =>
      ts.map((t) =>
        t.id === turnId && t.extraction
          ? {
              ...t,
              extraction: {
                ...t.extraction,
                candidates: t.extraction.candidates.filter((c) => c.id !== itemId),
                auto_accepted: t.extraction.auto_accepted.filter((c) => c.id !== itemId),
              },
            }
          : t,
      ),
    );
    refreshSidebar(chatId);
  };

  const empty = turns.length === 0 && !fatal;

  return (
    <div className="flex min-h-dvh w-full lg:h-dvh lg:min-h-0 lg:overflow-hidden">
      <SessionSidebar
        chats={chats}
        currentId={chatId}
        collapsed={desktop && railCollapsed}
        open={drawerOpen}
        overlay={!desktop}
        // One control, two meanings, because the sidebar is two different things
        // on either side of 1024px: a column that narrows, or a drawer that goes.
        onToggle={() =>
          desktop ? setRailCollapsed((c) => !c) : setDrawerOpen(false)
        }
        onSelect={(id) => void switchTo(id)}
        onNew={() => void newSession()}
        onRename={renameSession}
        onDelete={setDeleteTarget}
        profileLabel={me?.handle ?? null}
        onOpenProfile={() => setProfileOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Centre zone. Its own scroll container at ≥1024px so the transcript and
          the memory panel move independently and neither pushes the other off
          screen. Capped at 760px and centred: a wider column would fill the
          space freed by collapsing memory, which is not what the space is for. */}
      <main className="flex min-w-0 flex-1 flex-col lg:min-h-0 lg:overflow-y-auto">
        <div className="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-outline bg-bg px-4 py-2 md:px-6">
          <SidebarOpenButton open={drawerOpen} onOpen={() => setDrawerOpen(true)} />
          <h2 className="sr-only">Conversation</h2>
          {/* Which session you are in, for the widths where the sidebar is not
              on screen to say so. */}
          <p className="meta truncate text-ink-invert-muted">
            {chats.find((c) => c.id === chatId)?.title ?? "Loading…"}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {/* The graph-link shortcut that used to sit here is gone (cosmetic
                request: only the Memory toggle stays in the top bar). It is
                still reachable from inside the memory panel itself
                (MemoryPanel.tsx / MemoryWorkspace.tsx), just not duplicated
                up here. */}
            <MemoryPanelToggle
              open={memoryOpen}
              onToggle={() => setMemoryOpen(!memoryOpen)}
            />
          </div>
        </div>

        <div
          className={cn(
            "mx-auto flex w-full max-w-[760px] flex-1 flex-col px-4 md:px-6",
            // Empty: heading, composer and the three beats sit in the middle of
            // the column rather than pinned to the bottom of an empty page.
            empty && "justify-center",
          )}
        >
          {fatal && (
            <p
              role="alert"
              className="mt-6 rounded-card border border-danger bg-danger-dim p-4 text-body-sm text-danger-on-bg"
            >
              Backend unreachable: {fatal}. Is uvicorn running on port 8000?
            </p>
          )}

          {empty && <EmptyHeading />}

          <div className={cn("space-y-6", !empty && "flex-1 py-6")}>
            {turns.map((t) => (
              <article key={t.id} className="space-y-3">
                {/* The user speaks in a bubble; the assistant does not. That
                    asymmetry is the convention every chat UI has settled on, and
                    it is doing real work here: a bubble is a quotation of
                    something *said*, and the reply is the page talking. It also
                    buys the reply the full column width, which matters because
                    the reply is the thing with review cards and attribution
                    hanging off it. */}
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-card rounded-br-sm bg-surface px-4 py-3 text-ink shadow-[0_1px_2px_rgb(15_20_25/0.06)]">
                    <p className="measure whitespace-pre-wrap text-body-md">
                      {t.userText}
                    </p>
                    {t.ephemeral && (
                      <p className="meta mt-1.5 text-ink-muted">
                        off the record — never extracted
                      </p>
                    )}
                  </div>
                </div>

                {t.error && (
                  <p
                    role="alert"
                    className="rounded-card border border-danger bg-danger-dim px-4 py-3 text-body-sm text-danger-on-bg"
                  >
                    {t.error}
                  </p>
                )}

                {/* Replaces "thinking…" and the five status lines that used to be
                    scattered below the reply. One ordered account of what the turn
                    did to memory, so the structural story does not require opening
                    the graph (principle 6). Every state and count in it is derived
                    from the real payload. */}
                <MemoryTimeline
                  ephemeral={t.ephemeral}
                  reply={t.reply}
                  error={t.error}
                  retrieval={t.retrieval}
                  extractionRunning={t.extractionRunning}
                  extraction={t.extraction}
                  sessionOnlyApplied={t.sessionOnlyApplied}
                />

                {/* Kept separate: the model's own scratchpad is not a memory
                    operation, and it is absent entirely for models that emit none. */}
                <ThinkingPanel reasoning={t.reasoning} />

                {t.reply && (
                  <div>
                    <p className="measure whitespace-pre-wrap text-body-md text-ink-invert">
                      {t.reply}
                    </p>
                    {/* Labelled per turn, so a conversation that switched models shows
                        which one wrote each reply rather than relabelling the history. */}
                    {t.model && (
                      <p className="meta mt-1.5 text-left text-ink-invert-muted">
                        answered by {t.model}
                      </p>
                    )}

                    {/* §4.4: the chips are the primary attribution surface and
                        work with no graph open at all. */}
                    <AttributionChips
                      used={t.used}
                      regenerating={t.regenerating}
                      highlighted={highlightTurn === t.id}
                      onRevoke={(id) => void revoke(t, id)}
                      onHighlight={(map) => {
                        setRelevance(map);
                        setHighlightTurn(map ? t.id : null);
                        // The chips are complete on their own with the panel
                        // shut (§4.4). Asking for the graph highlight is the one
                        // thing they cannot do alone, so it opens the panel
                        // rather than silently doing nothing visible.
                        if (map) setMemoryOpen(true);
                      }}
                    />

                    {t.regenerating && (
                      <p className="mt-2 flex items-center gap-2 text-body-sm text-ink-invert-muted">
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                        answering again without it…
                      </p>
                    )}

                    {t.previousReply && (
                      <details className="mt-2 max-w-[85%]">
                        <summary className="tap meta cursor-pointer rounded-input text-ink-invert-muted">
                          what it said before
                        </summary>
                        <p className="measure mt-1.5 whitespace-pre-wrap border-l-2 border-outline-strong pl-3 text-body-sm text-ink-invert-muted line-through">
                          {t.previousReply}
                        </p>
                      </details>
                    )}
                  </div>
                )}

                {/* The five status lines that used to live here — extraction
                    running, off-the-record, nothing-worth-remembering, kept-to-session,
                    extraction-failed — are now steps in <MemoryTimeline> above. They
                    each said something true, but the reader had to assemble the story
                    from fragments spread around the turn.

                    The §9 distinction they encoded is preserved there, not lost: the
                    timeline's extraction step reads "skipped — the extractor never
                    ran" for an off-the-record turn and "nothing worth remembering"
                    for one that ran and found nothing. Those are a guarantee and a
                    result, and collapsing them would let off-the-record look like a
                    judgement call. */}

                {t.draft && (
                  <DraftPanel draft={t.draft} onConfirmed={() => refreshSidebar(chatId)} />
                )}

                {t.extraction && (
                  <ReviewCard
                    pending={t.extraction.candidates}
                    autoAccepted={t.extraction.auto_accepted}
                    onResolved={(itemId) => resolveItem(t.id, itemId)}
                  />
                )}
              </article>
            ))}
            <div ref={bottom} />
          </div>

          {/* ---------------------------------------------------- composer */}
          {/* One <form> in one position in the tree, restyled rather than moved,
              so the first turn landing does not remount the textarea out from
              under the caret. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className={cn(
              "bg-bg",
              empty ? "py-4" : "sticky bottom-0 mt-6 pb-2 pt-3",
            )}
          >
            {/* §4.3 tier 2. Above the composer, no focus steal, dismissible. */}
            <PiiStrip
              findings={findings}
              sessionOnly={sessionOnly}
              onSessionOnly={setSessionOnly}
              onDismiss={(cats) =>
                setDismissed((d) => new Set([...d, ...cats]))
              }
            />

            {/* ── Memory-mode badges ──────────────────────────────────────────
                Three coloured toggles that replace the old checkbox rows.
                High contrast & crystal-clear text readability across all states.
                Each carries an Info icon that reveals a popover tooltip on hover.
            ─────────────────────────────────────────────────────────────── */}
            <div className="mb-2.5 flex flex-wrap items-center gap-2">
              {/* Red — Short-term memory */}
              <button
                type="button"
                onClick={() => {
                  if (ephemeral) {
                    setEphemeral(false);
                  } else {
                    setEphemeral(true);
                    setHighStakes(false);
                  }
                }}
                aria-pressed={ephemeral}
                className={cn(
                  "group relative flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs transition-all shadow-xs",
                  ephemeral
                    ? "bg-red-600 text-white border-red-700 font-semibold shadow-sm"
                    : "bg-red-50/90 text-red-950 border-red-300 hover:bg-red-100 hover:border-red-400 font-medium",
                )}
              >
                <span
                  className={cn(
                    "size-2.5 rounded-full shrink-0",
                    ephemeral ? "bg-white animate-pulse" : "bg-red-500",
                  )}
                />
                <span>Short-term memory</span>
                {/* ⓘ tooltip trigger */}
                <span className="relative ml-0.5 inline-flex items-center justify-center">
                  <Info className={cn("size-3.5 shrink-0 transition-opacity", ephemeral ? "text-white/80 group-hover:text-white" : "text-red-800/70 group-hover:text-red-950")} />
                  {/* tooltip popover */}
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 rounded-xl border border-slate-700/80 bg-slate-900 px-3.5 py-2.5 text-left text-xs text-slate-100 opacity-0 shadow-xl transition-opacity group-hover:opacity-100"
                  >
                    <span className="mb-1 block font-bold text-red-400">Short-term memory</span>
                    The model uses the active conversation as working context. Messages, instructions,
                    and details from this chat influence responses while they remain within the active
                    context window.
                  </span>
                </span>
              </button>

              {/* Yellow / Amber — Cross-session memory (default/normal mode) */}
              <button
                type="button"
                onClick={() => {
                  setEphemeral(false);
                  setHighStakes(false);
                }}
                aria-pressed={!ephemeral && !highStakes}
                className={cn(
                  "group relative flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs transition-all shadow-xs",
                  !ephemeral && !highStakes
                    ? "bg-amber-500 text-slate-950 border-amber-600 font-semibold shadow-sm"
                    : "bg-amber-50/90 text-amber-950 border-amber-300 hover:bg-amber-100 hover:border-amber-400 font-medium",
                )}
              >
                <span
                  className={cn(
                    "size-2.5 rounded-full shrink-0",
                    !ephemeral && !highStakes ? "bg-slate-950 animate-pulse" : "bg-amber-600",
                  )}
                />
                <span>Cross-session memory</span>
                <span className="relative ml-0.5 inline-flex items-center justify-center">
                  <Info className={cn("size-3.5 shrink-0 transition-opacity", !ephemeral && !highStakes ? "text-slate-950/80 group-hover:text-slate-950" : "text-amber-900/70 group-hover:text-amber-950")} />
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 rounded-xl border border-slate-700/80 bg-slate-900 px-3.5 py-2.5 text-left text-xs text-slate-100 opacity-0 shadow-xl transition-opacity group-hover:opacity-100"
                  >
                    <span className="mb-1 block font-bold text-amber-400">Cross-session explicit/implicit memories</span>
                    The model can retain relevant information across conversations to provide
                    continuity and more personalised responses, depending on memory settings.
                  </span>
                </span>
              </button>

              {/* Green — Specialised workspace / high-stakes draft */}
              <button
                type="button"
                onClick={() => {
                  if (highStakes) {
                    setHighStakes(false);
                  } else {
                    setHighStakes(true);
                    setEphemeral(false);
                  }
                }}
                aria-pressed={highStakes}
                className={cn(
                  "group relative flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs transition-all shadow-xs",
                  highStakes
                    ? "bg-emerald-600 text-white border-emerald-700 font-semibold shadow-sm"
                    : "bg-emerald-50/90 text-emerald-950 border-emerald-300 hover:bg-emerald-100 hover:border-emerald-400 font-medium",
                )}
              >
                <span
                  className={cn(
                    "size-2.5 rounded-full shrink-0",
                    highStakes ? "bg-white animate-pulse" : "bg-emerald-600",
                  )}
                />
                <span>Specialised workspace</span>
                <span className="relative ml-0.5 inline-flex items-center justify-center">
                  <Info className={cn("size-3.5 shrink-0 transition-opacity", highStakes ? "text-white/80 group-hover:text-white" : "text-emerald-900/70 group-hover:text-emerald-950")} />
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-72 -translate-x-1/2 rounded-xl border border-slate-700/80 bg-slate-900 px-3.5 py-2.5 text-left text-xs text-slate-100 opacity-0 shadow-xl transition-opacity group-hover:opacity-100"
                  >
                    <span className="mb-1 block font-bold text-emerald-400">Specialised workspace</span>
                    A specialised workspace provides the model with a dedicated context containing
                    project-specific conversations, files, and instructions.
                  </span>
                </span>
              </button>
            </div>

            {/* One surface, not two. The textarea and its controls used to be
                separate boxes with the page background running between them,
                which on #F2F2F2 read as two unrelated widgets; a single white
                card with a visible edge is both the convention and the honest
                grouping — everything inside it applies to the message you are
                about to send. */}
            <div className="rounded-card border border-outline-strong bg-surface p-2 shadow-[0_1px_3px_rgb(15_20_25/0.08)] focus-within:border-accent">
              <label htmlFor="composer" className="sr-only">
                Message
              </label>
              <textarea
                id="composer"
                ref={composer}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                placeholder="Say something…"
                disabled={!chatId || sending}
                // 16px minimum, or iOS zooms the viewport on focus (§5). No
                // border or ring of its own — the card around it carries both,
                // and two nested focus treatments is one too many.
                className="w-full resize-none bg-transparent px-2 py-1.5 text-body-md text-ink placeholder:text-ink-muted focus-visible:outline-none disabled:opacity-50"
              />

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              {/* Switchable mid-conversation. Changing this changes only who writes the
                  next reply — the memory store is untouched, so the new model inherits
                  the same memories rather than re-deriving them (D32). */}
              {providers.length > 1 && (
                // min-w-0 on both: a <select> sizes itself to its widest option,
                // and the provider slugs are long enough to push the composer
                // past a 390px viewport. The control clips its own label instead.
                <label className="flex min-w-0 max-w-full items-center gap-2 text-body-sm text-ink-invert-muted">
                  <Cpu className="size-4 shrink-0" aria-hidden="true" />
                  <span className="shrink-0">Model</span>
                  <select
                    value={provider ?? ""}
                    onChange={(e) => setProvider(e.target.value)}
                    // Disabled, not ignored, under high-stakes: that path is pinned to
                    // the verification model (D33), and a control that silently does
                    // nothing is worse than one that says it cannot.
                    disabled={sending || highStakes}
                    title={
                      highStakes
                        ? "High-stakes drafts always use the verification model"
                        : undefined
                    }
                    className="min-h-11 min-w-0 max-w-full flex-1 truncate rounded-input border border-outline-strong bg-raised px-2 text-body-sm text-ink-invert disabled:opacity-50"
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} · {p.model}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <span className="text-body-sm text-ink-invert-muted">
                {highStakes
                  ? "every memory-derived claim is checked before it lands"
                  : ephemeral
                    ? "this turn is never sent to the extractor"
                    : "Enter to send, Shift+Enter for a new line"}
              </span>

              <Button
                type="submit"
                variant="primary"
                className="ml-auto"
                disabled={!chatId || sending || !input.trim()}
              >
                {sending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-4" aria-hidden="true" />
                )}
                Send
              </Button>
              </div>
            </div>

            {/* §16. The only relational signal in the app, and deliberately a
                statement rather than a control: it reports what the store holds
                and offers nothing to press. Anything more — an avatar change, a
                "friend" indicator — would be claiming a relationship the system
                does not have. The count comes from the store, so it moves when
                a memory is kept or discarded without this needing to know. */}
            {declined ? (
              // Says what is true *and* where to undo it. A mode the user chose
              // still has to be visible, or "why is nothing being remembered?"
              // becomes a bug report.
              <p className="meta mt-2 flex items-center gap-1.5 text-alert-ink">
                <EyeOff className="size-3.5 shrink-0" aria-hidden="true" />
                memory is off — turn it on in the memory panel
              </p>
            ) : (
              memoryCount > 0 && (
                <p className="meta mt-2 text-ink-invert-muted">
                  remembers <span className="tnum">{memoryCount}</span>{" "}
                  {memoryCount === 1 ? "thing" : "things"} about you
                </p>
              )
            )}
          </form>

          {/* Below the composer, so the first thing on screen is still the thing
              you type into. Fills it and stops — Send stays the user's act. */}
          {empty && (
            <SuggestionCards
              onPick={(prompt) => {
                setInput(prompt);
                composer.current?.focus();
              }}
            />
          )}
        </div>
      </main>

      <MemoryPanel
        open={memoryOpen}
        overlay={!wide}
        onToggle={() => setMemoryOpen(!memoryOpen)}
        scope={scope}
        onScopeChanged={() => refreshSidebar(chatId)}
        findings={findings}
        tier={tier}
        silenced={dismissed.size}
        relevance={relevance}
        chatId={chatId}
        sourceMessageId={sourceMessageId}
      />

      {/* Rendered inside <Workbench> rather than beside it, because Settings can
          reopen it and the flag that does so lives here. Costs nothing when shut —
          a closed Radix dialog portals no content. */}
      <Onboarding
        forceOpen={replayOnboarding}
        onReplayFinished={() => setReplayOnboarding(false)}
      />

      <DeleteChatDialog
        chat={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={deleteSession}
      />

      <ProfileDialog
        me={me}
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onReplayOnboarding={() => setReplayOnboarding(true)}
      />

      {/* §4.3 tier 1. Focus-trapped, and it always offers a way through. */}
      <PiiModal
        open={!!gate}
        text={gate?.text ?? ""}
        findings={gate?.findings ?? []}
        onCancel={() => setGate(null)}
        onSend={(text, dismissedCategories) => {
          setDismissed((d) => new Set([...d, ...dismissedCategories]));
          setGate(null);
          void dispatch(text, sessionOnly);
        }}
      />
    </div>
  );
}
