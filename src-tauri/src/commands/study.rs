//! Study mode, as the window and the API see it. See `study`.

use crate::error::AppResult;
use crate::state::AppState;
use crate::study::{self, AnswerResult, Grade, StudyCard, StudyOverview, StudySetDetail};
use tauri::{AppHandle, Emitter, State};

fn changed(app: &AppHandle) {
    let _ = app.emit("study-changed", serde_json::json!({}));
}

#[tauri::command]
pub async fn study_overview(state: State<'_, AppState>, project_id: String) -> AppResult<StudyOverview> {
    study::overview(&state.db, &project_id).await
}

#[tauri::command]
pub async fn get_study_set(state: State<'_, AppState>, set_id: String) -> AppResult<StudySetDetail> {
    study::set_detail(&state.db, &set_id).await
}

#[tauri::command]
pub async fn due_study_cards(
    state: State<'_, AppState>,
    project_id: String,
    limit: Option<i64>,
) -> AppResult<Vec<StudyCard>> {
    study::due_cards(&state.db, &project_id, limit.unwrap_or(100)).await
}

#[tauri::command]
pub async fn review_study_card(
    app: AppHandle,
    state: State<'_, AppState>,
    card_id: String,
    grade: Grade,
) -> AppResult<StudyCard> {
    let out = study::review_card(&state.db, &card_id, grade).await?;
    changed(&app);
    Ok(out)
}

#[tauri::command]
pub async fn answer_study_question(
    app: AppHandle,
    state: State<'_, AppState>,
    question_id: String,
    chosen_index: i64,
) -> AppResult<AnswerResult> {
    let out = study::answer_question(&state.db, &question_id, chosen_index).await?;
    changed(&app);
    Ok(out)
}

/// The learner's own edit to a cheat sheet.
#[tauri::command]
pub async fn update_study_cheatsheet(
    app: AppHandle,
    state: State<'_, AppState>,
    set_id: String,
    title: Option<String>,
    body: String,
) -> AppResult<StudySetDetail> {
    let out = study::update_cheatsheet(&state.db, &set_id, None, title.as_deref(), &body).await?;
    changed(&app);
    Ok(out)
}

#[tauri::command]
pub async fn delete_study_set(app: AppHandle, state: State<'_, AppState>, set_id: String) -> AppResult<()> {
    study::delete_set(&state.db, &set_id).await?;
    changed(&app);
    Ok(())
}
