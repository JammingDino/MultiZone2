use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

fn image_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("bmp") => Some("image/bmp"),
        _ => None,
    }
}

pub fn definitions() -> Vec<Tool> {
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "read_file".into(),
                description:
                    "Read a file from disk. Relative paths resolve against the project's \
                     directory (if the chat belongs to a project with one set). Access is restricted \
                     to the project directory and the zone's allowed root paths.\n\n\
                     For text files, returns the content as a string (invalid bytes are replaced).\n\
                     For PDF files (.pdf), extracts and returns the text content from all pages.\n\
                     For image files (png, jpg, gif, webp, bmp), set `as_image: true` to load the \
                     image directly into the model's visual context."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path, or a path relative to the project directory."
                        },
                        "as_image": {
                            "type": "boolean",
                            "description": "Set to true to read the file as an image and inject it into the visual context. Supported formats: png, jpg/jpeg, gif, webp, bmp.",
                            "default": false
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "list_directory".into(),
                description:
                    "List a directory as a nested JSON object. Files appear as their extension \
                     string (e.g. \"rs\", \"toml\", \"\" for no extension); directories appear \
                     as nested objects. Relative paths resolve against the project directory; \
                     use \".\" for the project root."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute path, or a path relative to the project directory. Use \".\" for the project root."
                        },
                        "depth": {
                            "type": "integer",
                            "description": "How many directory levels to recurse. 1 = immediate children only (default), 2 = two levels, etc. A directory that is genuinely empty appears as {}; one whose contents weren't expanded because it sits at the depth limit appears as {\"…\": true} so the two are distinguishable.",
                            "default": 1
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "create_file".into(),
                description:
                    "Create a new file (or overwrite an existing one) with the given content. \
                     Parent directories are created automatically. \
                     Relative paths resolve against the project directory. \
                     Access is restricted to the project directory and allowed roots."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file to create or overwrite."
                        },
                        "content": {
                            "type": "string",
                            "description": "Full text content to write to the file."
                        }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "edit_file".into(),
                description:
                    "Edit a file by replacing an exact block of text with new text (like a targeted diff). \
                     `old_text` must match exactly (including whitespace/newlines). \
                     If `old_text` appears more than once, only the first occurrence is replaced. \
                     Use `read_file` first to get the current content before editing. \
                     Relative paths resolve against the project directory."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Path to the file to edit."
                        },
                        "old_text": {
                            "type": "string",
                            "description": "The exact text to find and replace (must match the file content exactly)."
                        },
                        "new_text": {
                            "type": "string",
                            "description": "The text to replace it with."
                        }
                    },
                    "required": ["path", "old_text", "new_text"]
                }),
            },
        },
    ]
}

/// Definition for the standalone `present_file` tool. Kept separate from the
/// read/write/edit `file_system` group so a presentation-focused zone (e.g. the
/// HTML report writer) can offer file presentation without full filesystem
/// access.
pub fn present_file_definitions() -> Vec<Tool> {
    vec![Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "present_file".into(),
            description:
                "Present a file that already exists on disk to the user, inline in the chat. \
                 Pair this with create_file / edit_file / read_file: produce or edit the file in one \
                 call, then present it in another — no need to repeat its contents in the chat. \
                 HTML files (.html) render as a live preview with an \"open in browser\" button; other \
                 files show a card that opens them in their default app. Relative paths resolve against \
                 the working directory."
                    .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Path to the existing file. Absolute, or relative to the working directory."
                    },
                    "format": {
                        "type": "string",
                        "enum": ["html", "md", "csv", "json", "txt"],
                        "description": "Optional. Overrides how the file is presented; inferred from the file extension when omitted."
                    }
                },
                "required": ["path"]
            }),
        },
    }]
}

/// Zone config:
/// {
///   "file_system": {
///     "allowed_roots": ["C:\\Users\\me\\project"]
///   }
/// }
fn allowed_roots(zone_config: &Value, project_dir: Option<&str>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = zone_config
        .get("file_system")
        .and_then(|v| v.get("allowed_roots"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(PathBuf::from))
                .collect()
        })
        .unwrap_or_default();
    if let Some(dir) = project_dir {
        if !dir.trim().is_empty() {
            roots.push(PathBuf::from(dir));
        }
    }
    roots
}

fn resolve_path(path: &str, project_dir: Option<&str>) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        return p;
    }
    match project_dir {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir).join(p),
        _ => p,
    }
}

fn is_within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    // For paths that don't exist yet (create_file), canonicalize will fail.
    // Walk up to the first existing ancestor and check that.
    let canon = path
        .canonicalize()
        .or_else(|_| {
            // Try parent chain
            let mut cur = path.to_path_buf();
            loop {
                if let Some(p) = cur.parent() {
                    cur = p.to_path_buf();
                    if let Ok(c) = cur.canonicalize() {
                        // Reconstruct the full intended path under the canonical parent
                        let suffix = path.strip_prefix(&cur).unwrap_or(path);
                        return Ok(c.join(suffix));
                    }
                } else {
                    break;
                }
            }
            Err(std::io::Error::new(std::io::ErrorKind::NotFound, "not found"))
        })
        .unwrap_or_else(|_| path.to_path_buf());

    roots.iter().any(|r| {
        r.canonicalize()
            .map(|cr| canon.starts_with(cr))
            .unwrap_or(false)
    })
}

