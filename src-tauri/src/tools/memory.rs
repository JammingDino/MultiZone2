use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// Default per-scope entry cap when the user hasn't overridden it. The oldest
/// entries in a scope are trimmed once it exceeds this.
const DEFAULT_SCOPE_LIMIT: i64 = 50;

pub fn definitions() -> Vec<Tool> {
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "save_memory".into(),
                description:
                    "Call this when you learn a stable preference, decision, or piece of context \
                     worth recalling in later turns and future chats — not for transient details. \
                     One concise fact per entry. Pick the narrowest scope that fits."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "content": { "type": "string", "description": "The fact, as one sentence." },
                        "scope": {
                            "type": "string",
                            "enum": ["chat", "project", "global"],
                            "default": "chat",
                            "description": "'chat' = this conversation, 'project' = every chat in it (falls back to 'chat' when there is none), 'global' = everywhere."
                        }
                    },
                    "required": ["content"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "read_memory".into(),
                description:
                    "Relevant memories are already injected into your context each turn, so call \
                     this only when you need the full list or want to confirm what is stored."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "scope": {
                            "type": "string",
                            "enum": ["chat", "project", "global"],
                            "description": "Restrict to one scope. Omit for everything that applies here."
                        }
                    }
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "delete_memory".into(),
                description:
                    "Delete a memory entry by its id when it is stale or wrong. Use read_memory \
                     first to get the id."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "The id of the memory entry to delete."
                        }
                    },
                    "required": ["id"]
                }),
            },
        },
    ]
}

/// The project a chat belongs to, if any.
async fn chat_project_id(db: &SqlitePool, chat_id: &str) -> Option<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT project_id FROM chats WHERE id = ?1")
        .bind(chat_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten()
}

async fn scope_limit(db: &SqlitePool) -> i64 {
    // The frontend persists everything in the `app_settings` JSON blob; read the
    // `memoryScopeLimit` field from there so there's a single source of truth.
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?1")
        .bind("app_settings")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    raw.and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("memoryScopeLimit").and_then(|n| n.as_i64()))
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_SCOPE_LIMIT)
}

/// Resolve a requested scope string + chat into a concrete (scope, scope_id).
/// 'project' downgrades to 'chat' when the chat has no project.
async fn resolve_scope(
    db: &SqlitePool,
    chat_id: &str,
    requested: &str,
) -> (String, Option<String>) {
    match requested {
        "global" => ("global".to_string(), None),
        "project" => match chat_project_id(db, chat_id).await {
            Some(pid) => ("project".to_string(), Some(pid)),
            None => ("chat".to_string(), Some(chat_id.to_string())),
        },
        _ => ("chat".to_string(), Some(chat_id.to_string())),
    }
}

pub async fn save(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return Ok(json!({ "error": "save_memory requires non-empty content" }).to_string());
    }
    let requested = args.get("scope").and_then(|v| v.as_str()).unwrap_or("chat");
    let (scope, scope_id) = resolve_scope(db, chat_id, requested).await;

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO memories (id, scope, scope_id, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
    )
    .bind(&id)
    .bind(&scope)
    .bind(&scope_id)
    .bind(&content)
    .bind(now)
    .execute(db)
    .await?;

    // Enforce the soft per-scope cap: trim the oldest entries beyond the limit.
    let limit = scope_limit(db).await;
    let trimmed = sqlx::query(
        "DELETE FROM memories
         WHERE scope = ?1
           AND ((?2 IS NULL AND scope_id IS NULL) OR scope_id = ?2)
           AND id NOT IN (
             SELECT id FROM memories
             WHERE scope = ?1 AND ((?2 IS NULL AND scope_id IS NULL) OR scope_id = ?2)
             ORDER BY created_at DESC LIMIT ?3
           )",
    )
    .bind(&scope)
    .bind(&scope_id)
    .bind(limit)
    .execute(db)
    .await?
    .rows_affected();

    Ok(json!({
        "status": "ok",
        "id": id,
        "scope": scope,
        "trimmed_oldest": trimmed,
    })
    .to_string())
}

pub async fn read(args: &Value, db: &SqlitePool, chat_id: &str) -> AppResult<String> {
    let requested = args.get("scope").and_then(|v| v.as_str());
    let project_id = chat_project_id(db, chat_id).await;

    // Build the set of (scope, scope_id) pairs to include.
    let mut entries: Vec<Value> = Vec::new();
    let mut push_scope = |rows: Vec<(String, String, i64)>| {
        for (id, content, created_at) in rows {
            entries.push(json!({ "id": id, "content": content, "created_at": created_at }));
        }
    };

    let want = |s: &str| requested.is_none() || requested == Some(s);

    if want("global") {
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT id, content, created_at FROM memories WHERE scope = 'global' ORDER BY created_at",
        )
        .fetch_all(db)
        .await?;
        push_scope(rows);
    }
    if want("project") {
        if let Some(ref pid) = project_id {
            let rows: Vec<(String, String, i64)> = sqlx::query_as(
                "SELECT id, content, created_at FROM memories WHERE scope = 'project' AND scope_id = ?1 ORDER BY created_at",
            )
            .bind(pid)
            .fetch_all(db)
            .await?;
            push_scope(rows);
        }
    }
    if want("chat") {
        let rows: Vec<(String, String, i64)> = sqlx::query_as(
            "SELECT id, content, created_at FROM memories WHERE scope = 'chat' AND scope_id = ?1 ORDER BY created_at",
        )
        .bind(chat_id)
        .fetch_all(db)
        .await?;
        push_scope(rows);
    }

    Ok(json!({ "memories": entries, "count": entries.len() }).to_string())
}

pub async fn delete(args: &Value, db: &SqlitePool) -> AppResult<String> {
    let id = args.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return Ok(json!({ "error": "delete_memory requires an id" }).to_string());
    }
    let res = sqlx::query("DELETE FROM memories WHERE id = ?1")
        .bind(id)
        .execute(db)
        .await?;
    Ok(json!({ "status": "ok", "deleted": res.rows_affected() }).to_string())
}

/// Build the memory block injected into the system prompt for a chat: global
/// notes first, then the chat's project, then the chat itself. Returns `None`
/// when there are no applicable memories.
pub async fn build_memory_block(db: &SqlitePool, chat_id: &str) -> AppResult<Option<String>> {
    let project_id = chat_project_id(db, chat_id).await;

    let global: Vec<String> =
        sqlx::query_scalar("SELECT content FROM memories WHERE scope = 'global' ORDER BY created_at")
            .fetch_all(db)
            .await
            .unwrap_or_default();
    let project: Vec<String> = if let Some(ref pid) = project_id {
        sqlx::query_scalar(
            "SELECT content FROM memories WHERE scope = 'project' AND scope_id = ?1 ORDER BY created_at",
        )
        .bind(pid)
        .fetch_all(db)
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    let chat: Vec<String> = sqlx::query_scalar(
        "SELECT content FROM memories WHERE scope = 'chat' AND scope_id = ?1 ORDER BY created_at",
    )
    .bind(chat_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();

    if global.is_empty() && project.is_empty() && chat.is_empty() {
        return Ok(None);
    }

    let mut out = String::from(
        "# Memory\nFacts you saved earlier with the memory tools. Treat them as background context.",
    );
    for line in global.iter().chain(project.iter()).chain(chat.iter()) {
        out.push_str("\n- ");
        out.push_str(line.trim());
    }
    Ok(Some(out))
}
