"use client";

// P1 core loop + P3 session scoping.
//
// The session switcher is not a convenience feature — P3's whole claim is that a
// session-only memory does not survive into a new conversation, and that is not
// demonstrable without somewhere else to stand.

import { useCallback, useEffect, useRef, useState } from "react";

import { DraftPanel } from "@/components/DraftPanel";
import { ReviewCard } from "@/components/ReviewCard";
import { ScopePanel } from "@/components/ScopePanel";
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
  assistantMessageId: string | null;
  // P6: kept so "here is what I would have said without that" is shown, not claimed.
  previousReply: string | null;
  regenerating: boolean;
  draft: VerifiedDraftT | null;
}

const emptyTurn = (): Omit<Turn, "id" | "userText" | "ephemeral" | "fromHistory"> => ({
  reply: null,
  used: [],
  extraction: null,
  extractionRunning: false,
  error: null,
  assistantMessageId: null,
  previousReply: null,
  regenerating: false,
  draft: null,
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
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [ephemeral, setEphemeral] = useState(false);
  const [highStakes, setHighStakes] = useState(false);
  const [sending, setSending] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [scope, setScope] = useState<ScopeReport | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
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

  const send = async () => {
    const text = input.trim();
    if (!text || !chatId || sending) return;

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
      },
    ]);
    setInput("");
    setSending(true);

    try {
      if (wasHighStakes) {
        // Different endpoint, not a flag on the same one: a high-stakes request
        // produces an artifact plus a per-claim check, which is a different shape of
        // answer from a conversational reply.
        const d = await api.verifiedDraft(chatId, text);
        patchTurn(turnId, { reply: "", draft: d });
      } else {
        const res = await api.sendTurn(chatId, text, wasEphemeral);
        patchTurn(turnId, {
          reply: res.assistant_message.content,
          assistantMessageId: res.assistant_message.id,
          used: res.used_memories,
          extractionRunning: res.extraction_running,
        });
        if (res.extraction_running) {
          void pollCandidates(turnId, chatId, res.user_message.id);
        }
      }
      refreshSidebar(chatId);
    } catch (e) {
      patchTurn(turnId, { error: e instanceof Error ? e.message : "request failed" });
    } finally {
      setSending(false);
    }
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

  return (
    <div className="mx-auto flex w-full min-h-screen max-w-6xl flex-col px-4 py-6 lg:flex-row lg:gap-6">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="mb-4">
          <h1 className="text-lg font-semibold tracking-tight">Negotiated AI Memory</h1>
          <p className="text-xs text-neutral-500">
            You decide what is remembered, as it happens.
          </p>

          {/* Capped at six. Test runs accumulate sessions quickly, and an unbounded
              row of buttons pushed the conversation off the screen. Older sessions
              stay reachable through the count rather than vanishing silently. */}
          <nav aria-label="Sessions" className="mt-3 flex flex-wrap items-center gap-1.5">
            {chats.slice(0, 6).map((ch) => (
              <button
                key={ch.id}
                onClick={() => void switchTo(ch.id)}
                aria-current={ch.id === chatId ? "true" : undefined}
                className={
                  "rounded px-2 py-1 text-xs transition " +
                  (ch.id === chatId
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
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
        </header>

        {fatal && (
          <p
            role="alert"
            className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            Backend unreachable: {fatal}. Is uvicorn running on port 8000?
          </p>
        )}

        <div className="flex-1 space-y-4">
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
                      <ul className="mt-1.5 space-y-1.5 border-l-2 border-neutral-200 pl-2.5 dark:border-neutral-800">
                        {t.used.map((m) => (
                          <li key={m.id} className="text-neutral-600 dark:text-neutral-400">
                            {m.content}{" "}
                            <span className="text-neutral-400">
                              ({STATUS_LABEL[m.status]}, {SCOPE_LABEL[m.scope]})
                            </span>
                            {m.is_stale && (
                              <span className="ml-1 text-amber-700 dark:text-amber-400">
                                not confirmed recently
                              </span>
                            )}
                            {/* P6: revoking is a memory-level act, not a display
                                filter — the item is dropped and the answer redone
                                without it, so the influence is legible. */}
                            <button
                              disabled={t.regenerating}
                              onClick={() => void revoke(t, m.id)}
                              className="ml-2 underline underline-offset-2 hover:text-red-700 disabled:opacity-40 dark:hover:text-red-400"
                            >
                              drop this and redo
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {t.regenerating && (
                    <p className="mt-1.5 text-xs text-neutral-500">
                      answering again without it…
                    </p>
                  )}

                  {t.previousReply && (
                    <details className="mt-1.5 max-w-[85%] text-xs">
                      <summary className="cursor-pointer text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200">
                        What it said before
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-300 pl-2.5 text-neutral-500 line-through decoration-neutral-400 dark:border-neutral-700">
                        {t.previousReply}
                      </p>
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

              {t.draft && (
                <DraftPanel
                  draft={t.draft}
                  onConfirmed={() => refreshSidebar(chatId)}
                />
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

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="sticky bottom-0 mt-4 bg-[var(--background)] pt-2"
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
                disabled={highStakes}
                className="accent-amber-600"
              />
              Off the record
            </label>
            <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
              <input
                type="checkbox"
                checked={highStakes}
                onChange={(e) => setHighStakes(e.target.checked)}
                disabled={ephemeral}
                className="accent-red-600"
              />
              High-stakes draft
            </label>
            <span className="text-xs text-neutral-400">
              {highStakes
                ? "every memory-derived claim is checked before it lands"
                : ephemeral
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
