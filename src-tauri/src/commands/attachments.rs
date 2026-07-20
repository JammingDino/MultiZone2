use crate::commands::{new_id, now_ts};
use crate::db::models::Attachment;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use base64::Engine;
use image::ImageReader;
use std::path::PathBuf;
use tauri::State;

fn classify(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" => "image",
        "txt" | "md" | "markdown" | "csv" | "tsv" | "json" | "yaml" | "yml" | "toml" | "log"
        | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "html" | "css" | "go" | "java" | "c" | "h"
        | "cpp" | "hpp" => "text",
        "pdf" => "pdf",
        _ => "other",
    }
}

#[tauri::command]
pub async fn upload_attachment(
    state: State<'_, AppState>,
    chat_id: String,
    file_path: String,
) -> AppResult<Attachment> {
    let src = PathBuf::from(&file_path);
    if !src.exists() {
        return Err(AppError::Invalid(format!("file not found: {file_path}")));
    }
    let file_name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "attachment".to_string());
    let ext = src
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let file_type = classify(&ext);

    if file_type == "pdf" {
        return Err(AppError::Invalid(
            "PDFs must be uploaded via save_pdf_attachment (rendered by frontend PDF.js)".into(),
        ));
    }

    let id = new_id();
    let now = now_ts();
    let (storage_path, content, page_count): (String, Option<String>, Option<i64>) = match file_type
    {
        "image" => {
            let target = state
                .attachments_dir
                .join(format!("{id}.{}", if ext.is_empty() { "img" } else { &ext }));
            let img = ImageReader::open(&src)?.with_guessed_format()?.decode()?;
            let (w, h) = (img.width(), img.height());
            let long = w.max(h);
            if long > 2048 {
                let scale = 1024.0 / long as f32;
                let nw = (w as f32 * scale).round() as u32;
                let nh = (h as f32 * scale).round() as u32;
                let resized = img.resize(nw, nh, image::imageops::FilterType::Lanczos3);
                let out_path = state.attachments_dir.join(format!("{id}.jpg"));
                resized.to_rgb8().save_with_format(&out_path, image::ImageFormat::Jpeg)?;
                (out_path.to_string_lossy().to_string(), None, None)
            } else {
                std::fs::copy(&src, &target)?;
                (target.to_string_lossy().to_string(), None, None)
            }
        }
        "text" => {
            let text = std::fs::read_to_string(&src)?;
            let target = state.attachments_dir.join(format!("{id}.{ext}"));
            std::fs::write(&target, &text)?;
            (target.to_string_lossy().to_string(), Some(text), None)
        }
        _ => {
            let target = state
                .attachments_dir
                .join(format!("{id}.{}", if ext.is_empty() { "bin" } else { &ext }));
            std::fs::copy(&src, &target)?;
            (target.to_string_lossy().to_string(), None, None)
        }
    };

    sqlx::query(
        "INSERT INTO attachments (id, message_id, chat_id, file_name, file_type, storage_path, content, page_count, created_at)
         VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&id)
    .bind(&chat_id)
    .bind(&file_name)
    .bind(file_type)
    .bind(&storage_path)
    .bind(&content)
    .bind(page_count)
    .bind(now)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Attachment>(
        "SELECT id, message_id, chat_id, file_name, file_type, storage_path, content, page_count, created_at
         FROM attachments WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

#[tauri::command]
pub async fn save_pdf_attachment(
    state: State<'_, AppState>,
    chat_id: String,
    file_name: String,
    pages_b64: Vec<String>,
) -> AppResult<Attachment> {
    let id = new_id();
    let now = now_ts();
    let page_count = pages_b64.len() as i64;

    let dir = state.attachments_dir.join(&id);
    std::fs::create_dir_all(&dir)?;

    for (i, b64) in pages_b64.iter().enumerate() {
        let stripped = b64
            .strip_prefix("data:image/jpeg;base64,")
            .or_else(|| b64.strip_prefix("data:image/png;base64,"))
            .unwrap_or(b64);
        let bytes = base64::engine::general_purpose::STANDARD.decode(stripped)?;
        let p = dir.join(format!("page_{:04}.jpg", i + 1));
        std::fs::write(&p, &bytes)?;
    }

    let storage_path = dir.to_string_lossy().to_string();
    sqlx::query(
        "INSERT INTO attachments (id, message_id, chat_id, file_name, file_type, storage_path, content, page_count, created_at)
         VALUES (?1, NULL, ?2, ?3, 'pdf', ?4, NULL, ?5, ?6)",
    )
    .bind(&id)
    .bind(&chat_id)
    .bind(&file_name)
    .bind(&storage_path)
    .bind(page_count)
    .bind(now)
    .execute(&state.db)
    .await?;

    let row = sqlx::query_as::<_, Attachment>(
        "SELECT id, message_id, chat_id, file_name, file_type, storage_path, content, page_count, created_at
         FROM attachments WHERE id = ?1",
    )
    .bind(&id)
    .fetch_one(&state.db)
    .await?;
    Ok(row)
}

/// Returns base64 data URLs for an attachment's images. For PDFs, returns one per page.
#[tauri::command]
pub async fn get_attachment_images(
    state: State<'_, AppState>,
    attachment_id: String,
) -> AppResult<Vec<String>> {
    let row = sqlx::query_as::<_, Attachment>(
        "SELECT id, message_id, chat_id, file_name, file_type, storage_path, content, page_count, created_at
         FROM attachments WHERE id = ?1",
    )
    .bind(&attachment_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("attachment {attachment_id}")))?;

    let mut out = Vec::new();
    match row.file_type.as_str() {
        "image" => {
            let bytes = std::fs::read(&row.storage_path)?;
            let mime = guess_image_mime(&row.storage_path);
            out.push(format!(
                "data:{};base64,{}",
                mime,
                base64::engine::general_purpose::STANDARD.encode(&bytes)
            ));
        }
        "pdf" => {
            let dir = PathBuf::from(&row.storage_path);
            let mut entries: Vec<_> = std::fs::read_dir(&dir)?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|e| e == "jpg").unwrap_or(false))
                .collect();
            entries.sort();
            for p in entries {
                let bytes = std::fs::read(&p)?;
                out.push(format!(
                    "data:image/jpeg;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                ));
            }
        }
        _ => {}
    }
    Ok(out)
}

fn guess_image_mime(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else {
        "image/jpeg"
    }
}

/// Write text to a user-chosen path from an export flow.
///
/// The fs plugin scopes writes to a small set of app dirs, so a path returned by
/// the native save dialog is rejected there. Exports are always an explicit user
/// action against a path the user just picked in the OS dialog, so we write it
/// directly here rather than widening the plugin scope to the whole disk.
#[tauri::command]
pub async fn write_export_file(path: String, contents: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.exists() {
            return Err(AppError::Invalid(format!(
                "folder does not exist: {}",
                parent.display()
            )));
        }
    }
    std::fs::write(&p, contents.as_bytes())?;
    Ok(())
}
