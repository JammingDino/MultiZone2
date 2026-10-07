import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  GraduationCap,
  Layers,
  MessageSquarePlus,
  NotebookText,
  RotateCcw,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { studySetTab } from "@/lib/tabLayout";
import { studyMath } from "@/lib/studyMath";
import type { StudyGrade, StudyQuestion } from "@/lib/types";
import { Markdown } from "./Markdown";

/**
 * Study mode's renderers (`make_flashcards` → a deck, `make_quiz` → a quiz,
 * `make_cheatsheet` → a sheet), plus the pieces the Study tab and the
 * popped-out study tabs (components/Study/StudyTab) reuse.
 *
 * The tool result carries everything needed to draw the set, so the transcript
 * renders even after the set is deleted. Anything that changes state — a
 * grade, an answer, an edit — goes to the project's study store, which is what
 * the Study tab, the study tabs and the model's `study_progress` read.
 */

// ─── Parsing the tool result ─────────────────────────────────────────────────

export interface DeckData {
  setId: string;
  title: string;
  cards: { id: string; front: string; back: string; source: string | null }[];
}

export type QuizQuestion = Pick<
  StudyQuestion,
  "id" | "question" | "options" | "answerIndex" | "explanation" | "source"
>;

export interface QuizData {
  setId: string;
  title: string;
  questions: QuizQuestion[];
}

