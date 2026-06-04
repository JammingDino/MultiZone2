use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "tag_chat".into(),
            description:
                "Create a tag (if one with the same name doesn't already exist) and assign it to \
                 the current conversation. Use this to categorize the chat by topic — for example \
                 'python', 'research', or 'billing'. If a tag with the same name already exists \
                 (case-insensitive) it is reused; passing 'color' or 'context_snippet' updates \
                 that existing tag. The tag is assigned with its context turned OFF by default; the \
                 user decides whether a tag's context snippet is injected into future turns."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The tag name. Keep it short — one or two lowercase words."
                    },
                    "color": {
                        "type": "string",
                        "description": "Optional hex color, e.g. \"#3b82f6\". If omitted, a stable color is derived from the name."
                    },
                    "context_snippet": {
                        "type": "string",
                        "description": "Optional text to associate with the tag. When the user enables this tag's context on a chat, the snippet is prepended to the system prompt. Only set this for tags whose presence should change how the model behaves."
                    }
                },
                "required": ["name"]
            }),
        },
    }
}

/// Create-or-reuse a tag by name and assign it to `chat_id`. Returns a small
/// JSON status the model (and the step UI) can read back.
pub async fn run(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Ok(json!({ "error": "tag_chat requires a non-empty name" }).to_string());
    }
    let color = args.get("color").and_then(|v| v.as_str()).map(str::to_string);
    let context_snippet = args
        .get("context_snippet")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty());

    let now = chrono::Utc::now().timestamp_millis();
    let has_updates = color.is_some() || context_snippet.is_some();

    // Reuse an existing tag with the same (case-insensitive) name.
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM tags WHERE lower(name) = lower(?1) LIMIT 1")
            .bind(&name)
            .fetch_optional(db)
            .await?;

    let (tag_id, created) = if let Some((id,)) = existing {
        // Update color and/or context snippet when the model supplies them, so
        // the tool can refine an existing tag (reflected in the tag editor).
        if has_updates {
            sqlx::query(
                "UPDATE tags SET
                   color = COALESCE(?1, color),
                   context_snippet = COALESCE(?2, context_snippet),
                   updated_at = ?3
                 WHERE id = ?4",
            )
            .bind(&color)
            .bind(&context_snippet)
            .bind(now)
            .bind(&id)
            .execute(db)
            .await?;
        }
        (id, false)
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let resolved_color = color.clone().unwrap_or_else(|| pick_color(&name));
        sqlx::query(
            "INSERT INTO tags (id, name, color, context_snippet, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        )
        .bind(&id)
        .bind(&name)
        .bind(&resolved_color)
        .bind(&context_snippet)
        .bind(now)
        .execute(db)
        .await?;
        (id, true)
    };

    // Assign to the chat; no-op if it's already tagged.
    let res = sqlx::query(
        "INSERT OR IGNORE INTO chat_tags (chat_id, tag_id, context_enabled) VALUES (?1, ?2, 0)",
    )
    .bind(chat_id)
    .bind(&tag_id)
    .execute(db)
    .await?;
    let newly_assigned = res.rows_affected() > 0;

    let updated_existing = !created && has_updates;
    Ok(json!({
        "status": "ok",
        "tag": name,
        "created_new_tag": created,
        "updated_existing_tag": updated_existing,
        "newly_assigned": newly_assigned,
        "note": if newly_assigned { "Tag assigned to this chat." } else { "Chat was already tagged with this." },
    })
    .to_string())
}

/// Deterministic color from the tag name so the same tag always looks the same.
fn pick_color(seed: &str) -> String {
    const PALETTE: [&str; 12] = [
        "#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6",
        "#6366f1", "#8b5cf6", "#ec4899", "#f43f5e",
    ];
    let mut h: u32 = 5381;
    for b in seed.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u32);
    }
    PALETTE[(h as usize) % PALETTE.len()].to_string()
}
