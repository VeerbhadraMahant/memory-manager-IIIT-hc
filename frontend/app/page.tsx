"use client";

// P1 — the core loop. A turn happens, the response comes back with the memories that
// shaped it, and what the system wants to remember appears inline for negotiation.
//
// Nothing here opens a settings page: every memory operation is reachable from the
// transcript (D1). The standalone list view is P4.

import { useCallback, useEffect, useRef, useState } from "react";

import { ReviewCard } from "@/components/ReviewCard";
import {
  api,
  SCOPE_LABEL,
  STATUS_LABEL,
  type CandidatesResponse,
  type Health,
  type MemoryItem,
  type TurnResponse,
} from "@/lib/api";

interface Turn {
  id: string;
  userText: string;
  ephemeral: boolean;
  reply: string | null;
  used: TurnResponse["used_memories"];
  userMessageId: string | null;
  extraction: CandidatesResponse | null;
  extractionRunning: boolean;
  error: string | null;
}

export default function Page() {
  const [chatId, setChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [ephemeral, setEphemeral] = useState(false);
  const [sending, setSending] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshMemories = useCallback(() => {
    api.items({ limit: "100" }).then(setMemories).catch(() => {});
    api.health().then(setHealth).catch(() => {});
  }, []);

  useEffect(() => {
    api
      .createChat("Demo session")
      .then((c) => setChatId(c.id))
      .catch((e) => setFatal(e.message));
    refreshMemories();
  }, [refreshMemories]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  const patchTurn = (id: string, patch: Partial<Turn>) =>
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  // Extraction is async and takes a few seconds, so the card fills in after the
  // reply rather than with it. Polling is the honest, simple option here; a socket
  // would be nicer and is not worth the hours.
  const pollCandidates = useCallback(
    async (turnId: string, chat: string, messageId: string) => {
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const res = await api.candidates(chat, messageId);
          if (res.status === "done" || res.status === "failed") {
            patchTurn(turnId, { extraction: res, extractionRunning: false });
            refreshMemories();
            return;
          }
        } catch {
          /* keep polling; a transient failure should not kill the indicator */
        }
      }
      patchTurn(turnId, { extractionRunning: false });
    },
    [refreshMemories],
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
        userMessageId: null,
        extraction: null,
        extractionRunning: false,
        error: null,
      },
    ]);
    setInput("");
    setSending(true);

    try {
      const res = await api.sendTurn(chatId, text, wasEphemeral);
      patchTurn(turnId, {
        reply: res.assistant_message.content,
        used: res.used_memories,
        userMessageId: res.user_message.id,
        extractionRunning: res.extraction_running,
      });
      if (res.extraction_running) {
        void pollCandidates(turnId, chatId, res.user_message.id);
      }
    } catch (e) {
      patchTurn(turnId, {
        error: e instanceof Error ? e.message : "request failed",
      });
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
                auto_accepted: t.extraction.auto_accepted.filter(
                  (c) => c.id !== itemId,
                ),
              },
            }
          : t,
      ),
    );
    refreshMemories();
  };

  return (
    // w-full is load-bearing: body is flex-col, and mx-auto on a flex item overrides
    // the default align-items:stretch, which shrink-wraps the box to its content.
    <div className="mx-auto flex w-full min-h-screen max-w-6xl flex-col px-4 py-6 lg:flex-row lg:gap-6">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="mb-4">
          <h1 className="text-lg font-semibold tracking-tight">
            Negotiated AI Memory
          </h1>
          <p className="text-xs text-neutral-500">
            You decide what is remembered, as it happens.
          </p>
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
                &ldquo;I&rsquo;ve been on 20mg escitalopram since March. Still
                writing the CHI paper with Priya, should wrap next month.&rdquo;
              </p>
              <p className="mt-2 text-xs">
                Health goes to this chat only. The paper is kept as{" "}
                <em>in progress</em>, not finished.
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
                <p
                  role="alert"
                  className="ml-0 text-xs text-red-700 sm:ml-10 dark:text-red-400"
                >
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
      </main>

      <aside className="mt-8 w-full shrink-0 lg:mt-0 lg:w-72">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
          Memory ({memories.length})
        </h2>
        {health && (
          <p className="mb-3 text-[11px] text-neutral-400">
            pgvector {health.pgvector} · {health.embedding_dim}d
          </p>
        )}
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
                      m.scope === "session"
                        ? "text-amber-700 dark:text-amber-400"
                        : ""
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
          The complete, filterable, keyboard-navigable list is P4. This panel is a
          read-only preview.
        </p>
      </aside>
    </div>
  );
}