export interface SheetData {
  setId: string;
  title: string;
  markdown: string;
  revised: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

export function toDeckData(parsed: any): DeckData | null {
  if (!parsed || typeof parsed.set_id !== "string" || !Array.isArray(parsed.cards)) return null;
  const cards = parsed.cards
    .filter((c: any) => c && typeof c.front === "string" && typeof c.back === "string")
    .map((c: any) => ({ id: String(c.id ?? ""), front: c.front, back: c.back, source: str(c.source) }));
  return cards.length ? { setId: parsed.set_id, title: str(parsed.title) ?? "Flashcards", cards } : null;
}

export function toQuizData(parsed: any): QuizData | null {
  if (!parsed || typeof parsed.set_id !== "string" || !Array.isArray(parsed.questions)) return null;
  const questions = parsed.questions
    .filter((q: any) => q && typeof q.question === "string" && Array.isArray(q.options))
    .map((q: any) => ({
      id: String(q.id ?? ""),
      question: q.question,
      options: q.options.map(String),
      answerIndex: Number(q.answer_index),
      explanation: str(q.explanation),
      source: str(q.source),
    }));
  return questions.length ? { setId: parsed.set_id, title: str(parsed.title) ?? "Quiz", questions } : null;
}

export function toSheetData(parsed: any): SheetData | null {
  if (!parsed || typeof parsed.set_id !== "string" || typeof parsed.markdown !== "string") return null;
  return {
    setId: parsed.set_id,
    title: str(parsed.title) ?? "Cheat sheet",
    markdown: parsed.markdown,
    revised: parsed.revised === true,
  };
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

/** "10 min", "1 day", "6 days", "3 mo" — how far away a card's next review is. */
export function formatInterval(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return d === 1 ? "1 day" : `${d} days`;
  const mo = Math.round(d / 30);
  return mo < 12 ? `${mo} mo` : `${(d / 365).toFixed(1)} yr`;
}

/**
 * Markdown for one field of a study set, with its math repaired first — see
 * lib/studyMath. Every question, option, card and sheet goes through this.
 */
export function StudyMarkdown({ source, className, fontSize }: { source: string; className?: string; fontSize?: string }) {
  return <Markdown source={studyMath(source)} className={className} fontSize={fontSize} />;
}

export function SourceLine({ source }: { source: string | null }) {
  if (!source) return null;
  return (
    <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
      <FileText size={10} className="shrink-0" />
      <span className="truncate" title={source}>{source}</span>
    </div>
  );
}

/** Opens the workspace panel on the Study tab. */
function useOpenStudyTab() {
  const setOpen = useApp((s) => s.setWorkspaceOpen);
  const focus = useApp((s) => s.focusWorkspace);
  return useCallback(() => {
    setOpen(true);
    focus("study");
  }, [setOpen, focus]);
}

/**
 * Pops a set out into a tab of its own beside the chat, so the quiz and the
 * conversation about it are on screen together.
 */
export function PopOutButton({ setId, title, label = "Pop out" }: { setId: string; title: string; label?: string }) {
  const open = useApp((s) => s.openStudyTab);
  return (
    <button
      type="button"
      onClick={() => open(studySetTab(setId), title)}
      title="Open in its own tab beside the chat"
      className="flex items-center gap-1 rounded px-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
    >
      <SquareArrowOutUpRight size={11} /> {label}
    </button>
  );
}

/** Puts a question about the material in the active chat's composer. */
export function useAskInChat() {
  const setDraft = useApp((s) => s.setComposerDraft);
  return useCallback((text: string) => setDraft(text, "append"), [setDraft]);
}

export const GRADES: { grade: StudyGrade; label: string; key: string; cls: string }[] = [
  { grade: "again", label: "Again", key: "1", cls: "hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]" },
  { grade: "hard", label: "Hard", key: "2", cls: "hover:border-amber-500 hover:text-amber-500" },
  { grade: "good", label: "Good", key: "3", cls: "hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]" },
  { grade: "easy", label: "Easy", key: "4", cls: "hover:border-green-500 hover:text-green-500" },
];

// ─── One flashcard ───────────────────────────────────────────────────────────

/**
 * A card that flips. The front is the cue, the back the answer; grading is
 * only offered once the back has been seen, because grading a card you have
 * not checked is guessing at your own memory. `onGrade` resolves when the
 * grade is stored. `large` is the popped-out tab's size.
 */
export function Flashcard({
  front,
  back,
  source,
  flipped,
  onFlip,
  onGrade,
  busy,
  note,
  large,
}: {
  front: string;
  back: string;
  source: string | null;
  flipped: boolean;
  onFlip: () => void;
  onGrade?: (g: StudyGrade) => void;
  busy?: boolean;
  /** Shown under the card after grading, e.g. "Next review in 6 days". */
  note?: string | null;
  large?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onFlip}
        title={flipped ? "Show the front" : "Show the answer"}
        className={`relative flex w-full flex-col justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-left transition-colors hover:border-[var(--color-accent)] ${
          large ? "min-h-[260px] px-8 py-8" : "min-h-[120px] px-4 py-4"
        }`}
      >
        <span className="absolute right-2 top-1.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]">
          {flipped ? "Answer" : "Question"}
        </span>
        <div className={large ? "text-base" : "text-sm"}>
          <StudyMarkdown source={flipped ? back : front} fontSize={large ? "16px" : undefined} />
        </div>
        {flipped && <SourceLine source={source} />}
      </button>
      {flipped && onGrade ? (
        <div className="grid grid-cols-4 gap-1.5">
          {GRADES.map((g) => (
            <button
              key={g.grade}
              type="button"
              disabled={busy}
              onClick={() => onGrade(g.grade)}
              className={`rounded border border-[var(--color-border)] px-2 text-[11px] transition-colors disabled:opacity-50 ${large ? "py-2" : "py-1"} ${g.cls}`}
            >
              {g.label}
              {large && <span className="ml-1.5 text-[10px] text-[var(--color-text-muted)]">{g.key}</span>}
            </button>
          ))}
        </div>
      ) : !flipped ? (
        <div className="text-center text-[10px] text-[var(--color-text-muted)]">
          {large ? "Click the card or press Space to see the answer" : "Click the card to see the answer"}
        </div>
      ) : null}
      {note && <div className="text-center text-[10px] text-[var(--color-text-muted)]">{note}</div>}
    </div>
  );
}

// ─── The deck, inline ────────────────────────────────────────────────────────

export function FlashcardDeckBlock({ setId, title, cards }: DeckData) {
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const openStudy = useOpenStudyTab();
  const card = cards[Math.min(idx, cards.length - 1)];

  const go = (to: number) => {
    setIdx(Math.max(0, Math.min(cards.length - 1, to)));
    setFlipped(false);
  };

  async function grade(g: StudyGrade) {
    setBusy(true);
    try {
      const next = await api.reviewStudyCard(card.id, g);
      setNotes((n) => ({ ...n, [card.id]: `Next review in ${formatInterval(next.dueAt - Date.now())}` }));
      setError(null);
      if (idx < cards.length - 1) go(idx + 1);
    } catch {
      setError("This deck is no longer in the project, so grades can't be saved.");
    } finally {
      setBusy(false);
    }
  }

  const reviewed = Object.keys(notes).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <Layers size={13} className="text-[var(--color-accent)]" />
        <span className="font-medium text-[var(--color-text)]">{title}</span>
        <span>{cards.length} card{cards.length === 1 ? "" : "s"}</span>
        {reviewed > 0 && <span>· {reviewed} reviewed</span>}
        <span className="ml-auto flex items-center gap-2">
          <PopOutButton setId={setId} title={title} />
          <button type="button" onClick={openStudy} className="text-[11px] hover:text-[var(--color-accent)]">
            Open in Study
          </button>
        </span>
      </div>
      <Flashcard
        front={card.front}
        back={card.back}
        source={card.source}
        flipped={flipped}
        onFlip={() => setFlipped((f) => !f)}
        onGrade={grade}
        busy={busy}
        note={!flipped ? notes[card.id] : null}
      />
      <div className="flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
        <button
          type="button"
          onClick={() => go(idx - 1)}
          disabled={idx === 0}
          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:text-[var(--color-text)] disabled:opacity-40"
        >
          <ChevronLeft size={12} /> Prev
        </button>
        <span>
          {idx + 1} / {cards.length}
        </span>
        <button
          type="button"
          onClick={() => go(idx + 1)}
          disabled={idx === cards.length - 1}
          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:text-[var(--color-text)] disabled:opacity-40"
        >
          Next <ChevronRight size={12} />
        </button>
      </div>
      {error && <div className="text-[11px] text-[var(--color-danger)]">{error}</div>}
    </div>
  );
}

