//! Scheduled runs (0.18) — prompts sent on a clock.
//!
//! Schema and the reasoning behind its columns are in migration 048. A run
//! fires through `run_send_entry`, the same path a message typed in the window
//! takes, so everything a turn does — tools, approvals, sub-agents, the stop
//! button — works the same for it. With close-to-tray (see `tray`) the app is
//! usually still running when the clock comes round, window or no window.
//!
//! A run that came due while the app was closed fires once at the next start,
//! not once per missed occurrence: an inbox sweep that missed three noons
//! wants one sweep, not three.

use crate::commands::messages::{run_send_entry, EngineCtx, InputPart, StreamSink, TurnOverride};
use crate::commands::{new_id, now_ts};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledRun {
    pub id: String,
    pub name: String,
    pub prompt: String,
    /// `new_chat` or `chat`.
    pub target: String,
    pub chat_id: Option<String>,
    pub zone_id: Option<String>,
    pub project_id: Option<String>,
    pub watch_chat_id: Option<String>,
    /// `once`, `interval`, `daily` or `weekly`.
    pub repeat: String,
    pub interval_minutes: Option<i64>,
    pub time_of_day: Option<String>,
    /// JSON array of weekdays, 0 = Sunday.
    pub weekdays: Option<String>,
    pub next_run_at: Option<i64>,
    pub enabled: bool,
    pub last_run_at: Option<i64>,
    pub last_chat_id: Option<String>,
    pub last_error: Option<String>,
    pub created_by_chat_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

const COLS: &str = "id, name, prompt, target, chat_id, zone_id, project_id, watch_chat_id, repeat, \
                    interval_minutes, time_of_day, weekdays, next_run_at, enabled, last_run_at, \
                    last_chat_id, last_error, created_by_chat_id, created_at, updated_at";

/// What a caller — the settings tab, the API, the `schedule_run` tool — asks
/// for. `run_at` is the first (or only) firing for `once` and `interval`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleInput {
    pub id: Option<String>,
    pub name: String,
    pub prompt: String,
    #[serde(default)]
    pub target: Option<String>,
    pub chat_id: Option<String>,
    pub zone_id: Option<String>,
    pub project_id: Option<String>,
    pub watch_chat_id: Option<String>,
    #[serde(default)]
    pub repeat: Option<String>,
    pub interval_minutes: Option<i64>,
    pub time_of_day: Option<String>,
    pub weekdays: Option<Vec<u32>>,
    pub run_at: Option<i64>,
    pub enabled: Option<bool>,
    pub created_by_chat_id: Option<String>,
}

fn parse_time(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s.trim(), "%H:%M").ok()
}

fn at_local(date: NaiveDate, time: NaiveTime) -> Option<DateTime<Local>> {
    // `earliest` resolves the hour a DST change repeats; a time that does not
    // exist that day (the hour it skips) yields None and the day is skipped.
    Local.from_local_datetime(&date.and_time(time)).earliest()
}

/// The next firing strictly after `after`, or `None` when the schedule has no
/// more (a `once`, or a malformed row). Pure apart from the local timezone.
pub fn next_after(
    repeat: &str,
    interval_minutes: Option<i64>,
    time_of_day: Option<&str>,
    weekdays: &[u32],
    after: DateTime<Local>,
) -> Option<i64> {
    match repeat {
        "interval" => {
            let m = interval_minutes.filter(|m| *m > 0)?;
            Some((after + Duration::minutes(m)).timestamp_millis())
        }
        "daily" | "weekly" => {
            let time = parse_time(time_of_day?)?;
            (0..=8).find_map(|d| {
                let date = after.date_naive() + Duration::days(d);
                let day_ok = repeat == "daily"
                    || weekdays.contains(&date.weekday().num_days_from_sunday());
                at_local(date, time).filter(|t| day_ok && *t > after).map(|t| t.timestamp_millis())
            })
        }
        _ => None,
    }
}

fn weekdays_of(json: Option<&str>) -> Vec<u32> {
    json.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default()
}

