use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};
use sqlx::SqlitePool;

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "load_skill".into(),
            description:
                "Load the full instructions for one of the available skills. Skills are \
                 specialized, reusable instruction sets (e.g. a design guide or an output \
                 format). The names and descriptions of the skills available to you are listed \
                 in the system prompt under \"Skills\". When a user's request matches a skill's \
                 described use case, call this tool with that skill's name BEFORE doing the work, \
                 then follow the returned instructions. Call with no name (or an unknown name) to \
                 get the catalog of available skills. If there are any relevant skills, look at them before responding"
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The exact name of the skill to load, as listed in the Skills section of the system prompt."
                    }
                }
            }),
        },
    }
}

/// Definitions for the authoring half of the skills group (0.9.2): the agent can
/// write a new skill from a procedure it just worked out, and refine one later.
///
/// Guarded on three sides: a new skill is created **disabled** (it enters no
/// catalog until the user enables it in Settings → Skills), it is stamped with
/// the authoring zone, and `update_skill` is moderate-safety so rewriting an
/// existing instruction set goes through the approval gate.
pub fn authoring_definitions() -> Vec<Tool> {
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "create_skill".into(),
                description:
                    "Save a reusable procedure as a new skill, so that you (and other zones) can \
                     load it in future conversations. Use this when you have worked out a method \
                     that is worth keeping — a repeatable process, a format the user prefers, a \
                     set of project conventions. Skills capture *how to do something*; use \
                     `save_memory` for individual facts instead.\n\n\
                     Write `instructions` as if for someone doing the task from scratch, and write \
                     `description` as the situation that should trigger the skill (e.g. \"When \
                     writing a release note for this repo\") — that description is all a future \
                     agent sees when deciding whether to load it.\n\n\
                     The new skill is saved disabled and shown to the user for review; it becomes \
                     available once they enable it. Do not use this to store one-off details."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Short, distinctive name, e.g. \"release-notes\"."
                        },
                        "description": {
                            "type": "string",
                            "description": "The use case that should trigger this skill, phrased as a situation."
                        },
                        "instructions": {
                            "type": "string",
                            "description": "The full instructions, in markdown. Self-contained — assume the reader has no memory of this conversation."
                        }
                    },
                    "required": ["name", "description", "instructions"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "update_skill".into(),
                description:
                    "Revise an existing skill's instructions — for example after finding that a \
                     step was wrong or incomplete. Pass the skill's exact name. The user is asked \
                     to approve the change. Rewrites the instructions wholesale, so include the \
                     full new text, not just the change."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Exact name of the skill to revise." },
                        "instructions": { "type": "string", "description": "The complete new instructions, in markdown." },
                        "description": { "type": "string", "description": "Optional. A replacement trigger description." }
                    },
                    "required": ["name", "instructions"]
                }),
            },
        },
    ]
}

/// Per-turn cap on skill writes. A model that decides everything is worth
/// keeping would otherwise flood the review queue.
const MAX_SKILLS_PER_CHAT: i64 = 20;

/// `create_skill` — the agent writes a new skill. Created **disabled** and
/// stamped with the authoring zone, so nothing an agent writes can affect any
/// other agent's behaviour until the user has seen it and turned it on.
pub async fn create(
    args: &Value,
    db: &SqlitePool,
    caller_zone_id: Option<&str>,
) -> AppResult<String> {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    let description = args.get("description").and_then(|v| v.as_str()).unwrap_or("").trim();
    let instructions = args
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();

    if name.is_empty() || instructions.is_empty() {
        return Ok(json!({
            "error": "create_skill needs a 'name' and 'instructions'"
        })
        .to_string());
    }

    // Duplicate name → tell the model to revise instead of creating a second one.
    let existing: Option<String> =
        sqlx::query_scalar("SELECT name FROM skills WHERE lower(name) = lower(?1) LIMIT 1")
            .bind(name)
            .fetch_optional(db)
            .await?;
    if let Some(existing) = existing {
        return Ok(json!({
            "status": "exists",
            "note": format!(
                "A skill named \"{existing}\" already exists. Call `update_skill` with that name \
                 to revise it, or choose a different name."
            ),
        })
        .to_string());
    }

    let authored: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM skills WHERE authored_by_zone_id IS NOT NULL AND enabled = 0",
    )
    .fetch_one(db)
    .await
    .unwrap_or(0);
    if authored >= MAX_SKILLS_PER_CHAT {
        return Ok(json!({
            "error": format!(
                "There are already {authored} self-authored skills awaiting the user's review. \
                 Not creating another until they are reviewed."
            )
        })
        .to_string());
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO skills (id, name, description, content, enabled, authored_by_zone_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6)",
    )
    .bind(&id)
    .bind(name)
    .bind(description)
    .bind(instructions)
    .bind(caller_zone_id)
    .bind(now)
    .execute(db)
    .await?;

    Ok(json!({
        "status": "created",
        "id": id,
        "name": name,
        "enabled": false,
        "note": "Saved as a draft skill. It is disabled until the user reviews and enables it in \
                 Settings → Skills, so it is not yet available to load. Tell the user you saved it.",
    })
    .to_string())
}