// ─── Quiz answers ────────────────────────────────────────────────────────────

/**
 * The answers on screen for one quiz, kept in step with the project's store:
 * the last answer given to each question is restored, so a quiz half done
 * yesterday opens half done today — inline and in its tab alike, since an
 * answer given in one is a `study-changed` the other re-reads.
 */
export function useQuizAnswers(setId: string) {
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Cleared on screen by "Retry": a later re-read must not bring them back.
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .getStudySet(setId)
        .then((d) => {
          if (!live) return;
          setChoices((cur) => {
            const next = { ...cur };
            for (const q of d.questions) {
              if (q.lastChoice !== null && next[q.id] === undefined && !cleared.has(q.id)) next[q.id] = q.lastChoice;
            }
            return next;
          });
        })
        .catch(() => live && setMissing(true));
    load();
    const un = api.onStudyChanged(load);
    return () => {
      live = false;
      un.then((f) => f());
    };
  }, [setId, cleared]);

  const choose = useCallback(
    async (q: QuizQuestion, i: number) => {
      if (choices[q.id] !== undefined || busy || missing) return;
      setBusy(q.id);
      setChoices((c) => ({ ...c, [q.id]: i }));
      setCleared((s) => {
        if (!s.has(q.id)) return s;
        const n = new Set(s);
        n.delete(q.id);
        return n;
      });
      try {
        await api.answerStudyQuestion(q.id, i);
      } catch {
        setMissing(true);
      } finally {
        setBusy(null);
      }
    },
    [choices, busy, missing],
  );

  /** Clear some answers (or all) from the screen; the record of past answers is kept. */
  const clear = useCallback((ids?: string[]) => {
    setChoices((c) => {
      if (!ids) return {};
      const next = { ...c };
      for (const id of ids) delete next[id];
      return next;
    });
    setCleared((s) => new Set([...s, ...(ids ?? Object.keys(choices))]));
  }, [choices]);

  return { choices, choose, clear, missing, busy };
}

/** The text that asks the chat about one question. */
export function askAboutQuestion(title: string, q: QuizQuestion, n: number, chosen?: number): string {
  const letter = (i: number) => String.fromCharCode(65 + i);
  const lines = [
    `About question ${n} of the quiz "${title}":`,
    "",
    `> ${q.question.replace(/\n/g, "\n> ")}`,
    "",
    ...q.options.map((o, i) => `${letter(i)}. ${o}`),
    "",
  ];
  if (chosen !== undefined && chosen !== q.answerIndex) {
    lines.push(`I answered ${letter(chosen)}, but the answer is ${letter(q.answerIndex)}. Why is mine wrong, and why is that one right?`);
  } else if (chosen !== undefined) {
    lines.push(`The answer is ${letter(q.answerIndex)}. Can you explain it in more depth?`);
  } else {
    lines.push("Can you help me think this through without giving the answer away?");
  }
  return lines.join("\n");
}

// ─── One question ────────────────────────────────────────────────────────────

/**
 * A multiple-choice question, answered by clicking an option. Shared by the
 * inline quiz and the quiz tab, which passes `large` and an `onAsk`.
 */
