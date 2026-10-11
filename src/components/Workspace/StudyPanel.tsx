import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FilePlus,
  GraduationCap,
  Layers,
  Loader2,
  NotebookText,
  Play,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { isRemote } from "@/lib/remote/transport";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import type { StudyCard, StudyGrade, StudyOverview, StudySet, StudySetDetail } from "@/lib/types";
import { studyReviewTab, studySetTab } from "@/lib/tabLayout";
import {
  CheatsheetBlock,
  Flashcard,
  FlashcardDeckBlock,
  QuizBlock,
  formatInterval,
} from "@/components/Renderers/StudyBlocks";

/**
 * How many cards are due in a project, kept current — for the tab's dot.
 * Null when the project is not a study project.
 */
export function useStudyDue(projectId: string | null): number | null {
  const [due, setDue] = useState<number | null>(null);
  useEffect(() => {
    if (!projectId) {
      setDue(null);
      return;
    }
    const load = () =>
      api
        .studyOverview(projectId)
        .then((o) => setDue(o.dueCount))
        .catch(() => setDue(null));
    load();
    const un = api.onStudyChanged(load);
    const t = window.setInterval(load, 60_000);
    return () => {
      un.then((f) => f());
      window.clearInterval(t);
    };
  }, [projectId]);
  return due;
}

/**
 * The Study tab: what is due, a review session to clear it, and every deck,
 * quiz and cheat sheet the project has — wherever in the project's chats it
 * was made. Any of them pops out into a tab beside the chat.
 *
 * "12 cards due" is the whole reason this exists rather than the decks living
 * only in the transcript: spaced repetition only works if the reviews happen,
 * and nobody remembers to scroll back to a deck from last Tuesday.
 */
