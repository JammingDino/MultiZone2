import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Columns3,
  Copy,
  GraduationCap,
  LayoutGrid,
  Layers,
  List,
  MessageSquarePlus,
  NotebookText,
  Pencil,
  Printer,
  Rows3,
  RotateCcw,
  Shuffle,
  Square,
  Trophy,
} from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { studyOf } from "@/lib/tabLayout";
import { usePersistentChoice } from "@/lib/uiState";
import type { StudyCard, StudyGrade, StudySetDetail } from "@/lib/types";
import {
  Flashcard,
  QuestionCard,
  SourceLine,
  StudyMarkdown,
  askAboutQuestion,
  formatInterval,
  useAskInChat,
  useQuizAnswers,
  type QuizQuestion,
} from "@/components/Renderers/StudyBlocks";
import { ReviewSession } from "@/components/Workspace/StudyPanel";

/**
 * A study set popped out of the chat into a tab of its own (`study:set:<id>`),
 * or a project's review session (`study:review:<projectId>`). The tab opens
 * beside the chat it came from, so the quiz and the conversation about it are
 * on screen together; the chat stays the active one, so "Ask about this" lands
 * in its composer.
 *
 * Everything is read from the project's study store, not the transcript, and
 * re-read on `study-changed` — a sheet the model revises updates in place, and
 * an answer given inline shows here.
 */
export function StudyTab({ tab }: { tab: string }) {
  const study = studyOf(tab);
  if (!study) return null;
  return study.kind === "review" ? <ReviewTab tab={tab} projectId={study.id} /> : <SetTab tab={tab} setId={study.id} />;
}

/**
 * The tab's frame: a header that stays put and a body that scrolls. Keys go
 * to the frame, not the window, so Space in a quiz never flips a card in
 * another pane — and the frame takes focus when it opens.
 */
function Frame({
  icon,
  title,
  meta,
  actions,
  children,
  onKey,
  wide,
}: {
  icon: ReactNode;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  onKey?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (onKey) ref.current?.focus({ preventScroll: true });
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
        onKey?.(e);
      }}
      className="mz-view-in flex min-h-0 flex-1 flex-col bg-[var(--color-bg)] outline-none"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="shrink-0 text-[var(--color-accent)]">{icon}</span>
        <span className="truncate text-sm font-medium text-[var(--color-text)]">{title}</span>
        {meta && <span className="shrink-0 truncate text-xs text-[var(--color-text-muted)]">{meta}</span>}
        <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className={`mx-auto w-full px-4 py-5 ${wide ? "max-w-6xl" : "max-w-3xl"}`}>{children}</div>
      </div>
    </div>
  );
}

function ToolButton({
  onClick,
  title,
  active,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      disabled={disabled}
      className={`flex h-7 items-center gap-1 rounded px-2 text-[11px] transition-colors disabled:opacity-40 ${
        active
          ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
          : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
      }`}
    >
      {children}
    </button>
  );
}

// ─── A set ───────────────────────────────────────────────────────────────────

function SetTab({ tab, setId }: { tab: string; setId: string }) {
  const [detail, setDetail] = useState<StudySetDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const setTitle = useApp((s) => s.setStudyTabTitle);
  const close = useApp((s) => s.closeWorkspaceFile);

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .getStudySet(setId)
        .then((d) => {
          if (!live) return;
          setDetail(d);
          setMissing(false);
          setTitle(tab, d.set.title);
        })
        .catch(() => live && setMissing(true));
    load();
    const un = api.onStudyChanged(load);
    return () => {
      live = false;
      un.then((f) => f());
    };
  }, [setId, tab, setTitle]);

  if (missing) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]">
        <span>This set has been deleted from the project.</span>
        <button type="button" onClick={() => close(tab)} className="text-xs underline hover:text-[var(--color-text)]">
          Close the tab
        </button>
      </div>
    );
  }
  if (!detail) return <div className="p-4 text-xs text-[var(--color-text-muted)]">Loading…</div>;
  if (detail.set.kind === "quiz") return <QuizTab detail={detail} />;
  if (detail.set.kind === "cheatsheet") return <SheetTab detail={detail} />;
  return <DeckTab detail={detail} />;
}

