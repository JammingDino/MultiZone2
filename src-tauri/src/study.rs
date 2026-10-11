//! Study mode — a project for learning a body of material rather than working
//! on it. NotebookLM is the reference for the source handling; the difference
//! is that the sources never leave the machine.
//!
//! Three things live here:
//!
//! - **The mode.** A per-project flag. A chat in a study project answers from
//!   the project's own sources and nothing else: the web tools are withheld —
//!   from the request and again at the executor, as plan mode does — and the
//!   prompt makes "the sources don't cover this" an answer rather than a
//!   failure. A study tool that quietly fills a gap from the model's own
//!   knowledge is worse than none, because the gap is invisible exactly where
//!   the learner is least able to catch it.
//!
//! - **The study state.** Flashcard decks, quizzes and cheat sheets the model
//!   generates are stored per project, not left in the transcript: every card
//!   carries an SM-2 schedule, every quiz answer is kept, and a cheat sheet is
//!   a document both the model and the learner can revise. That record is what
//!   makes this a study tool rather than a chat with a document.
//!
//! - **The scheduler.** SM-2, which is old, simple and good enough. Four
//!   grades rather than six, because nobody can tell a 3 from a 4 at speed.

use crate::commands::{new_id, now_ts};
use crate::error::{AppError, AppResult};
use crate::llm::types::Tool;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// A deck or quiz larger than this is a chapter transcribed, not a set
/// someone can sit down and work through.
pub const MAX_ITEMS: usize = 40;
/// Per-field ceiling. A card's back is an answer, not an essay.
const MAX_FIELD_CHARS: usize = 2_000;
/// A cheat sheet fits on a page or two. Past this it is the notes again.
pub const MAX_SHEET_CHARS: usize = 30_000;
const DAY_MS: i64 = 86_400_000;
/// A card graded "Again" comes back in the same sitting, not tomorrow.
const RELEARN_MS: i64 = 10 * 60_000;
const MIN_EASE: f64 = 1.3;

/// The web tools a study chat does not get. The sources are the project's;
/// a search engine is somebody else's.
const WITHHELD: &[&str] = &[
    "smart_search",
    "smart_fetch",
    "smart_crawl",
    "http_request",
    "web_search",
    "extract_url",
];

pub fn withholds(name: &str) -> bool {
    WITHHELD.contains(&name)
}

// ─── The mode ────────────────────────────────────────────────────────────────

/// The project this chat studies, if its project is marked for study.
pub async fn study_project_for_chat(db: &SqlitePool, chat_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT p.id FROM chats c JOIN projects p ON p.id = c.project_id
         WHERE c.id = ?1 AND p.study_mode = 1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten()
}

/// Apply study mode to a built toolset. Returns whether the chat is studying.
///
/// The web tools go; the project's knowledge search comes in whether or not
/// the chat ticked "use knowledge", because in a study project the sources are
/// the point; and the study tools are added. Called beside `apply_plan_mode`
/// at every place the toolset is rebuilt.
pub async fn apply(db: &SqlitePool, chat_id: &str, tools: &mut Vec<Tool>) -> bool {
    let Some(project_id) = study_project_for_chat(db, chat_id).await else {
        return false;
    };
    tools.retain(|t| !withholds(&t.function.name));
    if crate::knowledge::has_index(db, &project_id).await
        && !tools.iter().any(|t| t.function.name == "search_local_files")
    {
        tools.push(crate::tools::knowledge::definition());
    }
    tools.extend(crate::tools::study::definitions());
    true
}

/// What a withheld web call gets back instead of a result.
pub fn refusal(name: &str) -> String {
    serde_json::json!({
        "error": format!(
            "`{name}` is not available in a study project: answers come from the project's own \
             sources only. If they do not cover the question, say so."
        )
    })
    .to_string()
}

