use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Max raw image size we'll base64-encode into the model's context.
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
                     For text files, returns the UTF-8 content as a string.\n\
                     For image files (png, jpg, gif, webp, bmp), set `as_image: true` to load the \
                     image directly into the model's visual context — the image will be sent as an \
                     inline vision attachment so you can describe, analyze, or reason about it."
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
                            "description": "Set to true to read the file as an image and inject it into the visual context. Supported formats: png, jpg/jpeg, gif, webp, bmp. Ignored for text files.",
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
                     directory (if set); use \".\" to list the project root. Access is restricted to \
                     the project directory and the zone's allowed root paths."
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
    // The project directory is always an allowed root when set.
    if let Some(dir) = project_dir {
        if !dir.trim().is_empty() {
            roots.push(PathBuf::from(dir));
        }
    }
    roots
}

/// Resolve a tool-supplied path. Relative paths are joined onto the project
/// directory (when set); absolute paths are used as-is.
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
    let canon = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    roots.iter().any(|r| {
        r.canonicalize()
            .map(|cr| canon.starts_with(cr))
            .unwrap_or(false)
    })
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
        // Return a content-parts array so the agentic loop can forward
        // the image directly into the model's visual context.
        return Ok(serde_json::to_string(&json!([
            { "type": "text", "text": format!("Image file: {}", p.to_string_lossy()) },
            { "type": "image_url", "image_url": { "url": data_url } }
        ]))
        .unwrap_or_else(|_| json!({ "error": "serialization failed" }).to_string()));
    }

    match tokio::fs::read_to_string(&p).await {
        Ok(content) => Ok(json!({
            "path": p.to_string_lossy(),
            "content": content,
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