export function QuestionCard({
  q,
  n,
  chosen,
  onChoose,
  onAsk,
  history,
  large,
}: {
  q: QuizQuestion;
  n: number;
  chosen: number | undefined;
  onChoose: (i: number) => void;
  onAsk?: () => void;
  /** "Missed 2 of 5 times" — the record before this sitting. */
  history?: string | null;
  large?: boolean;
}) {
  const done = chosen !== undefined;
  return (
    <div className={`rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] ${large ? "p-5" : "p-3"}`}>
      <div className={`mb-2 flex gap-2 ${large ? "text-base" : "text-sm"}`}>
        <span className="shrink-0 text-[var(--color-text-muted)]">{n}.</span>
        <div className="min-w-0 flex-1">
          <StudyMarkdown source={q.question} fontSize={large ? "16px" : undefined} />
        </div>
      </div>
      <div className={`flex flex-col ${large ? "gap-2" : "gap-1.5"}`}>
        {q.options.map((opt, i) => {
          const isAnswer = i === q.answerIndex;
          const isChosen = i === chosen;
          const state = !done
            ? "border-[var(--color-border)] hover:border-[var(--color-accent)]"
            : isAnswer
              ? "border-green-500/70 bg-green-500/10 text-[var(--color-text)]"
              : isChosen
                ? "border-[var(--color-danger)]/70 bg-[var(--color-danger)]/10 text-[var(--color-text)]"
                : "border-[var(--color-border)] opacity-60";
          return (
            <button
              key={i}
              type="button"
              // Not `disabled` once answered: the global disabled style
              // dims the very answer the user needs to read. `choose`
              // ignores a second answer.
              aria-disabled={done}
              onClick={() => onChoose(i)}
              className={`flex items-start gap-2 rounded border text-left transition-colors ${
                large ? "px-3 py-2 text-sm" : "px-2.5 py-1.5 text-xs"
              } ${done ? "cursor-default" : ""} ${state}`}
            >
              <span className="mt-px w-3.5 shrink-0 text-[var(--color-text-muted)]">
                {done && isAnswer ? (
                  <Check size={13} className="text-green-500" />
                ) : done && isChosen ? (
                  <X size={13} className="text-[var(--color-danger)]" />
                ) : (
                  String.fromCharCode(65 + i)
                )}
              </span>
              <span className="min-w-0 flex-1">
                <StudyMarkdown source={opt} fontSize={large ? "14px" : undefined} />
              </span>
            </button>
          );
        })}
      </div>
      {done && (q.explanation || q.source) && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-text-muted)]">
          {q.explanation && <StudyMarkdown source={q.explanation} fontSize={large ? "13px" : undefined} />}
          <SourceLine source={q.source} />
        </div>
      )}
      {(history || onAsk) && (
        <div className="mt-2 flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">
          {history && <span>{history}</span>}
          {onAsk && (
            <button
              type="button"
              onClick={onAsk}
              title="Put a question about this in the chat's composer"
              className="ml-auto flex items-center gap-1 hover:text-[var(--color-accent)]"
            >
              <MessageSquarePlus size={11} /> {done ? "Ask about this" : "Ask for a hint"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── The quiz, inline ────────────────────────────────────────────────────────

/**
 * Every question at once, each answerable in any order. "Retry" clears only
 * what is on screen — the history of wrong answers is kept, because it is the
 * point. "Pop out" opens the fuller quiz in a tab beside the chat.
 */
export function QuizBlock({ setId, title, questions }: QuizData) {
  const { choices, choose, clear, missing } = useQuizAnswers(setId);
  const answered = questions.filter((q) => choices[q.id] !== undefined);
  const correct = answered.filter((q) => choices[q.id] === q.answerIndex).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <GraduationCap size={14} className="text-[var(--color-accent)]" />
        <span className="font-medium text-[var(--color-text)]">{title}</span>
        <span>
          {answered.length > 0
            ? `${correct} of ${answered.length} correct · ${questions.length - answered.length} left`
            : `${questions.length} question${questions.length === 1 ? "" : "s"}`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {answered.length > 0 && !missing && (
            <button
              type="button"
              onClick={() => clear()}
              className="flex items-center gap-1 text-[11px] hover:text-[var(--color-text)]"
              title="Clear the answers on screen; the record of past answers is kept"
            >
              <RotateCcw size={11} /> Retry
            </button>
          )}
          {!missing && <PopOutButton setId={setId} title={title} />}
        </span>
      </div>
      {missing && (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          This quiz is no longer in the project, so answers aren't recorded.
        </div>
      )}
      <ol className="flex flex-col gap-3">
        {questions.map((q, qi) => (
          <li key={q.id || qi}>
            <QuestionCard q={q} n={qi + 1} chosen={choices[q.id]} onChoose={(i) => choose(q, i)} />
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── The cheat sheet, inline ─────────────────────────────────────────────────

/**
 * A cheat sheet in the transcript: a preview, cut off with a fade, and the
 * way to its tab — where it is meant to be read, beside the chat.
 */
export function CheatsheetBlock({ setId, title, markdown, revised }: SheetData) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <NotebookText size={13} className="text-[var(--color-accent)]" />
        <span className="font-medium text-[var(--color-text)]">{title}</span>
        <span>{revised ? "Cheat sheet, revised" : "Cheat sheet"}</span>
        <span className="ml-auto">
          <PopOutButton setId={setId} title={title} label="Open in a tab" />
        </span>
      </div>
      <div
        className={`relative overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 ${
          expanded ? "" : "max-h-72"
        }`}
      >
        <StudyMarkdown source={markdown} fontSize="13px" />
        {!expanded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--color-bg)] to-transparent" />
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="self-center text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        {expanded ? "Show less" : "Show all here"}
      </button>
    </div>
  );
}
