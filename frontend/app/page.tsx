"use client";

// P1 core loop + P3 session scoping.
//
// The session switcher is not a convenience feature — P3's whole claim is that a
// session-only memory does not survive into a new conversation, and that is not
// demonstrable without somewhere else to stand.

import { useCallback, useEffect, useRef, useState } from "react";

import { ReviewCard } from "@/components/ReviewCard";
import { ScopePanel } from "@/components/ScopePanel";
import { MemoryGraph } from "@/components/MemoryGraph";
import {
  api,
  SCOPE_LABEL,
  STATUS_LABEL,
  type CandidatesResponse,
  type Chat,
  type MemoryItem,
  type Message,
  type ScopeReport,
  type TurnResponse,
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
}

/** Pair a flat message list into turns. Assistant replies follow their user turn. */
function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      turns.push({
        id: m.id,
        userText: m.content,
        ephemeral: m.session_ephemeral,
        reply: null,
        used: [],
        extraction: null,
        extractionRunning: false,
        error: null,
        fromHistory: true,
      });
    } else if (m.role === "assistant" && turns.length > 0) {
      turns[turns.length - 1].reply = m.content;
    }
  }
  return turns;
}

export default function Page() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [ephemeral, setEphemeral] = useState(false);
  const [sending, setSending] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [scope, setScope] = useState<ScopeReport | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"chat" | "graph" | "split">("split");
  const [relevanceScores, setRelevanceScores] = useState<Record<string, number>>({});
  const [selectedMemoryIdsForChat, setSelectedMemoryIdsForChat] = useState<string[]>([]);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshSidebar = useCallback((id: string | null) => {
    api.items({ limit: "100" }).then(setMemories).catch(() => {});
    if (id) api.scopeReport(id).then(setScope).catch(() => {});
  }, []);

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

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const patchTurn = (id: string, patch: Partial<Turn>) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const switchTo = async (id: string) => {
    setChatId(id);
    setTurns([]);
    setScope(null);
    try {
      setTurns(toTurns(await api.messages(id)));
      refreshSidebar(id);
    } catch (e) {
      setFatal(e instanceof Error ? e.message : "failed to load session");
    }
  };

  const newSession = async () => {
    try {
      const chat = await api.createChat(`Session ${chats.length + 1}`);
      setChats((cs) => [chat, ...cs]);
      setChatId(chat.id);
      setTurns([]);
      refreshSidebar(chat.id);
    } catch (e) {
      setFatal(e instanceof Error ? e.message : "failed to start a session");
    }
  };

  const pollCandidates = useCallback(
    async (turnId: string, chat: string, messageId: string) => {
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const res = await api.candidates(chat, messageId);
          if (res.status === "done" || res.status === "failed") {
            patchTurn(turnId, { extraction: res, extractionRunning: false });
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

  // Recompute node prompt relevance in realtime when user types a prompt
  useEffect(() => {
    if (!input.trim()) {
      setRelevanceScores({});
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await api.computeRelevance(input.trim());
        setRelevanceScores(res.scores);
      } catch {
        // Ignore transient error
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [input]);

  const handleSelectMemoryForChat = (mem: MemoryItem) => {
    setSelectedMemoryIdsForChat([mem.id]);
    setInput(`Regarding node "${mem.content}": `);
    if (viewMode === "graph") setViewMode("split");
  };

  const handleSelectMultipleMemoriesForChat = (mems: MemoryItem[]) => {
    const ids = mems.map((m) => m.id);
    setSelectedMemoryIdsForChat(ids);
    setInput(`Summarize and compare facts across selected nodes (${mems.length} nodes): `);
    if (viewMode === "graph") setViewMode("split");
  };

  const send = async () => {
    const text = input.trim();
    if (!text || !chatId || sending) return;

    const turnId = crypto.randomUUID();
    const wasEphemeral = ephemeral;
    const targetedIds = [...selectedMemoryIdsForChat];

    setTurns((ts) => [
      ...ts,
      {
        id: turnId,
        userText: text,
        ephemeral: wasEphemeral,
        reply: null,
        used: [],
        extraction: null,
        extractionRunning: false,
        error: null,
        fromHistory: false,
      },
    ]);
    setInput("");
    setSelectedMemoryIdsForChat([]);
    setRelevanceScores({});
    setSending(true);

    try {
      const res = await api.sendTurn(chatId, text, wasEphemeral, targetedIds);
      patchTurn(turnId, {
        reply: res.assistant_message.content,
        used: res.used_memories,
        extractionRunning: res.extraction_running,
      });
      refreshSidebar(chatId);
      if (res.extraction_running) {
        void pollCandidates(turnId, chatId, res.user_message.id);
      }
    } catch (e) {
      patchTurn(turnId, { error: e instanceof Error ? e.message : "request failed" });
    } finally {
      setSending(false);
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

  return (
    <div className="mx-auto flex w-full min-h-screen max-w-6xl flex-col px-4 py-6 lg:flex-row lg:gap-6">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="mb-4">
          <h1 className="text-lg font-semibold tracking-tight">Negotiated AI Memory</h1>
          <p className="text-xs text-neutral-500">
            You decide what is remembered, as it happens.
          </p>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 dark:border-neutral-800 pb-3">
            <nav aria-label="Sessions" className="flex flex-wrap items-center gap-1.5">
              {chats.slice(0, 6).map((ch) => (
                <button
                  key={ch.id}
                  onClick={() => void switchTo(ch.id)}
                  aria-current={ch.id === chatId ? "true" : undefined}
                  className={
                    "rounded px-2 py-1 text-xs transition " +
                    (ch.id === chatId
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 font-medium shadow-sm"
                      : "border border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800")
                  }
                >
                  {ch.title ?? "Untitled"}
                </button>
              ))}
              <button
                onClick={() => void newSession()}
                className="rounded border border-dashed border-neutral-400 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                + New session
              </button>
              {chats.length > 6 && (
                <span className="text-xs text-neutral-400">
                  +{chats.length - 6} older
                </span>
              )}
            </nav>

            {/* View Mode Mode Toggles */}
            <div className="flex items-center gap-1 bg-neutral-100 dark:bg-neutral-900 p-1 rounded-lg border border-neutral-200 dark:border-neutral-800 text-xs font-medium">
              <button
                onClick={() => setViewMode("chat")}
                className={`px-2.5 py-1 rounded-md transition ${
                  viewMode === "chat"
                    ? "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white shadow-sm font-semibold"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                💬 Chat Only
              </button>
              <button
                onClick={() => setViewMode("split")}
                className={`px-2.5 py-1 rounded-md transition ${
                  viewMode === "split"
                    ? "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white shadow-sm font-semibold"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                ⚡ Split View
              </button>
              <button
                onClick={() => setViewMode("graph")}
                className={`px-2.5 py-1 rounded-md transition ${
                  viewMode === "graph"
                    ? "bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white shadow-sm font-semibold"
                    : "text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                }`}
              >
                🧠 Synaptic Graph
              </button>
            </div>
          </div>
        </header>

        {fatal && (
          <p
            role="alert"
            className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            Backend unreachable: {fatal}. Is uvicorn running on port 8000?
          </p>
        )}

        {viewMode === "graph" ? (
          <div className="flex-1 w-full h-[620px]">
            <MemoryGraph
              memories={memories}
              relevanceScores={relevanceScores}
              onSelectMemoryForChat={handleSelectMemoryForChat}
              onSelectMultipleMemoriesForChat={handleSelectMultipleMemoriesForChat}
              onRedirectToChat={(id) => void switchTo(id)}
              onRefreshMemories={() => refreshSidebar(chatId)}
            />
          </div>
        ) : (
          <div className="flex flex-col xl:flex-row gap-6 flex-1 min-h-0">
            {/* Chat Column */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex-1 space-y-4 max-h-[520px] overflow-y-auto pr-1">
                {turns.length === 0 && !fatal && (
                  <div className="rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-800">
                    <p className="font-medium text-neutral-700 dark:text-neutral-300">
                      Try telling it something with a mix of things in it.
                    </p>
                    <p className="mt-1.5">
                      &ldquo;I&rsquo;ve been on 20mg escitalopram since March. Still writing
                      the CHI paper with Priya, should wrap next month.&rdquo;
                    </p>
                    <p className="mt-2 text-xs">
                      Health goes to this chat only. The paper is kept as <em>in progress</em>,
                      not finished. Then start a new session and ask what it knows.
                    </p>
                  </div>
                )}

                {turns.map((t) => (
                  <article key={t.id} className="space-y-2">
                    <div className="flex justify-end">
                      <p className="max-w-[85%] rounded-lg rounded-br-sm bg-neutral-900 px-3 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
                        {t.userText}
                        {t.ephemeral && (
                          <span className="mt-1 block text-[11px] opacity-70">
                            off the record — never extracted
                          </span>
                        )}
                      </p>
                    </div>

                    {t.error && (
                      <p
                        role="alert"
                        className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                      >
                        {t.error}
                      </p>
                    )}

                    {t.reply === null && !t.error && (
                      <p className="text-sm text-neutral-400">thinking…</p>
                    )}

                    {t.reply && (
                      <div>
                        <p className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-bl-sm border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
                          {t.reply}
                        </p>
                        {t.used.length > 0 && (
                          <details className="mt-1.5 max-w-[85%] text-xs">
                            <summary className="cursor-pointer text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200">
                              Shaped by {t.used.length}{" "}
                              {t.used.length === 1 ? "memory" : "memories"}
                            </summary>
                            <ul className="mt-1.5 space-y-1 border-l-2 border-neutral-200 pl-2.5 dark:border-neutral-800">
                              {t.used.map((m) => (
                                <li key={m.id} className="text-neutral-600 dark:text-neutral-400">
                                  {m.content}{" "}
                                  <span className="text-neutral-400">
                                    ({STATUS_LABEL[m.status]}, {SCOPE_LABEL[m.scope]})
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    )}

                    <p aria-live="polite" className="sr-only">
                      {t.extractionRunning ? "Reviewing new memories" : ""}
                    </p>

                    {t.extractionRunning && (
                      <p className="ml-0 text-xs text-neutral-500 sm:ml-10">
                        <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500 align-middle" />
                        looking at what to remember…
                      </p>
                    )}

                    {t.ephemeral && t.reply && (
                      <p className="ml-0 text-xs text-neutral-500 sm:ml-10">
                        Nothing was extracted from this turn.
                      </p>
                    )}

                    {t.extraction?.status === "failed" && (
                      <p role="alert" className="ml-0 text-xs text-red-700 sm:ml-10 dark:text-red-400">
                        Extraction failed: {t.extraction.error}
                      </p>
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

              {/* Selected Nodes Grounding Indicator */}
              {selectedMemoryIdsForChat.length > 0 && (
                <div className="mt-2 p-2 rounded-lg bg-indigo-950/80 border border-indigo-500/50 flex items-center justify-between text-xs text-indigo-200">
                  <span>
                    🎯 Question targeted to <strong>{selectedMemoryIdsForChat.length} selected memory nodes</strong>
                  </span>
                  <button
                    onClick={() => setSelectedMemoryIdsForChat([])}
                    className="text-xs font-mono underline hover:text-white"
                  >
                    Clear selection
                  </button>
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
                className="sticky bottom-0 mt-3 bg-[var(--background)] pt-1"
              >
                <label htmlFor="composer" className="sr-only">
                  Message
                </label>
                <textarea
                  id="composer"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  rows={2}
                  placeholder="Say something…"
                  disabled={!chatId || sending}
                  className="w-full resize-none rounded-lg border border-neutral-300 bg-transparent p-2.5 text-sm outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
                />
                <div className="mt-1.5 flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
                    <input
                      type="checkbox"
                      checked={ephemeral}
                      onChange={(e) => setEphemeral(e.target.checked)}
                      className="accent-amber-600"
                    />
                    Off the record
                  </label>
                  <span className="text-xs text-neutral-400">
                    {ephemeral
                      ? "this turn is never sent to the extractor"
                      : "Enter to send, Shift+Enter for a new line"}
                  </span>
                  <button
                    type="submit"
                    disabled={!chatId || sending || !input.trim()}
                    className="ml-auto rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
                  >
                    Send
                  </button>
                </div>
              </form>
            </div>

            {/* Embedded Memory Graph in Split View */}
            {viewMode === "split" && (
              <div className="w-full xl:w-[500px] h-[580px] shrink-0">
                <MemoryGraph
                  memories={memories}
                  relevanceScores={relevanceScores}
                  onSelectMemoryForChat={handleSelectMemoryForChat}
                  onSelectMultipleMemoriesForChat={handleSelectMultipleMemoriesForChat}
                  onRedirectToChat={(id) => void switchTo(id)}
                  onRefreshMemories={() => refreshSidebar(chatId)}
                />
              </div>
            )}
          </div>
        )}
      </main>

      <aside className="mt-8 w-full shrink-0 lg:mt-0 lg:w-72">
        <ScopePanel report={scope} onChanged={() => refreshSidebar(chatId)} />

        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
          All memory ({memories.length})
        </h2>
        {memories.length === 0 ? (
          <p className="text-xs text-neutral-500">Nothing stored yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {memories.map((m) => (
              <li
                key={m.id}
                className="rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800"
              >
                <p className="text-neutral-800 dark:text-neutral-200">{m.content}</p>
                <p className="mt-1 flex flex-wrap gap-1 text-[10px] text-neutral-500">
                  <span>{m.block_name}</span>·<span>{STATUS_LABEL[m.status]}</span>·
                  <span
                    className={
                      m.scope === "session" ? "text-amber-700 dark:text-amber-400" : ""
                    }
                  >
                    {SCOPE_LABEL[m.scope]}
                  </span>
                  {m.review_state === "pending" && <span>· awaiting review</span>}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-neutral-400">
          Review cards appear for turns taken in this page session. Items still awaiting
          review stay listed here. The complete filterable, keyboard-navigable list is P4.
        </p>
      </aside>
    </div>
  );
}
