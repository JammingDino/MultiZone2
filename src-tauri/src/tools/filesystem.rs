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
                    "List entries in a directory. Relative paths resolve against the project's \
                     directory (if set); use \".\" to list the project root."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Absolute path, or a path relative to the project directory. Use \".\" for the project root." }
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

    match tokio::fs::read(&p).await {
        Ok(bytes) => Ok(json!({
            "path": p.to_string_lossy(),
            "content": bytes_to_string(bytes),
        })
        .to_string()),
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}

pub async fn list_directory(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let roots = allowed_roots(zone_config, project_dir);
    if roots.is_empty() {
        return Ok(json!({ "error": "no project directory or allowed_roots configured for file_system tool" }).to_string());
    }
    let p = resolve_path(path, project_dir);
    if !is_within_roots(&p, &roots) {
        return Ok(json!({ "error": "path is outside the project directory and allowed_roots" }).to_string());
    }

    let mut entries = Vec::new();
    let mut rd = match tokio::fs::read_dir(&p).await {
        Ok(rd) => rd,
        Err(e) => return Ok(json!({ "error": e.to_string() }).to_string()),
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false);
        entries.push(json!({ "name": name, "is_dir": is_dir }));
    }
    Ok(json!({ "path": p.to_string_lossy(), "entries": entries }).to_string())
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