/// Read bytes from a file and decode as UTF-8, stripping BOM and replacing
/// any invalid sequences with the replacement character (U+FFFD). This handles
/// Windows files that may use a UTF-8 BOM or have occasional non-UTF-8 bytes.
fn bytes_to_string(mut bytes: Vec<u8>) -> String {
    // Strip UTF-8 BOM (0xEF 0xBB 0xBF)
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        bytes.drain(..3);
    }
    match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

pub async fn read_file(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let as_image = args.get("as_image").and_then(|v| v.as_bool()).unwrap_or(false);
    let roots = allowed_roots(zone_config, project_dir);
    if roots.is_empty() {
        return Ok(json!({ "error": "no project directory or allowed_roots configured for file_system tool" }).to_string());
    }
    let p = resolve_path(path, project_dir);
    if !is_within_roots(&p, &roots) {
        return Ok(json!({ "error": "path is outside the project directory and allowed_roots" }).to_string());
    }

    if as_image {
        let mime = match image_mime(&p) {
            Some(m) => m,
            None => {
                return Ok(json!({
                    "error": "as_image requires a recognized image file (png, jpg/jpeg, gif, webp, bmp)"
                })
                .to_string());
            }
        };
        let bytes = match tokio::fs::read(&p).await {
            Ok(b) => b,
            Err(e) => return Ok(json!({ "error": e.to_string() }).to_string()),
        };
        if bytes.len() > MAX_IMAGE_BYTES {
            return Ok(json!({
                "error": format!(
                    "Image is too large ({} MB); maximum is 20 MB",
                    bytes.len() / 1024 / 1024
                )
            })
            .to_string());
        }
        let b64 = STANDARD.encode(&bytes);
        let data_url = format!("data:{};base64,{}", mime, b64);
        return Ok(serde_json::to_string(&json!([
            { "type": "text", "text": format!("Image file: {}", p.to_string_lossy()) },
            { "type": "image_url", "image_url": { "url": data_url } }
        ]))
        .unwrap_or_else(|_| json!({ "error": "serialization failed" }).to_string()));
    }

    let is_pdf = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);

    if is_pdf {
        let bytes = match tokio::fs::read(&p).await {
            Ok(b) => b,
            Err(e) => return Ok(json!({ "error": e.to_string() }).to_string()),
        };
        let path_str = p.to_string_lossy().to_string();
        let result = tokio::task::spawn_blocking(move || {
            pdf_extract::extract_text_from_mem(&bytes)
        })
        .await;
        return match result {
            Ok(Ok(text)) => Ok(json!({
                "ref": 1,
                "path": path_str,
                "source": path_str,
                "content": text,
                "citation_instructions": READ_FILE_CITATION,
            })
            .to_string()),
            Ok(Err(e)) => Ok(json!({ "error": format!("PDF text extraction failed: {e}") }).to_string()),
            Err(e) => Ok(json!({ "error": format!("task join error: {e}") }).to_string()),
        };
    }

    match tokio::fs::read(&p).await {
        Ok(bytes) => {
            let path_str = p.to_string_lossy().to_string();
            Ok(json!({
                "ref": 1,
                "path": path_str,
                "source": path_str,
                "content": bytes_to_string(bytes),
                "citation_instructions": READ_FILE_CITATION,
            })
            .to_string())
        }
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}

/// Nudge the model to cite a file it draws on, mirroring web_search /
/// search_knowledge so reads surface in the Sources list.
const READ_FILE_CITATION: &str =
    "If you use information from this file in your answer, cite it inline with [1] \
     immediately after the claim.";

