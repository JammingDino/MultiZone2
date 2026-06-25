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