export function StudyPanel({ projectId }: { projectId: string }) {
  const [overview, setOverview] = useState<StudyOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const openProjectsPanel = useApp((s) => s.openProjectsPanel);
  const openStudyTab = useApp((s) => s.openStudyTab);
  const refreshProjects = useApp((s) => s.refreshProjects);
  const [adding, setAdding] = useState(false);
  const [addNote, setAddNote] = useState<string | null>(null);

  // Files in, indexed: all a study project made from the composer needs before
  // it can answer anything. Desktop only — the paths are this machine's.
  async function addSources() {
    const picked = await open({ multiple: true, directory: false });
    const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    if (paths.length === 0) return;
    setAdding(true);
    setAddNote(null);
    try {
      const n = await api.addProjectSources(projectId, paths);
      setAddNote(`Added ${n} file${n === 1 ? "" : "s"} and indexed the project.`);
      await refreshProjects();
      load();
    } catch (e) {
      setAddNote(String(e));
    } finally {
      setAdding(false);
    }
  }

  const load = useCallback(() => {
    api
      .studyOverview(projectId)
      .then((o) => {
        setOverview(o);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [projectId]);

  useEffect(() => {
    load();
    const un = api.onStudyChanged(load);
    // Cards come due on a clock, not on an event: re-read once a minute so the
    // count is right for someone who leaves the tab open.
    const t = window.setInterval(load, 60_000);
    return () => {
      un.then((f) => f());
      window.clearInterval(t);
    };
  }, [load]);

  if (error) return <p className="text-[11px] text-[var(--color-danger)]">{error}</p>;
  if (!overview) return <p className="text-[11px] text-[var(--color-text-muted)]">Loading…</p>;

  if (reviewing) {
    return (
      <ReviewSession
        projectId={projectId}
        onDone={() => {
          setReviewing(false);
          load();
        }}
      />
    );
  }

  const decks = overview.sets.filter((s) => s.kind === "flashcards");
  const quizzes = overview.sets.filter((s) => s.kind === "quiz");
  const sheets = overview.sets.filter((s) => s.kind === "cheatsheet");

  return (
    <div className="flex flex-col gap-3">
      {!overview.indexed && (
        <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-2.5 text-[11px]">
          <AlertTriangle size={13} className="mt-px shrink-0 text-amber-500" />
          <div>
            <div className="font-medium text-[var(--color-text)]">The sources aren't indexed yet</div>
            <div className="mt-0.5 text-[var(--color-text-muted)]">
              Study chats answer only from this project's indexed files.{" "}
              {isRemote() ? "Add them on the computer, or" : "Add some below, or"} set up Knowledge in{" "}
              <button
                type="button"
                onClick={() => openProjectsPanel(projectId)}
                className="underline hover:text-[var(--color-text)]"
              >
                the project's settings
              </button>
              .
            </div>
          </div>
        </div>
      )}

      {/* What is due — the number that matters. */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">
            {overview.dueCount}
          </span>
          <span className="text-xs text-[var(--color-text-muted)]">
            card{overview.dueCount === 1 ? "" : "s"} due · {overview.cardCount} in total
          </span>
        </div>
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            disabled={overview.dueCount === 0}
            onClick={() => setReviewing(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            <Play size={12} /> Review now
          </button>
          <button
            type="button"
            disabled={overview.dueCount === 0}
            onClick={() => openStudyTab(studyReviewTab(projectId), "Review")}
            title="Review in a tab beside the chat, at full size"
            className="flex items-center justify-center rounded border border-[var(--color-border)] px-2 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-40"
          >
            <SquareArrowOutUpRight size={12} />
          </button>
        </div>
        {overview.dueCount === 0 && (
          <div className="mt-1.5 text-center text-[10px] text-[var(--color-text-muted)]">
            {overview.nextDueAt
              ? `Nothing due. Next card in ${formatInterval(overview.nextDueAt - Date.now())}.`
              : "No cards yet. Ask for flashcards on a topic in the chat."}
          </div>
        )}
      </div>

      {!isRemote() && (
        <div>
          <button
            type="button"
            disabled={adding}
            onClick={addSources}
            title="Copy files into the project's folder and index them"
            className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-60"
          >
            {adding ? <Loader2 size={12} className="animate-spin" /> : <FilePlus size={12} />}
            {adding ? "Copying and indexing…" : "Add sources"}
          </button>
          {addNote && <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">{addNote}</p>}
        </div>
      )}

      <SetList title="Decks" icon={<Layers size={12} />} sets={decks} empty="Ask for flashcards to make one." />
      <SetList title="Quizzes" icon={<GraduationCap size={12} />} sets={quizzes} empty="Ask to be quizzed to make one." />
      <SetList
        title="Cheat sheets"
        icon={<NotebookText size={12} />}
        sets={sheets}
        empty="Ask for a cheat sheet on a topic to make one."
      />
    </div>
  );
}

function SetList({
  title,
  icon,
  sets,
  empty,
}: {
  title: string;
  icon: React.ReactNode;
  sets: StudySet[];
  empty: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
        {icon} {title}
      </div>
      {sets.length === 0 ? (
        <p className="text-[11px] text-[var(--color-text-muted)]">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {sets.map((s) => (
            <SetRow key={s.id} set={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SetRow({ set }: { set: StudySet }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<StudySetDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const openStudyTab = useApp((s) => s.openStudyTab);

  useEffect(() => {
    if (!open) return;
    api.getStudySet(set.id).then(setDetail).catch(() => setDetail(null));
  }, [open, set.id]);

  const badge =
    set.kind === "cheatsheet"
      ? ""
      : set.kind === "quiz"
        ? set.answered > 0
          ? `${set.correct}/${set.itemCount}`
          : `${set.itemCount} q`
        : set.dueCount > 0
          ? `${set.dueCount} due`
          : `${set.itemCount}`;

  return (
    <li className="rounded border border-[var(--color-border)]">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-[var(--color-text)]"
        >
          {open ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          <span className="truncate text-[var(--color-text)]">{set.title}</span>
        </button>
        <span
          className={`shrink-0 rounded px-1.5 py-px text-[10px] tabular-nums ${
            set.kind === "flashcards" && set.dueCount > 0
              ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]"
              : "text-[var(--color-text-muted)]"
          }`}
        >
          {badge}
        </span>
        <button
          type="button"
          onClick={() => openStudyTab(studySetTab(set.id), set.title)}
          title="Open in its own tab beside the chat"
          className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        >
          <SquareArrowOutUpRight size={11} />
        </button>
        {confirming ? (
          <span className="flex shrink-0 items-center gap-1 text-[10px]">
            <button
              type="button"
              onClick={() => api.deleteStudySet(set.id)}
              className="text-[var(--color-danger)] hover:underline"
            >
              Delete
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="hover:underline">
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            title="Delete this set and its review history"
            className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {open && detail && (
        <div className="border-t border-[var(--color-border)] p-2">
          {set.kind === "flashcards" ? (
            <FlashcardDeckBlock setId={set.id} title={set.title} cards={detail.cards} />
          ) : set.kind === "cheatsheet" ? (
            <CheatsheetBlock setId={set.id} title={set.title} markdown={detail.body ?? ""} revised={false} />
          ) : (
            <QuizBlock setId={set.id} title={set.title} questions={detail.questions} />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The due cards across every deck in the project, one at a time. Space or
 * Enter flips; 1–4 grade. The queue is read once at the start, and a card
 * graded "Again" goes to the back of it, because it comes due again within
 * the sitting.
 */
export function ReviewSession({
  projectId,
  onDone,
  keyScope,
  large,
}: {
  projectId: string;
  onDone: () => void;
  /** Listen for keys on this element rather than the window — in a tab, so
   *  Space typed elsewhere never flips a card. */
  keyScope?: RefObject<HTMLElement | null>;
  large?: boolean;
}) {
  const [queue, setQueue] = useState<StudyCard[] | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    api.dueStudyCards(projectId).then((cards) => {
      setQueue(cards);
      setTotal(cards.length);
    });
  }, [projectId]);

  const card = queue?.[0] ?? null;

  const grade = useCallback(
    async (g: StudyGrade) => {
      if (!card || busy) return;
      setBusy(true);
      try {
        const next = await api.reviewStudyCard(card.id, g);
        setReviewed((n) => n + 1);
        setQueue((q) => {
          const rest = (q ?? []).slice(1);
          return g === "again" ? [...rest, next] : rest;
        });
        setFlipped(false);
      } finally {
        setBusy(false);
      }
    },
    [card, busy],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        setFlipped((f) => !f);
      } else if (flipped && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        grade((["again", "hard", "good", "easy"] as const)[Number(e.key) - 1]);
      } else if (e.key === "Escape") {
        onDone();
      }
    };
    const target: HTMLElement | Window = keyScope?.current ?? window;
    target.addEventListener("keydown", onKey as EventListener);
    return () => target.removeEventListener("keydown", onKey as EventListener);
  }, [flipped, grade, onDone, keyScope]);

  if (!queue) return <p className="text-[11px] text-[var(--color-text-muted)]">Loading…</p>;

  const pct = total > 0 ? Math.min(100, Math.round(((total - queue.length) / total) * 100)) : 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text)]">Review</span>
        <span>{queue.length} left</span>
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-border)]">
          <div
            className="h-full rounded-full bg-[var(--color-accent)] transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
        <button type="button" onClick={onDone} className="text-[11px] hover:text-[var(--color-text)]">
          {card ? "Stop" : "Back"}
        </button>
      </div>
      {card ? (
        <>
          <Flashcard
            front={card.front}
            back={card.back}
            source={card.source}
            flipped={flipped}
            onFlip={() => setFlipped((f) => !f)}
            onGrade={grade}
            busy={busy}
            large={large}
          />
          <div className="text-center text-[10px] text-[var(--color-text-muted)]">
            Space flips · 1 Again · 2 Hard · 3 Good · 4 Easy · Esc stops
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-center">
          <div className="text-sm font-medium text-[var(--color-text)]">Done for now</div>
          <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
            {reviewed} review{reviewed === 1 ? "" : "s"} this session.
          </div>
        </div>
      )}
    </div>
  );
}