/// The standing instructions for a study chat. `indexed` says whether the
/// project's sources are searchable yet; without an index the honest answer
/// to almost everything is "set the sources up first", and the model has to
/// be told that rather than left to improvise from memory.
pub fn preamble(indexed: bool, has_diagrams: bool) -> String {
    let sources = if indexed {
        "The sources are this project's indexed files. Search them with `search_local_files` \
         before answering anything about the material — every time, even when you think you \
         know — and read a file directly when a passage needs its surroundings."
    } else {
        "This project's sources are not indexed yet, so you cannot search them. Say so, and \
         tell the user to set up Knowledge in the project's settings (a directory and an \
         embedding model, then Index). Until then you may read files in the project directory \
         if you have a tool for it; you may not answer from memory."
    };
    let mind_map = if has_diagrams {
        "\n- A mind map or concept map: `draw_diagram` with a Mermaid `mindmap`, built from \
         what the sources say."
    } else {
        ""
    };
    format!(
        "# Study mode\n\
         This project is for learning a body of material. {sources}\n\n\
         ## Grounding — the rule that matters most\n\
         - Answer only from the sources. Cite every claim inline with its `[n]` ref. Files the user \
         attaches to a message are sources too.\n\
         - When the sources do not cover something, say exactly that: \"The sources don't cover \
         this.\" Do not fill the gap from your own knowledge — a gap the learner cannot see is \
         worse than one they can. If they then ask for general knowledge explicitly, give it, \
         labelled as not from their sources.\n\
         - When the sources disagree or are ambiguous, show both and say which says what.\n\n\
         ## Study tools\n\
         - `make_flashcards` when the user wants cards, or to revise. One fact per card, the \
         front a question that has one answer. The cards are kept and scheduled for review.\n\
         - `make_quiz` when they want to test themselves. Multiple choice, one correct option, \
         plausible distractors drawn from the same material, an explanation that cites.\n\
         - `make_cheatsheet` when they want a cheat sheet, summary sheet or formula sheet: one \
         dense Markdown page — short headed sections, tables, bullet lists, key formulas — that \
         they keep open beside the chat. Pass `set_id` to revise one that exists rather than \
         making a second.\n\
         - `study_progress` to see what has been missed before deciding what to teach or quiz \
         next.{mind_map}\n\
         - A study guide, briefing, FAQ or timeline is a well-structured answer in Markdown, \
         cited like any other.\n\
         Search first, then generate: a card or question you cannot cite does not belong in \
         the set.\n\n\
         ## Math in study sets\n\
         Write math as `$…$` inline and `$$…$$` for display in every field — questions, \
         options, answers, explanations, sheets. Tool arguments are JSON, so every LaTeX \
         backslash is doubled: `\"$\\\\frac{{a}}{{b}}$\"`. A single one (`\"$\\frac{{a}}{{b}}$\"`) \
         arrives as a form feed followed by `rac`."
    )
}

