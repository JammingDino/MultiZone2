import { useCallback, useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, FileText, GraduationCap, Layers, RotateCcw, X } from "lucide-react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import type { StudyGrade, StudyQuestion } from "@/lib/types";
import { Markdown } from "./Markdown";

/**
 * Study mode's two renderers (`make_flashcards` → a deck, `make_quiz` → a
 * quiz), plus the single flashcard the Study tab's review session reuses.
 *
 * The tool result carries everything needed to draw the set, so the transcript
 * renders even after the set is deleted. Anything that changes state — a
 * grade, an answer — goes to the project's study store, which is what the
 * Study tab and the model's `study_progress` read.
 */

// ─── Parsing the tool result ─────────────────────────────────────────────────

export interface DeckData {
  setId: string;
  title: string;
  cards: { id: string; front: string; back: string; source: string | null }[];
}

export interface QuizData {
  setId: string;
  title: string;
  questions: Pick<StudyQuestion, "id" | "question" | "options" | "answerIndex" | "explanation" | "source">[];
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

function SourceLine({ source }: { source: string | null }) {
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

const GRADES: { grade: StudyGrade; label: string; key: string; cls: string }[] = [
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
 * grade is stored.
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
}) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onFlip}
        title={flipped ? "Show the front" : "Show the answer"}
        className="relative flex min-h-[120px] w-full flex-col justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-4 text-left transition-colors hover:border-[var(--color-accent)]"
      >
        <span className="absolute right-2 top-1.5 text-[9px] uppercase tracking-wide text-[var(--color-text-muted)]">
          {flipped ? "Answer" : "Question"}
        </span>
        <div className="text-sm">
          <Markdown source={flipped ? back : front} />
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
              className={`rounded border border-[var(--color-border)] px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ${g.cls}`}
            >
              {g.label}
            </button>
          ))}
        </div>
      ) : !flipped ? (
        <div className="text-center text-[10px] text-[var(--color-text-muted)]">Click the card to see the answer</div>
      ) : null}
      {note && <div className="text-center text-[10px] text-[var(--color-text-muted)]">{note}</div>}
    </div>
  );
}

// ─── The deck, inline ────────────────────────────────────────────────────────

export function FlashcardDeckBlock({ title, cards }: DeckData) {
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
        <button
          type="button"
          onClick={openStudy}
          className="ml-auto text-[11px] hover:text-[var(--color-accent)]"
        >
          Open in Study
        </button>
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

// ─── The quiz, inline ────────────────────────────────────────────────────────

/**
 * Every question at once, each answerable in any order. The last answer given
 * is restored from the project's store, so a quiz half done yesterday opens
 * half done today; "Retry" clears only what is on screen — the history of
 * wrong answers is kept, because it is the point.
 */
export function QuizBlock({ setId, title, questions }: QuizData) {
  const [choices, setChoices] = useState<Record<string, number>>({});
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getStudySet(setId)
      .then((d) => {
        if (!live) return;
        const restored: Record<string, number> = {};
        for (const q of d.questions) if (q.lastChoice !== null) restored[q.id] = q.lastChoice;
        setChoices(restored);
      })
      .catch(() => live && setMissing(true));
    return () => {
      live = false;
    };
  }, [setId]);

  async function choose(q: QuizData["questions"][number], i: number) {
    if (choices[q.id] !== undefined || busy || missing) return;
    setBusy(q.id);
    setChoices((c) => ({ ...c, [q.id]: i }));
    try {
      await api.answerStudyQuestion(q.id, i);
    } catch {
      setMissing(true);
    } finally {
      setBusy(null);
    }
  }

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
        {answered.length > 0 && !missing && (
          <button
            type="button"
            onClick={() => setChoices({})}
            className="ml-auto flex items-center gap-1 text-[11px] hover:text-[var(--color-text)]"
            title="Clear the answers on screen; the record of past answers is kept"
          >
            <RotateCcw size={11} /> Retry
          </button>
        )}
      </div>
      {missing && (
        <div className="text-[11px] text-[var(--color-text-muted)]">
          This quiz is no longer in the project, so answers aren't recorded.
        </div>
      )}
      <ol className="flex flex-col gap-3">
        {questions.map((q, qi) => {
          const chosen = choices[q.id];
          const done = chosen !== undefined;
          return (
            <li key={q.id || qi} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="mb-2 flex gap-2 text-sm">
                <span className="shrink-0 text-[var(--color-text-muted)]">{qi + 1}.</span>
                <div className="min-w-0 flex-1">
                  <Markdown source={q.question} />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                {q.options.map((opt, i) => {
                  const isAnswer = i === q.answerIndex;
                  const isChosen = i === chosen;
                  const state = !done
                    ? "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                    : isAnswer
                      ? "border-green-500/70 bg-green-500/10"
                      : isChosen
                        ? "border-[var(--color-danger)]/70 bg-[var(--color-danger)]/10"
                        : "border-[var(--color-border)] opacity-60";
                  return (
                    <button
                      key={i}
                      type="button"
                      disabled={done || busy === q.id}
                      onClick={() => choose(q, i)}
                      className={`flex items-start gap-2 rounded border px-2.5 py-1.5 text-left text-xs transition-colors ${state}`}
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
                        <Markdown source={opt} />
                      </span>
                    </button>
                  );
                })}
              </div>
              {done && (q.explanation || q.source) && (
                <div className="mt-2 border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-text-muted)]">
                  {q.explanation && <Markdown source={q.explanation} />}
                  <SourceLine source={q.source} />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