/// `update_skill` — revise an existing skill's instructions. Moderate safety, so
/// the user approves before an agent rewrites a set of instructions it (or they)
/// rely on. Enabled state is left untouched.
pub async fn update(args: &Value, db: &SqlitePool) -> AppResult<String> {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    let instructions = args
        .get("instructions")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if name.is_empty() || instructions.is_empty() {
        return Ok(json!({ "error": "update_skill needs a 'name' and the full new 'instructions'" }).to_string());
    }

    let row: Option<(String, Option<String>)> =
        sqlx::query_as("SELECT id, description FROM skills WHERE lower(name) = lower(?1) LIMIT 1")
            .bind(name)
            .fetch_optional(db)
            .await?;
    let (id, current_description) = match row {
        Some(r) => r,
        None => {
            return Ok(json!({
                "error": format!("No skill named \"{name}\". Use `create_skill` to add it, or `load_skill` with no name to see what exists.")
            })
            .to_string())
        }
    };

    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or(current_description);

    sqlx::query("UPDATE skills SET content = ?1, description = ?2, updated_at = ?3 WHERE id = ?4")
        .bind(instructions)
        .bind(&description)
        .bind(chrono::Utc::now().timestamp())
        .bind(&id)
        .execute(db)
        .await?;

    Ok(json!({ "status": "updated", "id": id, "name": name }).to_string())
}

/// Load a skill's full content by name (case-insensitive), or return the catalog
/// of available skills when the name is missing or unrecognized.
pub async fn run(args: &Value, db: &SqlitePool) -> AppResult<String> {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();

    if !name.is_empty() {
        let row: Option<(String, Option<String>, String)> = sqlx::query_as(
            "SELECT name, description, content FROM skills
             WHERE enabled = 1 AND lower(name) = lower(?1) LIMIT 1",
        )
        .bind(name)
        .fetch_optional(db)
        .await?;
        if let Some((skill_name, description, content)) = row {
            return Ok(json!({
                "status": "loaded",
                "name": skill_name,
                "description": description,
                "instructions": content,
            })
            .to_string());
        }
    }

    // No name, or no match — return the catalog so the model can pick one.
    let catalog: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT name, description FROM skills WHERE enabled = 1 ORDER BY name",
    )
    .fetch_all(db)
    .await?;
    let available: Vec<Value> = catalog
        .into_iter()
        .map(|(n, d)| json!({ "name": n, "description": d }))
        .collect();
    let note = if name.is_empty() {
        "No skill name given — here are the available skills."
    } else {
        "No skill by that name. Here are the available skills."
    };
    Ok(json!({ "status": "catalog", "note": note, "available_skills": available }).to_string())
}

/// Build the "Skills" catalog block injected into the system prompt: one line per
/// enabled skill (name + description) plus instructions on how to load one.
/// Returns `None` when there are no enabled skills.
pub async fn build_catalog(db: &SqlitePool) -> AppResult<Option<String>> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT name, description FROM skills WHERE enabled = 1 ORDER BY name",
    )
    .fetch_all(db)
    .await
    .unwrap_or_default();
    if rows.is_empty() {
        return Ok(None);
    }
    let mut out = String::from(
        "# Skills\nThese are specialized instruction sets you can load on demand. When a \
         request matches one of the use cases below, call the `load_skill` tool with the \
         skill's name to get its full instructions, then follow them.\n",
    );
    for (name, description) in rows {
        out.push_str("\n- **");
        out.push_str(&name);
        out.push_str("**");
        if let Some(d) = description.filter(|d| !d.trim().is_empty()) {
            out.push_str(" — ");
            out.push_str(d.trim());
        }
    }
    Ok(Some(out))
}