pub async fn list_directory(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let max_depth = args.get("depth").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let roots = allowed_roots(zone_config, project_dir);
    if roots.is_empty() {
        return Ok(json!({ "error": "no project directory or allowed_roots configured for file_system tool" }).to_string());
    }
    let p = resolve_path(path, project_dir);
    if !is_within_roots(&p, &roots) {
        return Ok(json!({ "error": "path is outside the project directory and allowed_roots" }).to_string());
    }
    match dir_tree(&p, 0, max_depth, &roots).await {
        Ok(tree) => Ok(tree.to_string()),
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}

/// Does a directory contain at least one entry? Used at the depth limit to tell
/// a truly-empty directory apart from one whose contents simply weren't expanded.
/// Errors (e.g. permission denied) are treated as "unknown" → reported empty.
async fn has_entries(path: &std::path::Path) -> bool {
    match tokio::fs::read_dir(path).await {
        Ok(mut rd) => matches!(rd.next_entry().await, Ok(Some(_))),
        Err(_) => false,
    }
}

/// Recursively build a nested JSON object representing a directory tree.
/// Files are represented as their extension string; directories as nested objects.
/// A directory at the depth limit is `{}` when empty, or `{"…": true}` when it
/// has children that weren't expanded — so the two cases are distinguishable.
fn dir_tree<'a>(
    path: &'a std::path::Path,
    depth: usize,
    max_depth: usize,
    roots: &'a [std::path::PathBuf],
) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<Value>> + Send + 'a>> {
    Box::pin(async move {
        let mut rd = tokio::fs::read_dir(path).await?;
        let mut dirs: Vec<String> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
                dirs.push(name);
            } else {
                files.push(name);
            }
        }
        dirs.sort();
        files.sort();

        let mut map = serde_json::Map::new();
        for name in dirs {
            let child = path.join(&name);
            let subtree = if depth < max_depth && is_within_roots(&child, roots) {
                dir_tree(&child, depth + 1, max_depth, roots).await.unwrap_or_else(|_| Value::Object(Default::default()))
            } else {
                // At the depth limit (or outside the allowed roots) we don't
                // recurse — but still probe so a non-empty folder reads as
                // {"…": true} rather than looking identical to an empty one.
                let mut placeholder = serde_json::Map::new();
                if has_entries(&child).await {
                    placeholder.insert("…".to_string(), Value::Bool(true));
                }
                Value::Object(placeholder)
            };
            map.insert(name, subtree);
        }
        for name in files {
            let ext = std::path::Path::new(&name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_string();
            map.insert(name, Value::String(ext));
        }
        Ok(Value::Object(map))
    })
}

pub async fn create_file(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let roots = allowed_roots(zone_config, project_dir);
    if roots.is_empty() {
        return Ok(json!({ "error": "no project directory or allowed_roots configured for file_system tool" }).to_string());
    }
    let p = resolve_path(path, project_dir);
    if !is_within_roots(&p, &roots) {
        return Ok(json!({ "error": "path is outside the project directory and allowed_roots" }).to_string());
    }
    // Create parent directories if needed
    if let Some(parent) = p.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return Ok(json!({ "error": format!("failed to create parent directories: {e}") }).to_string());
        }
    }
    match tokio::fs::write(&p, content.as_bytes()).await {
        Ok(_) => Ok(json!({
            "path": p.to_string_lossy(),
            "bytes_written": content.len(),
            "ok": true
        })
        .to_string()),
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}

/// `present_file` — surface an already-existing file inline in the chat without
/// (re)writing it. Read-only: the model produces or edits the file with another
/// tool, then presents it here. Relative paths resolve against the working
/// directory; format is taken from the extension unless overridden.
pub async fn present_file(args: &Value, project_dir: Option<&str>) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
    if path.is_empty() {
        return Ok(json!({ "error": "present_file requires a 'path'" }).to_string());
    }

    let p = resolve_path(path, project_dir);
    if !p.is_file() {
        return Ok(json!({
            "error": format!("file does not exist: {}", p.to_string_lossy())
        })
        .to_string());
    }

    // Format: explicit override, else inferred from the extension. Normalize the
    // html alias so the frontend keys on a single value.
    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_lowercase())
                .unwrap_or_default()
        });
    let format = if format == "htm" { "html".to_string() } else { format };

    Ok(json!({
        "rendered": "present_file",
        "ok": true,
        "path": p.to_string_lossy(),
        "filename": p.file_name().map(|f| f.to_string_lossy().to_string()),
        "format": format,
    })
    .to_string())
}

pub async fn edit_file(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let old_text = args.get("old_text").and_then(|v| v.as_str()).unwrap_or("");
    let new_text = args.get("new_text").and_then(|v| v.as_str()).unwrap_or("");
    let roots = allowed_roots(zone_config, project_dir);
    if roots.is_empty() {
        return Ok(json!({ "error": "no project directory or allowed_roots configured for file_system tool" }).to_string());
    }
    let p = resolve_path(path, project_dir);
    if !is_within_roots(&p, &roots) {
        return Ok(json!({ "error": "path is outside the project directory and allowed_roots" }).to_string());
    }
    let bytes = match tokio::fs::read(&p).await {
        Ok(b) => b,
        Err(e) => return Ok(json!({ "error": format!("failed to read file: {e}") }).to_string()),
    };
    let current = bytes_to_string(bytes);
    if !current.contains(old_text) {
        return Ok(json!({
            "error": "old_text not found in file — use read_file to get the current content before editing"
        })
        .to_string());
    }
    let updated = current.replacen(old_text, new_text, 1);
    match tokio::fs::write(&p, updated.as_bytes()).await {
        Ok(_) => Ok(json!({
            "path": p.to_string_lossy(),
            "ok": true
        })
        .to_string()),
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}
