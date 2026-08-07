"use client";

// P1 core loop + P3 session scoping.
//
// The session switcher is not a convenience feature — P3's whole claim is that a
// session-only memory does not survive into a new conversation, and that is not
// demonstrable without somewhere else to stand.

import { useCallback, useEffect, useRef, useState } from "react";

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
  type Provider,
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
  // Which model answered this specific turn. Recorded per turn rather than read
  // from the current selection, so switching mid-conversation leaves the earlier
  // replies correctly labelled with the model that actually wrote them (D32).
  model: string | null;
  provider: string | null;
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
        // Historical turns predate this field; the DB does not record which model
        // wrote a stored message, so it is honestly unknown rather than guessed.
        model: null,
        provider: null,
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
  const [providers, setProviders] = useState<Provider[]>([]);
  const [provider, setProvider] = useState<string | null>(null);
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

  // Which providers exist depends on which keys the server has, so the switcher is
  // populated from the backend rather than hardcoded — a missing key means the
  // option is absent, not present-and-broken.
  useEffect(() => {
    api
      .providers()
      .then((r) => {
        setProviders(r.providers);
        setProvider((p) => p ?? r.default);
      })
      .catch(() => {});
  }, []);

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
        model: null,
        provider: null,
      },
    ]);
    setInput("");
    setSending(true);

    try {
      const res = await api.sendTurn(chatId, text, wasEphemeral, provider ?? undefined);
      patchTurn(turnId, {
        reply: res.assistant_message.content,
        used: res.used_memories,
        extractionRunning: res.extraction_running,
        // From the response, not from local state: the server may have fallen back.
        model: res.model,
        provider: res.provider,
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
                  {/* Labelled per turn, so a conversation that switched models shows
                      which one wrote each reply rather than relabelling the history. */}
                  {t.model && (
                    <p className="mt-1 text-[11px] text-neutral-400">
                      answered by {t.model}
                    </p>
                  )}
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
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
              <input
                type="checkbox"
                checked={ephemeral}
                onChange={(e) => setEphemeral(e.target.checked)}
                className="accent-amber-600"
              />
              Off the record
            </label>

            {/* Switchable mid-conversation. Changing this changes only who writes the
                next reply — the memory store is untouched, so the new model inherits
                the same memories rather than re-deriving them (D32). */}
            {providers.length > 1 && (
              <label className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
                <span>Model</span>
                <select
                  value={provider ?? ""}
                  onChange={(e) => setProvider(e.target.value)}
                  disabled={sending}
                  className="rounded border border-neutral-300 bg-transparent px-1.5 py-0.5 text-xs outline-none focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} · {p.model}
                    </option>
                  ))}
                </select>
              </label>
            )}

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