/// Validate a request and write it. Returns the stored row.
pub async fn upsert(db: &SqlitePool, input: ScheduleInput) -> AppResult<ScheduledRun> {
    let bad = |m: &str| AppError::Invalid(m.to_string());
    let name = input.name.trim().to_string();
    let prompt = input.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(bad("A scheduled run needs a prompt."));
    }
    let target = input.target.clone().unwrap_or_else(|| "new_chat".into());
    if !matches!(target.as_str(), "new_chat" | "chat") {
        return Err(bad("target must be new_chat or chat"));
    }
    if target == "chat" && input.chat_id.is_none() {
        return Err(bad("A run that appends to a chat needs the chat."));
    }
    let repeat = input.repeat.clone().unwrap_or_else(|| "once".into());
    let weekdays: Vec<u32> = input.weekdays.clone().unwrap_or_default().into_iter().filter(|d| *d < 7).collect();
    let now = Local::now();
    let next = match repeat.as_str() {
        "once" => Some(input.run_at.ok_or_else(|| bad("A one-time run needs a time."))?),
        "interval" => {
            let m = input.interval_minutes.filter(|m| *m > 0).ok_or_else(|| bad("Repeat every how many minutes?"))?;
            Some(input.run_at.unwrap_or((now + Duration::minutes(m)).timestamp_millis()))
        }
        "daily" | "weekly" => {
            let t = input.time_of_day.as_deref().filter(|t| parse_time(t).is_some());
            let t = t.ok_or_else(|| bad("A daily or weekly run needs a time as HH:MM."))?;
            if repeat == "weekly" && weekdays.is_empty() {
                return Err(bad("A weekly run needs at least one day."));
            }
            next_after(&repeat, None, Some(t), &weekdays, now)
        }
        _ => return Err(bad("repeat must be once, interval, daily or weekly")),
    };
    let name = if name.is_empty() { prompt.chars().take(40).collect() } else { name };
    let id = input.id.clone().unwrap_or_else(new_id);
    let ts = now_ts();
    sqlx::query(
        "INSERT INTO scheduled_runs (id, name, prompt, target, chat_id, zone_id, project_id, watch_chat_id,
            repeat, interval_minutes, time_of_day, weekdays, next_run_at, enabled, created_by_chat_id,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, prompt = excluded.prompt, target = excluded.target,
            chat_id = excluded.chat_id, zone_id = excluded.zone_id, project_id = excluded.project_id,
            watch_chat_id = excluded.watch_chat_id, repeat = excluded.repeat,
            interval_minutes = excluded.interval_minutes, time_of_day = excluded.time_of_day,
            weekdays = excluded.weekdays, next_run_at = excluded.next_run_at,
            enabled = excluded.enabled, updated_at = excluded.updated_at",
    )
    .bind(&id)
    .bind(&name)
    .bind(&prompt)
    .bind(&target)
    .bind(if target == "chat" { input.chat_id.clone() } else { None })
    .bind(&input.zone_id)
    .bind(&input.project_id)
    .bind(&input.watch_chat_id)
    .bind(&repeat)
    .bind(input.interval_minutes)
    .bind(&input.time_of_day)
    .bind((!weekdays.is_empty()).then(|| serde_json::to_string(&weekdays).unwrap_or_default()))
    .bind(next)
    .bind(input.enabled.unwrap_or(true))
    .bind(&input.created_by_chat_id)
    .bind(ts)
    .execute(db)
    .await?;
    get(db, &id).await?.ok_or_else(|| AppError::NotFound(format!("scheduled run {id}")))
}

pub async fn get(db: &SqlitePool, id: &str) -> AppResult<Option<ScheduledRun>> {
    Ok(sqlx::query_as(&format!("SELECT {COLS} FROM scheduled_runs WHERE id = ?1"))
        .bind(id)
        .fetch_optional(db)
        .await?)
}

pub async fn list(db: &SqlitePool) -> AppResult<Vec<ScheduledRun>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COLS} FROM scheduled_runs ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, name"
    ))
    .fetch_all(db)
    .await?)
}

pub async fn delete(db: &SqlitePool, id: &str) -> AppResult<bool> {
    let r = sqlx::query("DELETE FROM scheduled_runs WHERE id = ?1").bind(id).execute(db).await?;
    Ok(r.rows_affected() > 0)
}

/// Start the clock. One task for the life of the app.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            if let Err(e) = tick(&app).await {
                tracing::warn!("scheduler tick failed: {e}");
            }
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        }
    });
}

async fn tick(app: &AppHandle) -> AppResult<()> {
    let db = app.state::<AppState>().db.clone();
    let due: Vec<ScheduledRun> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM scheduled_runs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?1"
    ))
    .bind(now_ts())
    .fetch_all(&db)
    .await?;
    for run in due {
        // Rescheduled before it fires: a crash mid-run must not fire it again.
        let next = next_after(
            &run.repeat,
            run.interval_minutes,
            run.time_of_day.as_deref(),
            &weekdays_of(run.weekdays.as_deref()),
            Local::now(),
        );
        sqlx::query("UPDATE scheduled_runs SET next_run_at = ?1, enabled = ?2 WHERE id = ?3")
            .bind(next)
            .bind(next.is_some())
            .bind(&run.id)
            .execute(&db)
            .await?;
        let app = app.clone();
        tauri::async_runtime::spawn(async move { fire(&app, run).await });
    }
    Ok(())
}

