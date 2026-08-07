"use client";

// The conversation, plus the memory workspace it feeds.
//
// P1 core loop + P3 session scoping + P6 attribution + P7 pre-send intervention.
//
// The session switcher is not a convenience feature — P3's whole claim is that a
// session-only memory does not survive into a new conversation, and that is not
// demonstrable without somewhere else to stand.
//
// Layout follows §1 exactly: 1200 container, 800 conversation column, 16/40
// margins. The memory workspace sits below the conversation at the full 1200
// rather than squeezed into a rail, because the graph needs width and because a
// view crammed into a sidebar reads as the secondary one — which is precisely
// what §2 says neither view is.

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Send } from "lucide-react";

import { AttributionChips } from "@/components/Attribution";
import { DraftPanel } from "@/components/DraftPanel";
import { MemoryWorkspace } from "@/components/MemoryWorkspace";
import { PiiModal, PiiStrip } from "@/components/PiiIntervention";
import { ReviewCard } from "@/components/ReviewCard";
import { ScopePanel } from "@/components/ScopePanel";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import {
  MemoryLiveRegion,
  MemoryProvider,
  useMemoryStore,
} from "@/lib/memory-store";
import { scanForPii, worstTier, type PiiCategory, type PiiFinding } from "@/lib/pii";
import { cn } from "@/lib/utils";
import {
  api,
  type Chat,
  type CandidatesResponse,
  type Message,
  type Provider,
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
  const { refresh } = useMemoryStore();

  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [ephemeral, setEphemeral] = useState(false);
  const [highStakes, setHighStakes] = useState(false);
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

  const bottom = useRef<HTMLDivElement>(null);

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

  return (
    <div className="mx-auto w-full max-w-[1200px] px-4 py-6 md:px-10">
      <header className="mb-6">
        <h1 className="text-headline-lg text-ink-invert">Negotiated AI Memory</h1>
        <p className="mt-1 text-body-md text-ink-invert-muted">
          You decide what is remembered, as it happens.
        </p>

        {/* Capped at six. Test runs accumulate sessions quickly, and an unbounded
            row of buttons pushed the conversation off the screen. Older sessions
            stay reachable through the count rather than vanishing silently. */}
        <nav aria-label="Sessions" className="mt-4 flex flex-wrap items-center gap-2">
          {chats.slice(0, 6).map((ch) => (
            <button
              key={ch.id}
              onClick={() => void switchTo(ch.id)}
              aria-current={ch.id === chatId ? "true" : undefined}
              className={cn(
                "min-h-11 rounded-pill px-4 text-body-sm transition-colors duration-[var(--motion-micro)]",
                ch.id === chatId
                  ? "bg-stated text-[color:var(--surface-sunken)] font-medium"
                  : "border border-outline-strong text-ink-invert-muted hover:text-ink-invert",
              )}
            >
              {ch.title ?? "Untitled"}
            </button>
          ))}
          <button
            onClick={() => void newSession()}
            className="min-h-11 rounded-pill border border-dashed border-outline-strong px-4 text-body-sm text-ink-invert-muted hover:text-ink-invert"
          >
            + New session
          </button>
          {chats.length > 6 && (
            <span className="meta tnum text-ink-invert-muted">
              +{chats.length - 6} older
            </span>
          )}
        </nav>
      </header>

      {fatal && (
        <p
          role="alert"
          className="mb-6 rounded-card border border-danger bg-danger-dim p-4 text-body-sm text-danger-on-dark"
        >
          Backend unreachable: {fatal}. Is uvicorn running on port 8000?
        </p>
      )}

      {/* Conversation column capped at 800 (§1); the scope rail takes the rest. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,800px)_minmax(0,1fr)]">
        <main className="flex min-w-0 flex-col">
          <h2 className="sr-only">Conversation</h2>

          <div className="flex-1 space-y-6">
            {turns.length === 0 && !fatal && (
              <div className="rounded-card border border-dashed border-outline-strong p-6">
                <p className="text-body-md font-medium text-ink-invert">
                  Try telling it something with a mix of things in it.
                </p>
                <p className="measure mt-2 text-body-md text-ink-invert-muted">
                  &ldquo;I&rsquo;ve been on 20mg escitalopram since March. Still
                  writing the CHI paper with Priya, should wrap next month.&rdquo;
                </p>
                <p className="measure mt-3 text-body-sm text-ink-invert-muted">
                  Health goes to this chat only. The paper is kept as{" "}
                  <em>in progress</em>, not finished. Then start a new session and
                  ask what it knows.
                </p>
              </div>
            )}

            {turns.map((t) => (
              <article key={t.id} className="space-y-2">
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-card rounded-br-sm bg-surface px-4 py-3 text-ink">
                    <p className="measure text-body-md">{t.userText}</p>
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
                    className="rounded-card border border-danger bg-danger-dim px-4 py-3 text-body-sm text-danger-on-dark"
                  >
                    {t.error}
                  </p>
                )}

                {t.reply === null && !t.error && (
                  <p className="flex items-center gap-2 text-body-sm text-ink-invert-muted">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    thinking…
                  </p>
                )}

                {t.reply && (
                  <div>
                    <p className="measure max-w-[85%] whitespace-pre-wrap rounded-card rounded-bl-sm border border-outline bg-raised px-4 py-3 text-body-md text-ink-invert">
                      {t.reply}
                    </p>
                    {/* Labelled per turn, so a conversation that switched models shows
                        which one wrote each reply rather than relabelling the history. */}
                    {t.model && (
                      <p className="meta mt-1.5 text-ink-invert-muted">
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

                {t.extractionRunning && (
                  <p className="meta ml-0 flex items-center gap-2 text-ink-invert-muted sm:ml-10">
                    <span
                      aria-hidden="true"
                      className="inline-block size-1.5 animate-pulse rounded-full bg-stated"
                    />
                    looking at what to remember…
                  </p>
                )}

                {t.ephemeral && t.reply && (
                  <p className="meta ml-0 text-ink-invert-muted sm:ml-10">
                    nothing was extracted from this turn
                  </p>
                )}

                {t.sessionOnlyApplied !== null && t.sessionOnlyApplied > 0 && (
                  <p role="status" className="meta ml-0 text-stated-on-dark sm:ml-10">
                    <span className="tnum">{t.sessionOnlyApplied}</span> kept to
                    this session only
                  </p>
                )}

                {t.extraction?.status === "failed" && (
                  <p
                    role="alert"
                    className="ml-0 text-body-sm text-danger-on-dark sm:ml-10"
                  >
                    Extraction failed: {t.extraction.error}
                  </p>
                )}

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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="sticky bottom-0 mt-6 bg-bg pb-2 pt-3"
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
                  submit();
                }
              }}
              rows={2}
              placeholder="Say something…"
              disabled={!chatId || sending}
              // 16px minimum, or iOS zooms the viewport on focus (§5).
              className="w-full resize-none rounded-input border border-outline-strong bg-raised p-3 text-body-md text-ink-invert placeholder:text-ink-invert-muted disabled:opacity-50"
            />

            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="flex min-h-11 items-center gap-2 text-body-sm text-ink-invert-muted">
                <input
                  type="checkbox"
                  checked={ephemeral}
                  onChange={(e) => setEphemeral(e.target.checked)}
                  disabled={highStakes}
                  className="size-4 accent-[color:var(--stated)]"
                />
                Off the record
              </label>

              {/* Switchable mid-conversation. Changing this changes only who writes the
                  next reply — the memory store is untouched, so the new model inherits
                  the same memories rather than re-deriving them (D32). */}
              {providers.length > 1 && (
                // min-w-0 on both: a <select> sizes itself to its widest option,
                // and the provider slugs are long enough to push the composer
                // past a 390px viewport. The control clips its own label instead.
                <label className="flex min-w-0 max-w-full items-center gap-2 text-body-sm text-ink-invert-muted">
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

              <label className="flex min-h-11 items-center gap-2 text-body-sm text-ink-invert-muted">
                <input
                  type="checkbox"
                  checked={highStakes}
                  onChange={(e) => setHighStakes(e.target.checked)}
                  disabled={ephemeral}
                  className="size-4 accent-[color:var(--danger)]"
                />
                High-stakes draft
              </label>

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
          </form>
        </main>

        <aside className="flex flex-col gap-4">
          <ScopePanel report={scope} onChanged={() => refreshSidebar(chatId)} />

          <div className="rounded-card border border-outline p-4">
            <h2 className="meta mb-2 text-ink-invert-muted">Detection</h2>
            <p className="text-body-sm text-ink-invert-muted">
              Pre-send checks run on this device. Open the network tab — nothing
              leaves before you press Send.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip tone={tier === "irreversible" ? "danger" : tier ? "alert" : "neutral"}>
                {tier ? `${findings.length} found` : "clear"}
              </Chip>
              {dismissed.size > 0 && (
                <Chip>{dismissed.size} silenced this session</Chip>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* The memory workspace, full container width so the graph is not a
          sidebar novelty (§2). */}
      <div className="mt-10">
        <MemoryWorkspace relevance={relevance} />
      </div>

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
