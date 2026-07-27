use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::skillpacks;
use serde_json::{json, Value};
use sqlx::SqlitePool;
use std::path::Path;

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
                 get the catalog of available skills. If there are any relevant skills, look at them before responding.\n\n\
                 Some skills are folders of several files: loading one returns a `files` list \
                 alongside its instructions. Read any of those with a second call passing the same \
                 `name` plus `file` — that is how a skill's own instructions tell you to open its \
                 reference pages. Do not guess at a file's contents; load it."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The exact name of the skill to load, as listed in the Skills section of the system prompt."
                    },
                    "file": {
                        "type": "string",
                        "description": "Optional. Path of one file inside a multi-file skill, relative to the skill's folder (e.g. \"reference/polish.md\"). Only valid together with `name`. Paths written the long way in a skill's own text (e.g. \".claude/skills/impeccable/reference/polish.md\") are accepted too."
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

    // A DB skill wins name lookups, so letting one take an installed pack's name
    // would quietly make that pack unloadable.
    if let Some(pack) = skillpacks::find_enabled(db, name).await {
        return Ok(json!({
            "status": "exists",
            "note": format!(
                "An installed skill folder is already named \"{}\". Pick a different name — a skill \
                 saved under that name would shadow it.",
                pack.name
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

/// How a folder-backed skill tells the model to navigate its own tree. Returned
/// with the load because these skills are written for harnesses that read their
/// sub-files off disk — without this the model follows an instruction like
/// "see reference/polish.md" by inventing the contents.
const PACK_NOTE: &str = "This skill is a folder of files. Its instructions refer to other files in \
     that folder — read each one by calling `load_skill` again with this same `name` and the \
     `file` path, at the point the instructions call for it (not all up front). Paths written \
     against another tool's layout (e.g. `.claude/skills/<skill>/reference/x.md`) work as-is. \
     `base_dir` is the folder's real location on disk: if you have `run_command` or \
     `execute_code`, run any scripts the instructions mention from there; if you do not, say so \
     rather than pretending a step ran.";

/// Load a skill's full content by name (case-insensitive), or return the catalog
/// of available skills when the name is missing or unrecognized.
///
/// Two sources, in this order: skills the user wrote here (DB rows), then
/// folder-backed packs installed on disk (see [`crate::skillpacks`]). A DB skill
/// wins a name collision — it is the one the user can actually see and edit.
pub async fn run(args: &Value, db: &SqlitePool) -> AppResult<String> {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    let file = args.get("file").and_then(|v| v.as_str()).unwrap_or("").trim();

    if !name.is_empty() {
        // A `file` request only makes sense against a pack, so skip the DB row
        // (a single-blob skill has no files to read).
        if file.is_empty() {
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

        if let Some(pack) = skillpacks::find_enabled(db, name).await {
            let dir = Path::new(&pack.dir);

            if !file.is_empty() {
                return Ok(match skillpacks::read_file(dir, file) {
                    Ok(content) => json!({
                        "status": "file",
                        "name": pack.name,
                        "file": file,
                        "content": content,
                    }),
                    Err(e) => json!({
                        "error": e.to_string(),
                        "name": pack.name,
                        "available_files": skillpacks::list_files(dir),
                    }),
                }
                .to_string());
            }

            return Ok(json!({
                "status": "loaded",
                "name": pack.name,
                "description": pack.description,
                "instructions": skillpacks::instructions(dir)?,
                "base_dir": pack.dir,
                "files": skillpacks::list_files(dir),
                "note": PACK_NOTE,
            })
            .to_string());
        }

        if !file.is_empty() {
            return Ok(json!({
                "error": format!("No multi-file skill named \"{name}\" is installed, so there is no file to read."),
            })
            .to_string());
        }
    }

    // No name, or no match — return the catalog so the model can pick one.
    let available: Vec<Value> = catalog_entries(db)
        .await
        .into_iter()
        .map(|(n, d, multi_file)| json!({ "name": n, "description": d, "multi_file": multi_file }))
        .collect();
    let note = if name.is_empty() {
        "No skill name given — here are the available skills."
    } else {
        "No skill by that name. Here are the available skills."
    };
    Ok(json!({ "status": "catalog", "note": note, "available_skills": available }).to_string())
}

/// Every skill offered to agents: DB rows first, then folder packs whose name
/// isn't already taken. The third element marks a skill that has more files to
/// read past its entry instructions.
async fn catalog_entries(db: &SqlitePool) -> Vec<(String, String, bool)> {
    let rows: Vec<(String, Option<String>)> =
        sqlx::query_as("SELECT name, description FROM skills WHERE enabled = 1 ORDER BY name")
            .fetch_all(db)
            .await
            .unwrap_or_default();
    let mut out: Vec<(String, String, bool)> = rows
        .into_iter()
        .map(|(n, d)| (n, d.unwrap_or_default(), false))
        .collect();

    for pack in skillpacks::discover(db).await {
        if !pack.enabled || out.iter().any(|(n, _, _)| n.eq_ignore_ascii_case(&pack.name)) {
            continue;
        }
        out.push((pack.name, pack.description, pack.multi_file));
    }
    out
}

/// Build the "Skills" catalog block injected into the system prompt: one line per
/// enabled skill (name + description) plus instructions on how to load one.
/// Returns `None` when there are no enabled skills.
pub async fn build_catalog(db: &SqlitePool) -> AppResult<Option<String>> {
    let rows = catalog_entries(db).await;
    if rows.is_empty() {
        return Ok(None);
    }
    let mut out = String::from(
        "# Skills\nThese are specialized instruction sets you can load on demand. When a \
         request matches one of the use cases below, call the `load_skill` tool with the \
         skill's name to get its full instructions, then follow them.\n",
    );
    for (name, description, multi_file) in rows {
        out.push_str("\n- **");
        out.push_str(&name);
        out.push_str("**");
        if !description.trim().is_empty() {
            out.push_str(" — ");
            out.push_str(description.trim());
        }
        // Flag the multi-file ones so the model expects to keep reading rather
        // than treating the first load as the whole skill.
        if multi_file {
            out.push_str(
                " _(a multi-file skill — loading it returns a list of further files to read as its instructions direct)_",
            );
        }
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::path::PathBuf;

    /// A DB with the real schema, plus a temp folder registered as the managed
    /// skills root and one pack installed into it in the `.claude` layout an
    /// installer would produce.
    async fn fixture() -> (SqlitePool, PathBuf) {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();

        let root = std::env::temp_dir().join(format!(
            "mz-load-skill-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let pack = root.join(".claude/skills/impeccable");
        std::fs::create_dir_all(pack.join("reference")).unwrap();
        std::fs::write(
            pack.join("SKILL.md"),
            "---\nname: impeccable\ndescription: Design help.\n---\n\nRead .claude/skills/impeccable/reference/polish.md\n",
        )
        .unwrap();
        std::fs::write(pack.join("reference/polish.md"), "the polish pass").unwrap();

        // The folder is reachable as a user-added root, so this test does not
        // depend on the process-wide managed root.
        write_settings(&pool, &root, &[]).await;
        (pool, root)
    }

    /// Persist the app_settings blob the way the frontend does, with `root`
    /// registered as an extra scanned folder.
    async fn write_settings(pool: &SqlitePool, root: &Path, disabled: &[&str]) {
        let value = json!({
            "skillPackDirs": [root.to_string_lossy()],
            "disabledSkillPacks": disabled,
        })
        .to_string();
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES ('app_settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn catalog_and_prompt_list_installed_packs() {
        let (db, root) = fixture().await;

        let catalog: Value = serde_json::from_str(&run(&json!({}), &db).await.unwrap()).unwrap();
        let names: Vec<&str> = catalog["available_skills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"impeccable"), "{names:?}");

        let prompt = build_catalog(&db).await.unwrap().unwrap();
        assert!(prompt.contains("**impeccable**"), "{prompt}");
        assert!(prompt.contains("Design help."), "{prompt}");
        assert!(prompt.contains("multi-file skill"), "{prompt}");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn loads_a_pack_and_then_one_of_its_files() {
        let (db, root) = fixture().await;

        let loaded: Value =
            serde_json::from_str(&run(&json!({ "name": "impeccable" }), &db).await.unwrap()).unwrap();
        assert_eq!(loaded["status"], "loaded");
        // Frontmatter is stripped; the body survives.
        assert!(loaded["instructions"].as_str().unwrap().contains("Read .claude"));
        assert!(!loaded["instructions"].as_str().unwrap().contains("name: impeccable"));
        assert!(loaded["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "reference/polish.md"));

        // The follow-up call the instructions provoke, using the long path form
        // the SKILL.md itself writes.
        let file: Value = serde_json::from_str(
            &run(
                &json!({ "name": "impeccable", "file": ".claude/skills/impeccable/reference/polish.md" }),
                &db,
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(file["status"], "file");
        assert_eq!(file["content"], "the polish pass");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_disabled_pack_is_not_offered_or_loadable() {
        let (db, root) = fixture().await;
        write_settings(&db, &root, &["impeccable"]).await;

        assert!(build_catalog(&db).await.unwrap().is_none());
        let res: Value =
            serde_json::from_str(&run(&json!({ "name": "impeccable" }), &db).await.unwrap()).unwrap();
        assert_eq!(res["status"], "catalog", "a disabled pack must not load");

        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn a_missing_file_reports_what_is_available() {
        let (db, root) = fixture().await;
        let res: Value = serde_json::from_str(
            &run(&json!({ "name": "impeccable", "file": "reference/nope.md" }), &db)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(res["error"].is_string());
        assert!(res["available_files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "reference/polish.md"));

        let _ = std::fs::remove_dir_all(root);
    }
}