// ─── Quiz ────────────────────────────────────────────────────────────────────

const shuffled = <T,>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * The quiz, fuller than it is inline: one question at a time (keys 1–6 or
 * A–F answer, ←/→ move, Enter goes on) or all at once; shuffled; a score at
 * the end with the misses listed, and a retry of just those. Each question
 * carries its record from earlier sittings, and "Ask about this" puts it in
 * the chat's composer with what was chosen.
 */
function QuizTab({ detail }: { detail: StudySetDetail }) {
  const { set } = detail;
  const all: QuizQuestion[] = detail.questions;
  const { choices, choose, clear, missing } = useQuizAnswers(set.id);
  const ask = useAskInChat();
  const [mode, setMode] = usePersistentChoice<"focus" | "list">("study.quizMode", "focus", ["focus", "list"]);
  // The questions in this sitting, in order: all of them, shuffled, or only
  // the ones missed last time round.
  const [order, setOrder] = useState<string[]>(() => all.map((q) => q.id));
  const [pos, setPos] = useState(0);
  const [started, setStarted] = useState<number | null>(null);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  // The record from before this tab opened, for "missed 2 of 3 times".
  const history = useRef(new Map(detail.questions.map((q) => [q.id, { attempts: q.attempts, wrong: q.wrong }])));

  const byId = useMemo(() => new Map(all.map((q) => [q.id, q])), [all]);
  const questions = order.map((id) => byId.get(id)).filter((q): q is QuizQuestion => !!q);
  const answered = questions.filter((q) => choices[q.id] !== undefined);
  const correct = answered.filter((q) => choices[q.id] === q.answerIndex);
  const done = questions.length > 0 && answered.length === questions.length;
  const missed = questions.filter((q) => choices[q.id] !== undefined && choices[q.id] !== q.answerIndex);
  const current = questions[Math.min(pos, questions.length - 1)];

  useEffect(() => {
    if (done && finishedAt === null) setFinishedAt(Date.now());
    if (!done && finishedAt !== null) setFinishedAt(null);
  }, [done, finishedAt]);

  const answer = (q: QuizQuestion, i: number) => {
    if (i < 0 || i >= q.options.length) return;
    if (started === null) setStarted(Date.now());
    void choose(q, i);
  };

  const restart = (ids: string[], shuffle = false) => {
    clear(ids);
    setOrder(shuffle ? shuffled(ids) : ids);
    setPos(0);
    setStarted(null);
    setFinishedAt(null);
  };

  const historyOf = (q: QuizQuestion) => {
    const h = history.current.get(q.id);
    if (!h || h.attempts === 0) return null;
    return h.wrong === 0
      ? `Right all ${h.attempts} time${h.attempts === 1 ? "" : "s"} before`
      : `Missed ${h.wrong} of ${h.attempts} time${h.attempts === 1 ? "" : "s"} before`;
  };
  const askAbout = (q: QuizQuestion) => ask(askAboutQuestion(set.title, q, all.indexOf(q) + 1, choices[q.id]));

  const onKey = (e: React.KeyboardEvent) => {
    if (mode !== "focus" || !current || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (/^[1-6]$/.test(k)) answer(current, Number(k) - 1);
    else if (/^[a-f]$/.test(k)) answer(current, k.charCodeAt(0) - 97);
    else if (k === "arrowright" || (k === "enter" && choices[current.id] !== undefined)) setPos((p) => Math.min(questions.length - 1, p + 1));
    else if (k === "arrowleft") setPos((p) => Math.max(0, p - 1));
    else return;
    e.preventDefault();
  };

  const pct = questions.length ? Math.round((correct.length / questions.length) * 100) : 0;
  const elapsed = started && finishedAt ? formatDuration(finishedAt - started) : null;

  return (
    <Frame
      icon={<GraduationCap size={15} />}
      title={set.title}
      meta={`${correct.length}/${answered.length} right · ${questions.length - answered.length} left`}
      onKey={onKey}
      actions={
        <>
          <ToolButton onClick={() => setMode("focus")} active={mode === "focus"} title="One question at a time">
            <Square size={12} /> One
          </ToolButton>
          <ToolButton onClick={() => setMode("list")} active={mode === "list"} title="Every question at once">
            <List size={12} /> All
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
          <ToolButton onClick={() => restart(all.map((q) => q.id), true)} title="Start over in a random order" disabled={missing}>
            <Shuffle size={12} /> Shuffle
          </ToolButton>
          <ToolButton onClick={() => restart(all.map((q) => q.id))} title="Start over; past answers stay on record" disabled={missing}>
            <RotateCcw size={12} /> Restart
          </ToolButton>
        </>
      }
    >
      {missing && (
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          This quiz is no longer in the project, so answers aren't recorded.
        </p>
      )}

      {/* Where you are: one dot per question, coloured once answered. */}
      <div className="mb-4 flex flex-wrap gap-1">
        {questions.map((q, i) => {
          const c = choices[q.id];
          const tone =
            c === undefined
              ? "bg-[var(--color-border)]"
              : c === q.answerIndex
                ? "bg-green-500"
                : "bg-[var(--color-danger)]";
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => {
                setPos(i);
                if (mode === "list") document.getElementById(`q-${q.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
              title={`Question ${i + 1}`}
              className={`h-2 flex-1 basis-3 rounded-full ${tone} ${mode === "focus" && i === pos ? "ring-2 ring-[var(--color-accent)] ring-offset-1 ring-offset-[var(--color-bg)]" : ""}`}
            />
          );
        })}
      </div>

      {done && (
        <div className="mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
          <div className="flex items-center gap-3">
            <Trophy size={22} className={pct >= 80 ? "text-green-500" : pct >= 50 ? "text-amber-500" : "text-[var(--color-danger)]"} />
            <div>
              <div className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{pct}%</div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {correct.length} of {questions.length} right{elapsed ? ` · ${elapsed}` : ""}
              </div>
            </div>
            <div className="ml-auto flex flex-wrap justify-end gap-1.5">
              {missed.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => restart(missed.map((q) => q.id))}
                    className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white"
                  >
                    Retry the {missed.length} missed
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      ask(
                        `I just took the quiz "${set.title}" and missed these:\n\n` +
                          missed.map((q) => `- ${q.question}`).join("\n") +
                          "\n\nWhat am I misunderstanding? Teach me the ideas behind them from the sources.",
                      )
                    }
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                  >
                    <MessageSquarePlus size={12} /> Ask about the misses
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => restart(all.map((q) => q.id), true)}
                className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)]"
              >
                Take it again
              </button>
            </div>
          </div>
          {missed.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1 border-t border-[var(--color-border)] pt-3 text-xs">
              {missed.map((q) => (
                <li key={q.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setMode("focus");
                      setPos(questions.indexOf(q));
                    }}
                    className="flex w-full items-start gap-2 text-left text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  >
                    <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-danger)]" />
                    <span className="line-clamp-2 min-w-0 flex-1">
                      <StudyMarkdown source={q.question} fontSize="12px" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {mode === "focus" && current ? (
        <div className="flex flex-col gap-3">
          <QuestionCard
            q={current}
            n={all.indexOf(current) + 1}
            chosen={choices[current.id]}
            onChoose={(i) => answer(current, i)}
            onAsk={() => askAbout(current)}
            history={historyOf(current)}
            large
          />
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <button
              type="button"
              onClick={() => setPos((p) => Math.max(0, p - 1))}
              disabled={pos === 0}
              className="flex items-center gap-0.5 rounded px-2 py-1 hover:text-[var(--color-text)] disabled:opacity-40"
            >
              <ChevronLeft size={13} /> Previous
            </button>
            <span className="tabular-nums">
              {pos + 1} / {questions.length}
            </span>
            <button
              type="button"
              onClick={() => setPos((p) => Math.min(questions.length - 1, p + 1))}
              disabled={pos >= questions.length - 1}
              className={`flex items-center gap-0.5 rounded px-2 py-1 disabled:opacity-40 ${
                choices[current.id] !== undefined ? "text-[var(--color-accent)]" : "hover:text-[var(--color-text)]"
              }`}
            >
              Next <ChevronRight size={13} />
            </button>
          </div>
          <div className="text-center text-[10px] text-[var(--color-text-muted)]">
            1–{current.options.length} or A–{String.fromCharCode(64 + current.options.length)} answer · ← → move · Enter next
          </div>
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {questions.map((q) => (
            <li key={q.id} id={`q-${q.id}`}>
              <QuestionCard
                q={q}
                n={all.indexOf(q) + 1}
                chosen={choices[q.id]}
                onChoose={(i) => answer(q, i)}
                onAsk={() => askAbout(q)}
                history={historyOf(q)}
                large
              />
            </li>
          ))}
        </ol>
      )}
    </Frame>
  );
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ─── Deck ────────────────────────────────────────────────────────────────────

/**
 * A deck at full size: study it card by card (Space flips, ← → move, 1–4
 * grade), shuffled if you like, or browse every card with both sides showing
 * and when each is next due.
 */
function DeckTab({ detail }: { detail: StudySetDetail }) {
  const { set, cards } = detail;
  const [mode, setMode] = usePersistentChoice<"study" | "browse">("study.deckMode", "study", ["study", "browse"]);
  const [order, setOrder] = useState<string[]>(() => cards.map((c) => c.id));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const ask = useAskInChat();

  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const deck = order.map((id) => byId.get(id)).filter((c): c is StudyCard => !!c);
  const card = deck[Math.min(pos, deck.length - 1)];
  const now = Date.now();
  const due = cards.filter((c) => c.dueAt <= now).length;

  const go = (to: number) => {
    setPos(Math.max(0, Math.min(deck.length - 1, to)));
    setFlipped(false);
  };

  const grade = useCallback(
    async (g: StudyGrade) => {
      if (!card || busy) return;
      setBusy(true);
      try {
        const next = await api.reviewStudyCard(card.id, g);
        setNotes((n) => ({ ...n, [card.id]: `Next review in ${formatInterval(next.dueAt - Date.now())}` }));
        if (pos < deck.length - 1) go(pos + 1);
        else setFlipped(false);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [card, busy, pos, deck.length],
  );

  const onKey = (e: React.KeyboardEvent) => {
    if (mode !== "study" || !card || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === " " || e.key === "Enter") setFlipped((f) => !f);
    else if (e.key === "ArrowRight") go(pos + 1);
    else if (e.key === "ArrowLeft") go(pos - 1);
    else if (flipped && ["1", "2", "3", "4"].includes(e.key)) void grade((["again", "hard", "good", "easy"] as const)[Number(e.key) - 1]);
    else return;
    e.preventDefault();
  };

  return (
    <Frame
      icon={<Layers size={15} />}
      title={set.title}
      meta={`${cards.length} cards · ${due} due`}
      onKey={onKey}
      wide={mode === "browse"}
      actions={
        <>
          <ToolButton onClick={() => setMode("study")} active={mode === "study"} title="One card at a time">
            <Square size={12} /> Study
          </ToolButton>
          <ToolButton onClick={() => setMode("browse")} active={mode === "browse"} title="Every card, both sides">
            <LayoutGrid size={12} /> Browse
          </ToolButton>
          <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
          <ToolButton
            onClick={() => {
              setOrder(shuffled(cards.map((c) => c.id)));
              setPos(0);
              setFlipped(false);
            }}
            title="Shuffle the deck"
          >
            <Shuffle size={12} /> Shuffle
          </ToolButton>
        </>
      }
    >
      {mode === "study" && card ? (
        <div className="flex flex-col gap-3">
          <Flashcard
            front={card.front}
            back={card.back}
            source={card.source}
            flipped={flipped}
            onFlip={() => setFlipped((f) => !f)}
            onGrade={grade}
            busy={busy}
            note={!flipped ? notes[card.id] : null}
            large
          />
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <button
              type="button"
              onClick={() => go(pos - 1)}
              disabled={pos === 0}
              className="flex items-center gap-0.5 rounded px-2 py-1 hover:text-[var(--color-text)] disabled:opacity-40"
            >
              <ChevronLeft size={13} /> Previous
            </button>
            <span className="tabular-nums">
              {pos + 1} / {deck.length}
              {Object.keys(notes).length > 0 && ` · ${Object.keys(notes).length} graded`}
            </span>
            <button
              type="button"
              onClick={() => go(pos + 1)}
              disabled={pos >= deck.length - 1}
              className="flex items-center gap-0.5 rounded px-2 py-1 hover:text-[var(--color-text)] disabled:opacity-40"
            >
              Next <ChevronRight size={13} />
            </button>
          </div>
          <div className="flex items-center justify-center gap-3 text-[10px] text-[var(--color-text-muted)]">
            <span>Space flips · ← → move · 1 Again · 2 Hard · 3 Good · 4 Easy</span>
            <button
              type="button"
              onClick={() => ask(`About the flashcard "${card.front}" (answer: ${card.back}) — can you explain it further, from the sources?`)}
              className="flex items-center gap-1 hover:text-[var(--color-accent)]"
            >
              <MessageSquarePlus size={11} /> Ask about this card
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
          {deck.map((c, i) => (
            <div key={c.id} className="flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-sm">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
                <span>{i + 1}</span>
                <span className="ml-auto">
                  {c.dueAt <= now ? (
                    <span className="text-[var(--color-accent)]">due now</span>
                  ) : (
                    `due in ${formatInterval(c.dueAt - now)}`
                  )}
                  {c.lapses > 0 && ` · forgotten ${c.lapses}×`}
                </span>
              </div>
              <div className="font-medium text-[var(--color-text)]">
                <StudyMarkdown source={c.front} fontSize="13px" />
              </div>
              <div className="mt-2 border-t border-[var(--color-border)] pt-2 text-[var(--color-text-muted)]">
                <StudyMarkdown source={c.back} fontSize="13px" />
              </div>
              <SourceLine source={c.source} />
              <button
                type="button"
                onClick={() => {
                  setMode("study");
                  setPos(i);
                  setFlipped(false);
                }}
                className="mt-2 self-start text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              >
                Study from here
              </button>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

// ─── Cheat sheet ─────────────────────────────────────────────────────────────

type Cols = "1" | "2" | "3";
type Density = "comfortable" | "compact";

/**
 * A cheat sheet, to keep open beside the chat: laid out in one to three
 * columns, compact or comfortable, editable in place, copyable as Markdown,
 * and printable on its own. "Ask to revise" hands the model the set id, so a
 * revision replaces this sheet rather than making a second.
 */
function SheetTab({ detail }: { detail: StudySetDetail }) {
  const { set } = detail;
  const body = detail.body ?? "";
  const [cols, setCols] = usePersistentChoice<Cols>("study.sheetCols", "2", ["1", "2", "3"]);
  const [density, setDensity] = usePersistentChoice<Density>("study.sheetDensity", "compact", ["comfortable", "compact"]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const [draftTitle, setDraftTitle] = useState(set.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const ask = useAskInChat();

  // A revision from the model while not editing shows straight away; while
  // editing, the draft is the user's and is not pulled out from under them.
  useEffect(() => {
    if (!editing) {
      setDraft(body);
      setDraftTitle(set.title);
    }
  }, [body, set.title, editing]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.updateStudyCheatsheet(set.id, draft, draftTitle);
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`# ${set.title}\n\n${body}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard refused: nothing to show */
    }
  }

  const fontSize = density === "compact" ? "12.5px" : "14px";
  const updated = detail.updatedAt ? new Date(detail.updatedAt).toLocaleString() : null;

  return (
    <Frame
      icon={<NotebookText size={15} />}
      title={set.title}
      meta={updated ? `Updated ${updated}` : undefined}
      wide={cols !== "1"}
      actions={
        editing ? (
          <>
            <ToolButton onClick={() => setEditing(false)} title="Discard the edit">
              Cancel
            </ToolButton>
            <button
              type="button"
              onClick={save}
              disabled={saving || !draft.trim()}
              className="flex h-7 items-center gap-1 rounded bg-[var(--color-accent)] px-3 text-[11px] font-medium text-white disabled:opacity-50"
            >
              <Check size={12} /> {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <>
            <ToolButton onClick={() => setCols("1")} active={cols === "1"} title="One column">
              <Rows3 size={12} />
            </ToolButton>
            <ToolButton onClick={() => setCols("2")} active={cols === "2"} title="Two columns">
              <Columns2 size={12} />
            </ToolButton>
            <ToolButton onClick={() => setCols("3")} active={cols === "3"} title="Three columns">
              <Columns3 size={12} />
            </ToolButton>
            <ToolButton
              onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
              active={density === "compact"}
              title="Compact text"
            >
              Aa
            </ToolButton>
            <span className="mx-1 h-4 w-px bg-[var(--color-border)]" />
            <ToolButton onClick={copy} title="Copy the sheet as Markdown">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </ToolButton>
            <ToolButton onClick={() => sheetRef.current && printSheet(set.title, sheetRef.current, cols)} title="Print the sheet on its own">
              <Printer size={12} />
            </ToolButton>
            <ToolButton
              onClick={() =>
                ask(`Revise the cheat sheet "${set.title}" (set_id ${set.id}) with make_cheatsheet: `)
              }
              title="Ask the chat to change the sheet"
            >
              <MessageSquarePlus size={12} /> Revise
            </ToolButton>
            <ToolButton onClick={() => setEditing(true)} title="Edit the Markdown yourself">
              <Pencil size={12} /> Edit
            </ToolButton>
          </>
        )
      }
    >
      {editing ? (
        <div className="flex flex-col gap-2">
          <input
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            placeholder="Title"
          />
          <div className="grid min-h-[60vh] gap-3 lg:grid-cols-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="min-h-[60vh] resize-none rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-3 font-mono text-xs leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
            />
            <div className="hidden overflow-y-auto rounded border border-dashed border-[var(--color-border)] p-3 lg:block">
              <StudyMarkdown source={draft} fontSize="12.5px" />
            </div>
          </div>
          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>
      ) : (
        // Up to `cols` columns, none narrower than 260px: a sheet in a narrow
        // pane falls back to fewer rather than squeezing.
        <div ref={sheetRef} className="mz-sheet" style={{ columns: `${cols} 260px`, columnGap: "1.75rem" }}>
          <StudyMarkdown source={body} fontSize={fontSize} />
        </div>
      )}
    </Frame>
  );
}

/**
 * Print the sheet alone, not the window around it: its rendered HTML in a
 * hidden frame carrying the page's own styles (KaTeX's among them), printed
 * light whatever the theme.
 */
function printSheet(title: string, node: HTMLElement, cols: Cols) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) return frame.remove();
  const styles = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map((n) => n.outerHTML).join("\n");
  doc.open();
  doc.write(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${styles}
<style>
  @page { margin: 12mm; }
  html, body { background: #fff !important; color: #111 !important; }
  body { font-size: 11px; padding: 0; margin: 0; }
  h1.sheet-title { font-size: 16px; margin: 0 0 8px; }
  .sheet { column-count: ${cols}; column-gap: 18px; }
  .sheet h2, .sheet h3 { break-after: avoid; }
  .sheet li, .sheet table, .sheet pre, .sheet .katex-display { break-inside: avoid; }
  .sheet .markdown { font-size: 11px !important; color: #111 !important; }
</style></head><body><h1 class="sheet-title">${escapeHtml(title)}</h1><div class="sheet">${node.innerHTML}</div></body></html>`);
  doc.close();
  const go = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 1000);
  };
  // Stylesheet links need a moment to load in the new document.
  window.setTimeout(go, 300);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// ─── Review ──────────────────────────────────────────────────────────────────

/** The project's due cards, as the Study tab's review session at full size. */
function ReviewTab({ tab, projectId }: { tab: string; projectId: string }) {
  const close = useApp((s) => s.closeWorkspaceFile);
  const setTitle = useApp((s) => s.setStudyTabTitle);
  const scope = useRef<HTMLDivElement>(null);
  useEffect(() => setTitle(tab, "Review"), [tab, setTitle]);
  useEffect(() => scope.current?.focus({ preventScroll: true }), []);
  return (
    <div ref={scope} tabIndex={-1} className="mz-view-in flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-bg)] outline-none">
      <div className="mx-auto w-full max-w-2xl px-4 py-6">
        <ReviewSession projectId={projectId} onDone={() => close(tab)} keyScope={scope} large />
      </div>
    </div>
  );
}