// ─── State ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct StudySet {
    pub id: String,
    pub project_id: String,
    pub chat_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub created_at: i64,
    /// Cards in a deck, questions in a quiz.
    pub item_count: i64,
    /// Cards due now (decks only).
    pub due_count: i64,
    /// Questions answered at least once, and of those, how many were right
    /// on the latest attempt (quizzes only).
    pub answered: i64,
    pub correct: i64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct StudyCard {
    pub id: String,
    pub set_id: String,
    pub ordinal: i64,
    pub front: String,
    pub back: String,
    pub source: Option<String>,
    pub ease: f64,
    pub interval_days: f64,
    pub repetitions: i64,
    pub lapses: i64,
    pub due_at: i64,
    pub last_reviewed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyQuestion {
    pub id: String,
    pub set_id: String,
    pub ordinal: i64,
    pub question: String,
    pub options: Vec<String>,
    pub answer_index: i64,
    pub explanation: Option<String>,
    pub source: Option<String>,
    /// The latest answer given, if any.
    pub last_choice: Option<i64>,
    pub attempts: i64,
    pub wrong: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudySetDetail {
    pub set: StudySet,
    pub cards: Vec<StudyCard>,
    pub questions: Vec<StudyQuestion>,
    /// A cheat sheet's Markdown, and when it last changed (cheat sheets only).
    pub body: Option<String>,
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyOverview {
    pub project_id: String,
    pub indexed: bool,
    pub due_count: i64,
    pub card_count: i64,
    /// When the next card not yet due comes due, for "nothing due — next in 3h".
    pub next_due_at: Option<i64>,
    pub sets: Vec<StudySet>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewCard {
    pub front: String,
    pub back: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewQuestion {
    pub question: String,
    pub options: Vec<String>,
    pub answer_index: i64,
    pub explanation: Option<String>,
    pub source: Option<String>,
}

fn clip(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= MAX_FIELD_CHARS {
        t.to_string()
    } else {
        t.chars().take(MAX_FIELD_CHARS).collect::<String>() + "…"
    }
}

fn opt_clip(s: Option<&str>) -> Option<String> {
    s.map(str::trim).filter(|s| !s.is_empty()).map(clip)
}

const SET_COLS: &str = "s.id, s.project_id, s.chat_id, s.kind, s.title, s.created_at,
    (SELECT COUNT(*) FROM study_cards c WHERE c.set_id = s.id)
      + (SELECT COUNT(*) FROM study_questions q WHERE q.set_id = s.id) AS item_count,
    (SELECT COUNT(*) FROM study_cards c WHERE c.set_id = s.id AND c.due_at <= ?1) AS due_count,
    (SELECT COUNT(DISTINCT a.question_id) FROM study_attempts a
       JOIN study_questions q ON q.id = a.question_id WHERE q.set_id = s.id) AS answered,
    (SELECT COUNT(*) FROM study_questions q WHERE q.set_id = s.id AND (
       SELECT a.correct FROM study_attempts a WHERE a.question_id = q.id
       ORDER BY a.answered_at DESC LIMIT 1) = 1) AS correct";

pub async fn get_set(db: &SqlitePool, set_id: &str) -> AppResult<StudySet> {
    sqlx::query_as::<_, StudySet>(&format!("SELECT {SET_COLS} FROM study_sets s WHERE s.id = ?2"))
        .bind(now_ts())
        .bind(set_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("study set {set_id}")))
}

pub async fn overview(db: &SqlitePool, project_id: &str) -> AppResult<StudyOverview> {
    let now = now_ts();
    let sets = sqlx::query_as::<_, StudySet>(&format!(
        "SELECT {SET_COLS} FROM study_sets s WHERE s.project_id = ?2 ORDER BY s.created_at DESC"
    ))
    .bind(now)
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let (due_count, card_count): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(due_at <= ?1), 0), COUNT(*) FROM study_cards WHERE project_id = ?2",
    )
    .bind(now)
    .bind(project_id)
    .fetch_one(db)
    .await?;
    let next_due_at: Option<i64> = sqlx::query_scalar(
        "SELECT MIN(due_at) FROM study_cards WHERE project_id = ?2 AND due_at > ?1",
    )
    .bind(now)
    .bind(project_id)
    .fetch_one(db)
    .await?;
    Ok(StudyOverview {
        project_id: project_id.to_string(),
        indexed: crate::knowledge::has_index(db, project_id).await,
        due_count,
        card_count,
        next_due_at,
        sets,
    })
}

const CARD_COLS: &str = "id, set_id, ordinal, front, back, source, ease, interval_days, \
    repetitions, lapses, due_at, last_reviewed_at";

async fn questions_of(db: &SqlitePool, set_id: &str) -> AppResult<Vec<StudyQuestion>> {
    let rows: Vec<(String, String, i64, String, String, i64, Option<String>, Option<String>, Option<i64>, i64, i64)> =
        sqlx::query_as(
            "SELECT q.id, q.set_id, q.ordinal, q.question, q.options, q.answer_index, q.explanation, q.source,
               (SELECT a.chosen_index FROM study_attempts a WHERE a.question_id = q.id
                  ORDER BY a.answered_at DESC LIMIT 1),
               (SELECT COUNT(*) FROM study_attempts a WHERE a.question_id = q.id),
               (SELECT COUNT(*) FROM study_attempts a WHERE a.question_id = q.id AND a.correct = 0)
             FROM study_questions q WHERE q.set_id = ?1 ORDER BY q.ordinal",
        )
        .bind(set_id)
        .fetch_all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(|(id, set_id, ordinal, question, options, answer_index, explanation, source, last_choice, attempts, wrong)| {
            StudyQuestion {
                id,
                set_id,
                ordinal,
                question,
                options: serde_json::from_str(&options).unwrap_or_default(),
                answer_index,
                explanation,
                source,
                last_choice,
                attempts,
                wrong,
            }
        })
        .collect())
}

pub async fn set_detail(db: &SqlitePool, set_id: &str) -> AppResult<StudySetDetail> {
    let set = get_set(db, set_id).await?;
    let cards = sqlx::query_as::<_, StudyCard>(&format!(
        "SELECT {CARD_COLS} FROM study_cards WHERE set_id = ?1 ORDER BY ordinal"
    ))
    .bind(set_id)
    .fetch_all(db)
    .await?;
    let questions = questions_of(db, set_id).await?;
    let (body, updated_at): (Option<String>, Option<i64>) =
        sqlx::query_as("SELECT body, updated_at FROM study_sets WHERE id = ?1")
            .bind(set_id)
            .fetch_one(db)
            .await?;
    Ok(StudySetDetail { set, cards, questions, body, updated_at })
}

/// Cards due now across the project, most overdue first.
pub async fn due_cards(db: &SqlitePool, project_id: &str, limit: i64) -> AppResult<Vec<StudyCard>> {
    Ok(sqlx::query_as::<_, StudyCard>(&format!(
        "SELECT {CARD_COLS} FROM study_cards WHERE project_id = ?1 AND due_at <= ?2
         ORDER BY due_at, ordinal LIMIT ?3"
    ))
    .bind(project_id)
    .bind(now_ts())
    .bind(limit.clamp(1, 500))
    .fetch_all(db)
    .await?)
}

async fn insert_set(
    conn: &mut sqlx::SqliteConnection,
    project_id: &str,
    chat_id: Option<&str>,
    kind: &str,
    title: &str,
) -> AppResult<String> {
    let id = new_id();
    let title = match title.trim() {
        "" if kind == "quiz" => "Quiz".to_string(),
        "" if kind == "cheatsheet" => "Cheat sheet".to_string(),
        "" => "Flashcards".to_string(),
        t => clip(t),
    };
    sqlx::query(
        "INSERT INTO study_sets (id, project_id, chat_id, kind, title, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&id)
    .bind(project_id)
    .bind(chat_id)
    .bind(kind)
    .bind(&title)
    .bind(now_ts())
    .execute(conn)
    .await?;
    Ok(id)
}

pub async fn create_deck(
    db: &SqlitePool,
    project_id: &str,
    chat_id: Option<&str>,
    title: &str,
    cards: &[NewCard],
) -> AppResult<StudySetDetail> {
    let cards: Vec<&NewCard> = cards
        .iter()
        .filter(|c| !c.front.trim().is_empty() && !c.back.trim().is_empty())
        .take(MAX_ITEMS)
        .collect();
    if cards.is_empty() {
        return Err(AppError::Invalid("a deck needs at least one card with a front and a back".into()));
    }
    let mut tx = db.begin().await?;
    let set_id = insert_set(&mut *tx, project_id, chat_id, "flashcards", title).await?;
    let now = now_ts();
    for (i, c) in cards.iter().enumerate() {
        sqlx::query(
            "INSERT INTO study_cards (id, set_id, project_id, ordinal, front, back, source, due_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        )
        .bind(new_id())
        .bind(&set_id)
        .bind(project_id)
        .bind(i as i64)
        .bind(clip(&c.front))
        .bind(clip(&c.back))
        .bind(opt_clip(c.source.as_deref()))
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    set_detail(db, &set_id).await
}

pub async fn create_quiz(
    db: &SqlitePool,
    project_id: &str,
    chat_id: Option<&str>,
    title: &str,
    questions: &[NewQuestion],
) -> AppResult<StudySetDetail> {
    let mut kept = Vec::new();
    for q in questions.iter().take(MAX_ITEMS) {
        let options: Vec<String> = q
            .options
            .iter()
            .map(|o| clip(o))
            .filter(|o| !o.is_empty())
            .collect();
        if q.question.trim().is_empty() || options.len() < 2 {
            continue;
        }
        if q.answer_index < 0 || q.answer_index as usize >= options.len() {
            return Err(AppError::Invalid(format!(
                "question \"{}\": answer_index {} is not one of its {} options (0-based)",
                q.question.trim(),
                q.answer_index,
                options.len()
            )));
        }
        kept.push((q, options));
    }
    if kept.is_empty() {
        return Err(AppError::Invalid("a quiz needs at least one question with two or more options".into()));
    }
    let mut tx = db.begin().await?;
    let set_id = insert_set(&mut *tx, project_id, chat_id, "quiz", title).await?;
    let now = now_ts();
    for (i, (q, options)) in kept.iter().enumerate() {
        sqlx::query(
            "INSERT INTO study_questions (id, set_id, project_id, ordinal, question, options, answer_index, explanation, source, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .bind(new_id())
        .bind(&set_id)
        .bind(project_id)
        .bind(i as i64)
        .bind(clip(&q.question))
        .bind(serde_json::to_string(options)?)
        .bind(q.answer_index)
        .bind(opt_clip(q.explanation.as_deref()))
        .bind(opt_clip(q.source.as_deref()))
        .bind(now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    set_detail(db, &set_id).await
}

fn sheet_body(body: &str) -> AppResult<String> {
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::Invalid("a cheat sheet needs some content".into()));
    }
    Ok(if body.chars().count() <= MAX_SHEET_CHARS {
        body.to_string()
    } else {
        body.chars().take(MAX_SHEET_CHARS).collect::<String>() + "\n\n…"
    })
}

pub async fn create_cheatsheet(
    db: &SqlitePool,
    project_id: &str,
    chat_id: Option<&str>,
    title: &str,
    body: &str,
) -> AppResult<StudySetDetail> {
    let body = sheet_body(body)?;
    let mut tx = db.begin().await?;
    let set_id = insert_set(&mut *tx, project_id, chat_id, "cheatsheet", title).await?;
    sqlx::query("UPDATE study_sets SET body = ?1, updated_at = created_at WHERE id = ?2")
        .bind(&body)
        .bind(&set_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    set_detail(db, &set_id).await
}

/// Replace a cheat sheet's content, and its title when one is given. Refused
/// for a set that is not a cheat sheet, or — when `project_id` is given, as it
/// is for the model — one in another project.
pub async fn update_cheatsheet(
    db: &SqlitePool,
    set_id: &str,
    project_id: Option<&str>,
    title: Option<&str>,
    body: &str,
) -> AppResult<StudySetDetail> {
    let set = get_set(db, set_id).await?;
    if set.kind != "cheatsheet" || project_id.is_some_and(|p| p != set.project_id) {
        return Err(AppError::NotFound(format!("cheat sheet {set_id}")));
    }
    let body = sheet_body(body)?;
    let title = title.map(str::trim).filter(|t| !t.is_empty()).map(clip).unwrap_or(set.title);
    sqlx::query("UPDATE study_sets SET body = ?1, title = ?2, updated_at = ?3 WHERE id = ?4")
        .bind(&body)
        .bind(&title)
        .bind(now_ts())
        .bind(set_id)
        .execute(db)
        .await?;
    set_detail(db, set_id).await
}

pub async fn delete_set(db: &SqlitePool, set_id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM study_sets WHERE id = ?1").bind(set_id).execute(db).await?;
    Ok(())
}

// ─── The scheduler ───────────────────────────────────────────────────────────

/// How well a card was recalled. Anki's four buttons, mapped onto SM-2's
/// 0–5 quality scale at 1, 3, 4 and 5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Grade {
    Again,
    Hard,
    Good,
    Easy,
}

impl Grade {
    fn quality(self) -> f64 {
        match self {
            Grade::Again => 1.0,
            Grade::Hard => 3.0,
            Grade::Good => 4.0,
            Grade::Easy => 5.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Schedule {
    pub ease: f64,
    pub interval_days: f64,
    pub repetitions: i64,
    pub lapses: i64,
}

/// One SM-2 step. A lapse resets the run and comes back within the sitting;
/// a recall grows the interval 1 day → 6 days → interval × ease. "Hard" is
/// SM-2's quality 3, which passes but costs ease; "Easy" gets a 1.3× bonus on
/// top, as Anki does, so it is worth pressing.
pub fn schedule(prev: Schedule, grade: Grade) -> Schedule {
    let q = grade.quality();
    let ease = (prev.ease + (0.1 - (5.0 - q) * (0.08 + (5.0 - q) * 0.02))).max(MIN_EASE);
    if grade == Grade::Again {
        return Schedule { ease, interval_days: 0.0, repetitions: 0, lapses: prev.lapses + 1 };
    }
    let repetitions = prev.repetitions + 1;
    let mut interval_days = match repetitions {
        1 => 1.0,
        2 => 6.0,
        _ => (prev.interval_days * ease).round(),
    };
    if grade == Grade::Hard && repetitions > 2 {
        interval_days = (prev.interval_days * 1.2).round().max(prev.interval_days + 1.0);
    }
    if grade == Grade::Easy {
        interval_days = (interval_days * 1.3).round();
    }
    Schedule { ease, interval_days, repetitions, lapses: prev.lapses }
}

pub async fn review_card(db: &SqlitePool, card_id: &str, grade: Grade) -> AppResult<StudyCard> {
    let card = sqlx::query_as::<_, StudyCard>(&format!("SELECT {CARD_COLS} FROM study_cards WHERE id = ?1"))
        .bind(card_id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("study card {card_id}")))?;
    let next = schedule(
        Schedule {
            ease: card.ease,
            interval_days: card.interval_days,
            repetitions: card.repetitions,
            lapses: card.lapses,
        },
        grade,
    );
    let now = now_ts();
    let due_at = if grade == Grade::Again {
        now + RELEARN_MS
    } else {
        now + (next.interval_days * DAY_MS as f64) as i64
    };
    sqlx::query(
        "UPDATE study_cards SET ease = ?1, interval_days = ?2, repetitions = ?3, lapses = ?4,
           due_at = ?5, last_reviewed_at = ?6 WHERE id = ?7",
    )
    .bind(next.ease)
    .bind(next.interval_days)
    .bind(next.repetitions)
    .bind(next.lapses)
    .bind(due_at)
    .bind(now)
    .bind(card_id)
    .execute(db)
    .await?;
    Ok(StudyCard {
        ease: next.ease,
        interval_days: next.interval_days,
        repetitions: next.repetitions,
        lapses: next.lapses,
        due_at,
        last_reviewed_at: Some(now),
        ..card
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerResult {
    pub correct: bool,
    pub answer_index: i64,
    pub explanation: Option<String>,
    pub source: Option<String>,
}

pub async fn answer_question(db: &SqlitePool, question_id: &str, chosen: i64) -> AppResult<AnswerResult> {
    let row: Option<(String, i64, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT project_id, answer_index, explanation, source FROM study_questions WHERE id = ?1",
    )
    .bind(question_id)
    .fetch_optional(db)
    .await?;
    let (project_id, answer_index, explanation, source) =
        row.ok_or_else(|| AppError::NotFound(format!("study question {question_id}")))?;
    let correct = chosen == answer_index;
    sqlx::query(
        "INSERT INTO study_attempts (id, question_id, project_id, chosen_index, correct, answered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(new_id())
    .bind(question_id)
    .bind(&project_id)
    .bind(chosen)
    .bind(correct)
    .bind(now_ts())
    .execute(db)
    .await?;
    Ok(AnswerResult { correct, answer_index, explanation, source })
}

/// What the model is told when it asks how the learner is doing: the deck
/// totals, and the questions and cards they have actually struggled with —
/// the weak spots, not a score.
pub async fn progress_report(db: &SqlitePool, project_id: &str) -> AppResult<serde_json::Value> {
    let ov = overview(db, project_id).await?;
    let missed: Vec<(String, String, i64, i64)> = sqlx::query_as(
        "SELECT q.question, s.title,
           (SELECT COUNT(*) FROM study_attempts a WHERE a.question_id = q.id AND a.correct = 0) AS wrong,
           (SELECT COUNT(*) FROM study_attempts a WHERE a.question_id = q.id) AS total
         FROM study_questions q JOIN study_sets s ON s.id = q.set_id
         WHERE q.project_id = ?1 AND wrong > 0
         ORDER BY wrong DESC, total LIMIT 15",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    let lapsed: Vec<(String, i64)> = sqlx::query_as(
        "SELECT front, lapses FROM study_cards WHERE project_id = ?1 AND lapses > 0
         ORDER BY lapses DESC, ease LIMIT 15",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    Ok(serde_json::json!({
        "cards": ov.card_count,
        "cards_due": ov.due_count,
        "sets": ov.sets.iter().map(|s| serde_json::json!({
            "title": s.title,
            "kind": s.kind,
            "items": s.item_count,
            "answered": if s.kind == "quiz" { Some(s.answered) } else { None },
            "correct": if s.kind == "quiz" { Some(s.correct) } else { None },
        })).collect::<Vec<_>>(),
        "missed_questions": missed.iter().map(|(q, set, wrong, total)| serde_json::json!({
            "question": q, "set": set, "wrong": wrong, "attempts": total,
        })).collect::<Vec<_>>(),
        "hard_cards": lapsed.iter().map(|(front, lapses)| serde_json::json!({
            "front": front, "forgotten": lapses,
        })).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Schedule {
        Schedule { ease: 2.5, interval_days: 0.0, repetitions: 0, lapses: 0 }
    }

    #[test]
    fn good_recalls_follow_the_sm2_ladder() {
        let a = schedule(fresh(), Grade::Good);
        assert_eq!(a.interval_days, 1.0);
        let b = schedule(a, Grade::Good);
        assert_eq!(b.interval_days, 6.0);
        let c = schedule(b, Grade::Good);
        assert_eq!(c.interval_days, (6.0 * c.ease).round());
        assert!((c.ease - 2.5).abs() < 1e-9, "Good leaves ease where it was");
    }

    #[test]
    fn again_resets_the_run_and_counts_a_lapse() {
        let learnt = schedule(schedule(schedule(fresh(), Grade::Good), Grade::Good), Grade::Good);
        let lapsed = schedule(learnt, Grade::Again);
        assert_eq!(lapsed.repetitions, 0);
        assert_eq!(lapsed.interval_days, 0.0);
        assert_eq!(lapsed.lapses, 1);
        assert!(lapsed.ease < learnt.ease);
    }

    #[test]
    fn ease_never_drops_below_the_floor() {
        let mut s = fresh();
        for _ in 0..20 {
            s = schedule(s, Grade::Again);
        }
        assert!((s.ease - MIN_EASE).abs() < 1e-9);
    }

    #[test]
    fn easy_outpaces_good_and_hard_trails_it() {
        let base = schedule(schedule(fresh(), Grade::Good), Grade::Good);
        let hard = schedule(base, Grade::Hard).interval_days;
        let good = schedule(base, Grade::Good).interval_days;
        let easy = schedule(base, Grade::Easy).interval_days;
        assert!(hard < good && good < easy, "hard {hard} good {good} easy {easy}");
        assert!(hard > base.interval_days, "Hard still moves the card forward");
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        sqlx::query("INSERT INTO projects (id, name, study_mode, created_at, updated_at) VALUES ('p', 'P', 1, 0, 0)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn a_new_deck_is_due_and_a_review_schedules_it_away() {
        let db = pool().await;
        let deck = create_deck(
            &db,
            "p",
            None,
            "Signals",
            &[
                NewCard { front: "Q1".into(), back: "A1".into(), source: Some("notes.md".into()) },
                NewCard { front: " ".into(), back: "dropped".into(), source: None },
            ],
        )
        .await
        .unwrap();
        assert_eq!(deck.cards.len(), 1, "a card with no front is not a card");
        assert_eq!(overview(&db, "p").await.unwrap().due_count, 1);

        review_card(&db, &deck.cards[0].id, Grade::Good).await.unwrap();
        let ov = overview(&db, "p").await.unwrap();
        assert_eq!(ov.due_count, 0);
        assert!(ov.next_due_at.is_some());
    }

    #[tokio::test]
    async fn quiz_answers_are_kept_and_the_latest_one_scores() {
        let db = pool().await;
        let quiz = create_quiz(
            &db,
            "p",
            None,
            "Ch. 3",
            &[NewQuestion {
                question: "2 + 2?".into(),
                options: vec!["3".into(), "4".into()],
                answer_index: 1,
                explanation: None,
                source: None,
            }],
        )
        .await
        .unwrap();
        let q = &quiz.questions[0].id;
        assert!(!answer_question(&db, q, 0).await.unwrap().correct);
        assert!(answer_question(&db, q, 1).await.unwrap().correct);

        let set = get_set(&db, &quiz.set.id).await.unwrap();
        assert_eq!((set.answered, set.correct), (1, 1));
        let report = progress_report(&db, "p").await.unwrap();
        assert_eq!(report["missed_questions"][0]["wrong"], 1);
    }

    #[tokio::test]
    async fn an_answer_index_out_of_range_is_refused_not_stored() {
        let db = pool().await;
        let err = create_quiz(
            &db,
            "p",
            None,
            "",
            &[NewQuestion {
                question: "?".into(),
                options: vec!["a".into(), "b".into()],
                answer_index: 2,
                explanation: None,
                source: None,
            }],
        )
        .await;
        assert!(err.is_err());
        assert!(overview(&db, "p").await.unwrap().sets.is_empty());
    }

    #[tokio::test]
    async fn a_cheatsheet_is_kept_and_revised_in_place() {
        let db = pool().await;
        let sheet = create_cheatsheet(&db, "p", None, " ", "## Ohm\n$V = IR$").await.unwrap();
        assert_eq!(sheet.set.title, "Cheat sheet");
        assert_eq!(sheet.body.as_deref(), Some("## Ohm\n$V = IR$"));

        let revised = update_cheatsheet(&db, &sheet.set.id, Some("p"), Some("Circuits"), "## Ohm\n$I = V/R$")
            .await
            .unwrap();
        assert_eq!(revised.set.title, "Circuits");
        assert_eq!(revised.body.as_deref(), Some("## Ohm\n$I = V/R$"));
        assert_eq!(overview(&db, "p").await.unwrap().sets.len(), 1, "revised, not duplicated");

        assert!(update_cheatsheet(&db, &sheet.set.id, Some("other"), None, "x").await.is_err());
        assert!(update_cheatsheet(&db, &sheet.set.id, None, None, "  ").await.is_err());
        let quiz = create_quiz(
            &db,
            "p",
            None,
            "",
            &[NewQuestion {
                question: "?".into(),
                options: vec!["a".into(), "b".into()],
                answer_index: 0,
                explanation: None,
                source: None,
            }],
        )
        .await
        .unwrap();
        assert!(update_cheatsheet(&db, &quiz.set.id, None, None, "x").await.is_err(), "a quiz is not a sheet");
    }

    #[tokio::test]
    async fn study_mode_withholds_the_web_and_adds_the_study_tools() {
        let db = pool().await;
        sqlx::query("INSERT INTO chats (id, title, project_id, created_at, updated_at) VALUES ('c', 't', 'p', 0, 0)")
            .execute(&db)
            .await
            .unwrap();
        let mut tools = vec![crate::tools::smart_search::definition(), crate::tools::datetime::definition()];
        assert!(apply(&db, "c", &mut tools).await);
        let names: Vec<_> = tools.iter().map(|t| t.function.name.as_str()).collect();
        assert!(!names.contains(&"smart_search"));
        assert!(names.contains(&"get_current_datetime"));
        assert!(names.contains(&"make_flashcards") && names.contains(&"make_quiz"));
        assert!(names.contains(&"make_cheatsheet"));
    }
}