/// Fire a run now, whatever its schedule says. Also what "Run now" does.
pub async fn fire(app: &AppHandle, run: ScheduledRun) {
    let state = app.state::<AppState>();
    let db = state.db.clone();
    let result = fire_inner(app, &run).await;
    let (chat_id, error) = match result {
        Ok(chat_id) => (Some(chat_id), None),
        Err(e) => {
            tracing::warn!("scheduled run {} failed: {e}", run.name);
            (None, Some(e.to_string()))
        }
    };
    let _ = sqlx::query(
        "UPDATE scheduled_runs SET last_run_at = ?1, last_chat_id = COALESCE(?2, last_chat_id), last_error = ?3
          WHERE id = ?4",
    )
    .bind(now_ts())
    .bind(&chat_id)
    .bind(&error)
    .bind(&run.id)
    .execute(&db)
    .await;
    let _ = app.emit("schedules-changed", serde_json::json!({ "id": run.id }));
}

async fn fire_inner(app: &AppHandle, run: &ScheduledRun) -> AppResult<String> {
    let state = app.state::<AppState>();
    let chat_id = if run.target == "chat" {
        let id = run.chat_id.clone().ok_or_else(|| AppError::Invalid("no chat to append to".into()))?;
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM chats WHERE id = ?1")
            .bind(&id)
            .fetch_optional(&state.db)
            .await?;
        exists.ok_or_else(|| AppError::NotFound("the chat this run appends to was deleted".into()))?
    } else {
        let chat = crate::commands::chats::create_chat(
            app.state::<AppState>(),
            run.zone_id.clone(),
            run.project_id.clone(),
        )
        .await?;
        let title = format!("{} · {}", run.name, Local::now().format("%b %-d %H:%M"));
        sqlx::query("UPDATE chats SET title = ?1 WHERE id = ?2")
            .bind(&title)
            .bind(&chat.id)
            .execute(&state.db)
            .await?;
        chat.id
    };
    sqlx::query("UPDATE scheduled_runs SET last_chat_id = ?1 WHERE id = ?2")
        .bind(&chat_id)
        .bind(&run.id)
        .execute(&state.db)
        .await?;
    let _ = app.emit("chats-changed", serde_json::json!({}));

    let mut note = format!(
        "This message was sent by the scheduled run \"{}\" at {}, not typed by the user just now — \
         they may not be watching. Do the task and report what you found or did.",
        run.name,
        Local::now().format("%Y-%m-%d %H:%M"),
    );
    if let Some(watch) = &run.watch_chat_id {
        let transcript = crate::tools::subchat::transcript(&state.db, watch).await.unwrap_or_default();
        // The tail: a progress report is about where the work is now.
        let skip = transcript.chars().count().saturating_sub(16_000);
        let tail: String = transcript.chars().skip(skip).collect();
        let title: Option<String> = sqlx::query_scalar("SELECT title FROM chats WHERE id = ?1")
            .bind(watch)
            .fetch_optional(&state.db)
            .await?;
        note.push_str(&format!(
            "\n\nThe latest of the chat \"{}\" you are reporting on{}:\n\n{tail}",
            title.unwrap_or_default(),
            if skip > 0 { " (its earlier part is cut)" } else { "" },
        ));
    }
    let parts = vec![
        InputPart::HiddenText { text: note },
        InputPart::Text { text: run.prompt.clone() },
    ];
    let ctx = EngineCtx::from_state(&state);
    let sink = StreamSink::tauri(app.clone());
    run_send_entry(&ctx, &sink, &chat_id, parts, TurnOverride::default()).await?;
    Ok(chat_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).earliest().unwrap()
    }

    #[test]
    fn daily_fires_later_today_or_tomorrow() {
        let morning = local(2026, 9, 28, 9, 0);
        let noon = next_after("daily", None, Some("12:00"), &[], morning).unwrap();
        assert_eq!(noon, local(2026, 9, 28, 12, 0).timestamp_millis());
        let evening = local(2026, 9, 28, 13, 0);
        let next = next_after("daily", None, Some("12:00"), &[], evening).unwrap();
        assert_eq!(next, local(2026, 9, 29, 12, 0).timestamp_millis());
    }

    #[test]
    fn weekly_skips_to_the_next_listed_day() {
        // 2026-09-28 is a Monday. Fridays only.
        let monday = local(2026, 9, 28, 9, 0);
        let next = next_after("weekly", None, Some("08:30"), &[5], monday).unwrap();
        assert_eq!(next, local(2026, 10, 2, 8, 30).timestamp_millis());
    }

    #[test]
    fn interval_and_once() {
        let t = local(2026, 9, 28, 9, 0);
        assert_eq!(
            next_after("interval", Some(30), None, &[], t),
            Some(local(2026, 9, 28, 9, 30).timestamp_millis())
        );
        assert_eq!(next_after("once", None, None, &[], t), None);
        assert_eq!(next_after("daily", None, Some("nonsense"), &[], t), None);
    }
}
