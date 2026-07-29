use crate::commands::messages::StreamSink;
use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
/// A PDF travels to the frontend renderer base64-encoded over the IPC boundary,
/// so the ceiling is about what that costs rather than what a page image costs.
const MAX_PDF_BYTES: usize = 50 * 1024 * 1024;

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

/// The read/write `file_system` group. Takes the chat's working directory so the
/// path hint can name it and show a path that actually resolves — a tool whose
/// `path` argument is described only in the abstract gets the argument wrong,
/// and the model has no other way to learn the right shape.
///
/// The hint appears **once per tool**, at the end of the description (0.9.10).
/// It used to be repeated inside each `path` parameter as well, so the same ~70
/// tokens shipped twice per tool and ~19 times across the four file groups —
/// roughly 1.3k tokens of pure duplication on every request from a zone with
/// file access, before the model had read a single word of the conversation.
pub fn definitions(project_dir: Option<&str>) -> Vec<Tool> {
    let hint = path_syntax_hint(project_dir);
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "read_file".into(),
                description: format!(
                    "Read a file. Use before editing, and whenever the answer depends on what a \
                     file actually contains. Text is returned as a string; set `as_image` for an \
                     image file to put it in your visual context. A `.pdf` is returned as page \
                     images (so you see tables, figures and scans) — page 1 plus the document's \
                     page count unless you ask for more via `pages`.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "as_image": {
                            "type": "boolean",
                            "description": "Read png/jpg/gif/webp/bmp as an image instead of text.",
                            "default": false
                        },
                        "pages": {
                            "type": "string",
                            "description": "PDF pages to read: \"3\", \"1-4,9\", or \"all\" (capped at 30 per call).",
                            "default": "1"
                        },
                        "as_text": {
                            "type": "boolean",
                            "description": "Extract a PDF's text instead of rendering pages. Cheaper for long text-only documents; loses layout, figures and scans.",
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
                description: format!(
                    "List a directory when you need to know what is there before acting. Returns \
                     nested JSON: a file is its extension string (\"rs\", \"\" for none), a \
                     directory is an object. Pass \".\" for the working directory.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "depth": {
                            "type": "integer",
                            "description": "Levels to recurse (1 = immediate children). An empty directory is {}; one left unexpanded at the depth limit is {\"…\": true}.",
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
                description: format!(
                    "Write a whole file, creating it or overwriting it. Use for new files; use \
                     `edit_file` to change part of an existing one. Missing parent directories \
                     are created.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "content": { "type": "string", "description": "Full text to write." }
                    },
                    "required": ["path", "content"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "edit_file".into(),
                description: format!(
                    "Change part of an existing file by replacing an exact block of text. Read the \
                     file first — `old_text` must match byte for byte, whitespace included, and \
                     only its first occurrence is replaced.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "old_text": { "type": "string", "description": "Exact text to replace." },
                        "new_text": { "type": "string", "description": "Text to replace it with." }
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
pub fn present_file_definitions(project_dir: Option<&str>) -> Vec<Tool> {
    let hint = path_syntax_hint(project_dir);
    vec![Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "present_file".into(),
            description: format!(
                "Show a file you already wrote to the user, inline in the chat — call this instead \
                 of pasting the file's contents into your reply. `.html` renders as a live preview \
                 with an \"open in browser\" button; anything else shows a card that opens it in \
                 its default app.\n\n{hint}"
            ),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "format": {
                        "type": "string",
                        "enum": ["html", "md", "csv", "json", "txt"],
                        "description": "Override the presentation; inferred from the extension when omitted."
                    }
                },
                "required": ["path"]
            }),
        },
    }]
}

/// Definitions for the `file_manage` group (0.9.1): rename/move, copy, delete,
/// create folder. Split from the read/write `file_system` group so a zone can be
/// given the ability to produce files without the ability to destroy them —
/// `delete_file` is classed dangerous and always prompts for approval.
pub fn manage_definitions(project_dir: Option<&str>) -> Vec<Tool> {
    let hint = path_syntax_hint(project_dir);
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "move_file".into(),
                description: format!(
                    "Move or rename a file or folder. To rename in place, keep the parent \
                     directory and change only the last path segment. Missing destination parents \
                     are created; an existing destination fails unless `overwrite`.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "from": { "type": "string", "description": "Existing path." },
                        "to":   { "type": "string", "description": "Destination path, including the new filename when renaming." },
                        "overwrite": { "type": "boolean", "description": "Replace the destination if it exists.", "default": false }
                    },
                    "required": ["from", "to"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "copy_file".into(),
                description: format!(
                    "Copy a single file (not a directory) to a new path. Missing destination \
                     parents are created; an existing destination fails unless `overwrite`.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "from": { "type": "string", "description": "File to copy." },
                        "to":   { "type": "string", "description": "Destination path for the copy." },
                        "overwrite": { "type": "boolean", "description": "Replace the destination if it exists.", "default": false }
                    },
                    "required": ["from", "to"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "delete_file".into(),
                description: format!(
                    "Delete a file. Destructive and not undoable — the user approves every call. A \
                     directory path is refused unless `recursive` is set.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" },
                        "recursive": {
                            "type": "boolean",
                            "description": "Required to delete a directory and everything in it. No effect on a file.",
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
                name: "create_folder".into(),
                description: format!(
                    "Create a directory and any missing parents. Succeeds quietly if it already \
                     exists.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string" }
                    },
                    "required": ["path"]
                }),
            },
        },
    ]
}

/// Definitions for the `file_search` group (0.9.1): exact/pattern search over
/// files. Read-only (safety 0). Complements semantic search (`search_local_files`):
/// embeddings answer "what is this about", these answer "where is this string".
pub fn search_definitions(project_dir: Option<&str>) -> Vec<Tool> {
    let hint = path_syntax_hint(project_dir);
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "find_files".into(),
                description: format!(
                    "Call this when you know roughly what a file is *called* — use \
                     `search_file_text` when you know what is *inside* it. Returns paths only, so \
                     it is cheap.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Glob matched against the file path, e.g. \"**/*.rs\", \"src/**/*.ts\", \"*config*\"." },
                        "path": { "type": "string", "description": "Directory to search under. Defaults to the working directory." },
                        "max_results": { "type": "integer", "description": "Cap on paths returned.", "default": 100 }
                    },
                    "required": ["pattern"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "search_file_text".into(),
                description: format!(
                    "Call this to find where a specific name, string, or symbol appears — exact \
                     search, not semantic (that is `search_local_files`). Returns each match with \
                     its path and line number. Narrow with `glob` when you can.\n\n{hint}"
                ),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Treated as a regex unless `literal` is true." },
                        "literal": { "type": "boolean", "description": "Match `query` as plain text.", "default": false },
                        "case_sensitive": { "type": "boolean", "default": false },
                        "glob": { "type": "string", "description": "Only search paths matching this glob, e.g. \"**/*.rs\"." },
                        "path": { "type": "string", "description": "Directory to search under. Defaults to the working directory." },
                        "max_results": { "type": "integer", "description": "Cap on matching lines returned.", "default": 50 }
                    },
                    "required": ["query"]
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
    let p = PathBuf::from(path.trim());
    if p.is_absolute() {
        return p;
    }
    match project_dir {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir.trim()).join(p),
        _ => p,
    }
}

/// One plausible reading of a model-supplied path. `guess` marks a reading that
/// is genuinely ambiguous: it is taken only when it points at something that
/// exists and the literal reading does not, so a guess can never quietly put a
/// file somewhere the caller didn't name.
struct Candidate {
    path: PathBuf,
    guess: bool,
}

/// Every plausible reading of a model-supplied path, best first.
///
/// The literal reading is what the tools always did, and it stays authoritative
/// wherever it is unambiguous. The rest recover the forms models reach for
/// constantly and that used to come straight back as a scope error:
///   - `~/notes.md` — home-relative in the model's head, project-relative here.
///     Tried *before* the literal reading: joining a `~` on gives a directory
///     literally named `~`, which is never what was meant.
///   - `/docs/notes.md` — rooted but with no drive. On Windows `Path::join`
///     discards the project directory entirely when given one of these, which
///     is where most "outside the project directory" errors came from.
///   - `MultiZone2/docs/notes.md` — repeats the project folder's own name.
///     Ambiguous, since the project may really contain a folder of that name,
///     so it is a `guess`: it wins only when the file it names exists and the
///     literal nested path does not.
///
/// Every candidate is still scope-checked against the allowed roots, so this
/// widens what the model may *say*, never what it may reach.
fn path_candidates(path: &str, project_dir: Option<&str>) -> Vec<Candidate> {
    let raw = path.trim();
    let literal = Candidate { path: resolve_path(raw, project_dir), guess: false };
    let base = match project_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => return vec![literal],
    };
    let rel = |rest: &str| Candidate { path: base.join(rest), guess: false };

    let mut out = Vec::new();

    if let Some(rest) = raw.strip_prefix('~') {
        let rest = rest.trim_start_matches(['/', '\\']);
        if !rest.is_empty() {
            out.push(rel(rest));
        }
    }

    // Guesses are ordered ahead of the literal reading; each is gated on the
    // literal not existing, so ordering only decides which recovery wins.
    if let Some(name) = base.file_name().and_then(|n| n.to_str()) {
        let stripped = raw.trim_start_matches(['/', '\\']);
        if let Some(rest) = stripped.strip_prefix(name) {
            let rest = rest.trim_start_matches(['/', '\\']);
            if !rest.is_empty() {
                out.push(Candidate { path: base.join(rest), guess: true });
            }
        }
    }

    out.push(literal);

    if raw.starts_with('/') || raw.starts_with('\\') {
        let rest = raw.trim_start_matches(['/', '\\']);
        if !rest.is_empty() {
            out.push(rel(rest));
        }
    }

    out
}

/// Resolve a model-supplied path and accept the first reading that lands inside
/// the allowed roots. `Err` is the JSON error string the tools return verbatim:
/// it names what was tried, what the roots are, and how to write the path —
/// that string is the model's only way to recover from a bad path.
fn resolve_in_roots(
    path: &str,
    roots: &[PathBuf],
    project_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let candidates = path_candidates(path, project_dir);
    let literal_exists = resolve_path(path, project_dir).exists();
    let hit = candidates.iter().find(|c| {
        (!c.guess || (!literal_exists && c.path.exists())) && is_within_roots(&c.path, roots)
    });
    if let Some(c) = hit {
        return Ok(c.path.clone());
    }
    Err(json!({
        "error": format!("path is outside the project directory and allowed_roots: {path:?}"),
        "resolved_to": resolve_path(path, project_dir).to_string_lossy(),
        "allowed_roots": roots
            .iter()
            .map(|r| r.to_string_lossy().to_string())
            .collect::<Vec<_>>(),
        "how_to_write_the_path": path_syntax_hint(project_dir),
    })
    .to_string())
}

/// The single place that says how a path argument must be written. It goes into
/// the tool descriptions (so the model gets it right the first time) *and* into
/// the scope error (so it can fix a wrong one without guessing).
fn path_syntax_hint(project_dir: Option<&str>) -> String {
    match project_dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(dir) => {
            let dir = dir.trim_end_matches(['/', '\\']);
            let sep = if dir.contains('\\') { '\\' } else { '/' };
            format!(
                "PATHS: working directory is `{dir}`. Write paths relative to it (`notes.md`, \
                 `docs{sep}notes.md`). A leading `/` or `~` is read as relative to it too. An \
                 absolute path works only inside it; anywhere else on disk is refused."
            )
        }
        None => "PATHS: write paths relative to the working directory (`notes.md`, \
                 `docs/notes.md`), or absolute inside one of the zone's allowed roots."
            .to_string(),
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
    sink: &StreamSink,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let as_image = args.get("as_image").and_then(|v| v.as_bool()).unwrap_or(false);
    let p = match checked_path(path, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };

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
        if bytes.len() > MAX_PDF_BYTES {
            return Ok(json!({
                "error": format!(
                    "PDF is too large ({} MB); maximum is {} MB",
                    bytes.len() / 1024 / 1024,
                    MAX_PDF_BYTES / 1024 / 1024
                )
            })
            .to_string());
        }
        return read_pdf(&p, args, bytes, zone_config, sink).await;
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

/// Read a PDF for the model (1.0). Pages are rendered to images by default —
/// a PDF is a *visual* document, and text extraction silently loses tables,
/// figures, form layout and anything scanned, which the model then answers about
/// as if it had seen it. `as_text` opts back into extraction for a long
/// text-heavy document where the layout doesn't matter.
///
/// Only the selected pages come back (`pages`, default page 1), and the result
/// always names the total page count — so the first read of an unknown document
/// is cheap and tells the model how long it is, rather than the model having to
/// choose between one page and four hundred with no way to know the difference.
///
/// Rasterizing is the frontend's job (see [`crate::pdf_bridge`]). When no window
/// answers — the headless HTTP API, or a timeout — this falls back to
/// `pdf-extract` so the turn still gets the document's text.
async fn read_pdf(
    p: &Path,
    args: &Value,
    bytes: Vec<u8>,
    zone_config: &Value,
    sink: &StreamSink,
) -> AppResult<String> {
    use crate::pdf_bridge::{read_pdf as bridge_read, PdfReadMode, MAX_PAGES_PER_CALL};

    let path_str = p.to_string_lossy().to_string();
    let as_text = args.get("as_text").and_then(|v| v.as_bool()).unwrap_or(false);
    // The spec is passed through verbatim; the frontend resolves it against the
    // real page count (see `parsePageSpec` in lib/pdf.ts).
    let spec = args
        .get("pages")
        .and_then(|v| match v {
            // A bare number is the obvious way to write "just page 3", and models
            // write it that way whatever the schema says.
            Value::Number(n) => Some(n.to_string()),
            Value::String(s) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "1".to_string());
    // Page images are no use to a model that can't see them; that zone reads a
    // PDF as text whatever the call asked for (see `inject_global_tool_config`).
    let can_see = zone_config
        .get("vision_capable")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let mode = if as_text || !can_see { PdfReadMode::Text } else { PdfReadMode::Images };

    let response = match bridge_read(sink.app(), &path_str, &spec, mode, &bytes).await {
        Ok(r) => r,
        Err(why) => return Ok(pdf_text_fallback(&path_str, bytes, &why).await),
    };

    let total = response.page_count;
    let shown: Vec<u32> = response.pages.iter().map(|pg| pg.page).collect();
    if shown.is_empty() {
        return Ok(json!({
            "error": format!("no pages matched `pages: \"{spec}\"`; the document has {total} pages"),
        })
        .to_string());
    }

    // What the model is looking at, and how to see the rest. Without the second
    // half of this a model that got page 1 of 40 will answer from page 1.
    let mut note = format!(
        "PDF: {path_str}\n{total} page{} total; showing {}{}.",
        if total == 1 { "" } else { "s" },
        describe_pages(&shown),
        // Say so when the mode isn't the one that was asked for, so extracted
        // text is never mistaken for having seen the page.
        if mode == PdfReadMode::Text && !as_text {
            " as text (the active model can't accept images)"
        } else {
            ""
        },
    );
    if response.truncated {
        note.push_str(&format!(
            " The selection was capped at {MAX_PAGES_PER_CALL} pages per call."
        ));
    }
    if (shown.len() as u32) < total {
        note.push_str(
            " Read the pages you still need before answering — call read_file again with \
             `pages` (e.g. \"2-6\", \"all\").",
        );
    }

    if mode == PdfReadMode::Text {
        let content = response
            .pages
            .iter()
            .map(|pg| {
                format!(
                    "--- Page {} ---\n{}",
                    pg.page,
                    pg.text.as_deref().unwrap_or("").trim()
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        return Ok(json!({
            "ref": 1,
            "path": path_str,
            "source": path_str,
            "page_count": total,
            "pages_read": describe_pages(&shown),
            "content": content,
            "note": note,
            "citation_instructions": READ_FILE_CITATION,
        })
        .to_string());
    }

    // Image mode: a text part naming the document, then one image part per page.
    // Same multimodal shape `as_image` returns, so the provider layer already
    // knows how to send it.
    let mut parts = vec![json!({ "type": "text", "text": note })];
    for pg in &response.pages {
        let Some(url) = pg.image.as_deref() else { continue };
        parts.push(json!({ "type": "text", "text": format!("Page {}:", pg.page) }));
        parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
    }
    Ok(serde_json::to_string(&parts)
        .unwrap_or_else(|_| json!({ "error": "serialization failed" }).to_string()))
}

/// Text extraction in-process, for when the frontend renderer isn't reachable.
/// Reports why it fell back, so a model that asked for page images doesn't treat
/// extracted text as if it had seen the page.
async fn pdf_text_fallback(path_str: &str, bytes: Vec<u8>, why: &str) -> String {
    let extracted =
        tokio::task::spawn_blocking(move || pdf_extract::extract_text_from_mem_by_pages(&bytes))
            .await;
    match extracted {
        Ok(Ok(pages)) => {
            let content = pages
                .iter()
                .enumerate()
                .map(|(i, text)| format!("--- Page {} ---\n{}", i + 1, text.trim()))
                .collect::<Vec<_>>()
                .join("\n\n");
            json!({
                "ref": 1,
                "path": path_str,
                "source": path_str,
                "page_count": pages.len(),
                "pages_read": "all",
                "content": content,
                "note": format!(
                    "Page images were unavailable ({why}), so this is extracted text for the \
                     whole document — figures, tables and any scanned pages are not in it."
                ),
                "citation_instructions": READ_FILE_CITATION,
            })
            .to_string()
        }
        Ok(Err(e)) => json!({
            "error": format!("could not read the PDF: page images unavailable ({why}) and text extraction failed ({e})"),
        })
        .to_string(),
        Err(e) => json!({ "error": format!("task join error: {e}") }).to_string(),
    }
}

/// "page 3", "pages 1-4", "pages 1-3, 7" — a compact, human reading of a page
/// selection, collapsing runs into ranges.
fn describe_pages(pages: &[u32]) -> String {
    let mut ranges: Vec<(u32, u32)> = Vec::new();
    for &n in pages {
        match ranges.last_mut() {
            Some(last) if n == last.1 + 1 => last.1 = n,
            _ => ranges.push((n, n)),
        }
    }
    let body = ranges
        .iter()
        .map(|(a, b)| if a == b { a.to_string() } else { format!("{a}-{b}") })
        .collect::<Vec<_>>()
        .join(", ");
    let plural = pages.len() > 1 || ranges.iter().any(|(a, b)| a != b);
    format!("page{} {}", if plural { "s" } else { "" }, body)
}

/// Nudge the model to cite a file it draws on, mirroring the searches so a read
/// surfaces in the Sources list too.
///
/// The `ref` is deliberately not spelled out here (0.9.10). It used to say
/// "cite it with [1]", which was true only when `read_file` was the turn's only
/// citing call — a read after a search would tell the model to write `[1]` for
/// the file when `[1]` already meant the first search hit. Refs are renumbered
/// per turn now (see `tools::citations`), so the instruction has to point at
/// the field rather than repeat a number that is no longer fixed.
const READ_FILE_CITATION: &str =
    "If you use information from this file in your answer, cite it inline with its `ref` \
     number in square brackets immediately after the claim.";

pub async fn list_directory(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let max_depth = args.get("depth").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let roots = allowed_roots(zone_config, project_dir);
    let p = match checked_path(path, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
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
    let p = match checked_path(path, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
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

    let p = match path_candidates(path, project_dir)
        .into_iter()
        .map(|c| c.path)
        .find(|c| c.is_file())
    {
        Some(p) => p,
        None => {
            return Ok(json!({
                "error": format!(
                    "file does not exist: {}",
                    resolve_path(path, project_dir).to_string_lossy()
                ),
                "how_to_write_the_path": path_syntax_hint(project_dir),
            })
            .to_string());
        }
    };

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

// ---------------------------------------------------------------------------
// 0.9.1 — file management: move/rename, copy, delete, create folder.
// ---------------------------------------------------------------------------

/// Resolve a path and check it against the allowed roots, returning the error
/// JSON the tools return verbatim when it fails. Shared by every file tool so
/// the scoping rules can't drift between them.
fn checked_path(
    path: &str,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let roots = allowed_roots(zone_config, project_dir);
    if roots.is_empty() {
        return Err(
            json!({ "error": "no project directory or allowed_roots configured for file tools" })
                .to_string(),
        );
    }
    if path.trim().is_empty() {
        return Err(json!({ "error": "a 'path' is required" }).to_string());
    }
    resolve_in_roots(path, &roots, project_dir)
}

/// `move_file` — move or rename a file/folder within the allowed roots. Both
/// endpoints are scope-checked: a move can't be used to escape the roots.
pub async fn move_file(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let from = args.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("");
    let overwrite = args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);

    let src = match checked_path(from, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
    let dst = match checked_path(to, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
    if !src.exists() {
        return Ok(json!({ "error": format!("source does not exist: {}", src.to_string_lossy()) }).to_string());
    }
    if dst.exists() && !overwrite {
        return Ok(json!({
            "error": format!("destination already exists: {} — pass overwrite: true to replace it", dst.to_string_lossy())
        })
        .to_string());
    }
    if let Some(parent) = dst.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return Ok(json!({ "error": format!("failed to create destination directory: {e}") }).to_string());
        }
    }
    if dst.exists() && overwrite {
        // rename() over an existing directory fails on Windows; clear it first.
        let cleared = if dst.is_dir() {
            tokio::fs::remove_dir_all(&dst).await
        } else {
            tokio::fs::remove_file(&dst).await
        };
        if let Err(e) = cleared {
            return Ok(json!({ "error": format!("failed to replace destination: {e}") }).to_string());
        }
    }
    match tokio::fs::rename(&src, &dst).await {
        Ok(_) => Ok(json!({
            "ok": true,
            "from": src.to_string_lossy(),
            "to": dst.to_string_lossy(),
        })
        .to_string()),
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}

/// `copy_file` — copy a single file. Directories are refused (a recursive copy
/// is rarely what a model means, and is easy to do accidentally at scale).
pub async fn copy_file(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let from = args.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let to = args.get("to").and_then(|v| v.as_str()).unwrap_or("");
    let overwrite = args.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);

    let src = match checked_path(from, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
    let dst = match checked_path(to, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
    if !src.is_file() {
        return Ok(json!({ "error": "copy_file copies a single file; source is missing or is a directory" }).to_string());
    }
    if dst.exists() && !overwrite {
        return Ok(json!({
            "error": format!("destination already exists: {} — pass overwrite: true to replace it", dst.to_string_lossy())
        })
        .to_string());
    }
    if let Some(parent) = dst.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            return Ok(json!({ "error": format!("failed to create destination directory: {e}") }).to_string());
        }
    }
    match tokio::fs::copy(&src, &dst).await {
        Ok(bytes) => Ok(json!({
            "ok": true,
            "from": src.to_string_lossy(),
            "to": dst.to_string_lossy(),
            "bytes_copied": bytes,
        })
        .to_string()),
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}

/// `delete_file` — destructive, so it is classed dangerous (level 2) and always
/// goes through the approval gate. A directory is only removed when the model
/// explicitly passes `recursive: true`.
pub async fn delete_file(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let recursive = args.get("recursive").and_then(|v| v.as_bool()).unwrap_or(false);

    let p = match checked_path(path, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
    if !p.exists() {
        return Ok(json!({ "error": format!("path does not exist: {}", p.to_string_lossy()) }).to_string());
    }
    // Never let a delete take out an allowed root itself.
    let roots = allowed_roots(zone_config, project_dir);
    let is_root = roots.iter().any(|r| {
        match (r.canonicalize(), p.canonicalize()) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    });
    if is_root {
        return Ok(json!({ "error": "refusing to delete the project directory / allowed root itself" }).to_string());
    }

    if p.is_dir() {
        if !recursive {
            return Ok(json!({
                "error": "path is a directory — pass recursive: true to delete it and all of its contents"
            })
            .to_string());
        }
        return match tokio::fs::remove_dir_all(&p).await {
            Ok(_) => Ok(json!({ "ok": true, "deleted": p.to_string_lossy(), "kind": "directory" }).to_string()),
            Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
        };
    }
    match tokio::fs::remove_file(&p).await {
        Ok(_) => Ok(json!({ "ok": true, "deleted": p.to_string_lossy(), "kind": "file" }).to_string()),
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}

/// `create_folder` — mkdir -p, idempotent.
pub async fn create_folder(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let p = match checked_path(path, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
    match tokio::fs::create_dir_all(&p).await {
        Ok(_) => Ok(json!({ "ok": true, "path": p.to_string_lossy() }).to_string()),
        Err(e) => Ok(json!({ "error": e.to_string() }).to_string()),
    }
}

// ---------------------------------------------------------------------------
// 0.9.1 — file search: find_files (by name) and search_file_text (by content).
// ---------------------------------------------------------------------------

/// Directories never worth walking for either search tool. Keeps a search of a
/// real project from drowning in dependency and VCS noise.
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", ".venv",
    "venv", "__pycache__", ".cache", ".svelte-kit",
];

const MAX_WALK_ENTRIES: usize = 20_000;
/// Files above this size are skipped by the content search — they are almost
/// always binaries or build artifacts, and reading them would blow the budget.
const MAX_SEARCHABLE_BYTES: u64 = 2 * 1024 * 1024;

/// Collect every file under `root` (breadth-unbounded, depth-first), skipping
/// noise directories and stopping at `MAX_WALK_ENTRIES` so a search over a huge
/// tree terminates. Returns paths only.
fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= MAX_WALK_ENTRIES {
            break;
        }
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
            } else {
                out.push(path);
                if out.len() >= MAX_WALK_ENTRIES {
                    break;
                }
            }
        }
    }
    out
}

/// Search root: the caller's `path` when given, else the project directory, else
/// the first allowed root. Always scope-checked.
fn search_root(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> Result<PathBuf, String> {
    let roots = allowed_roots(zone_config, project_dir);
    if roots.is_empty() {
        return Err(
            json!({ "error": "no project directory or allowed_roots configured for file tools" })
                .to_string(),
        );
    }
    match args.get("path").and_then(|v| v.as_str()).map(str::trim) {
        Some(p) if !p.is_empty() => checked_path(p, zone_config, project_dir),
        _ => Ok(roots
            .iter()
            .find(|r| r.is_dir())
            .cloned()
            .unwrap_or_else(|| roots[0].clone())),
    }
}

/// `find_files` — glob over file paths. Matches against both the path relative
/// to the search root and the bare filename, so "*.rs" behaves the way a user
/// expects without requiring a leading "**/".
pub async fn find_files(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let pattern = args.get("pattern").and_then(|v| v.as_str()).unwrap_or("").trim();
    if pattern.is_empty() {
        return Ok(json!({ "error": "a glob 'pattern' is required" }).to_string());
    }
    let max = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 1000) as usize)
        .unwrap_or(100);
    let root = match search_root(args, zone_config, project_dir) {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    let glob = match globset::GlobBuilder::new(pattern)
        .literal_separator(false)
        .case_insensitive(true)
        .build()
    {
        Ok(g) => g.compile_matcher(),
        Err(e) => return Ok(json!({ "error": format!("invalid glob pattern: {e}") }).to_string()),
    };

    let root_for_walk = root.clone();
    let files = tokio::task::spawn_blocking(move || walk_files(&root_for_walk))
        .await
        .unwrap_or_default();

    let mut matches: Vec<String> = Vec::new();
    let mut truncated = false;
    for f in &files {
        let rel = f.strip_prefix(&root).unwrap_or(f);
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if glob.is_match(rel_str.as_str()) || glob.is_match(name.as_str()) {
            if matches.len() >= max {
                truncated = true;
                break;
            }
            matches.push(rel_str);
        }
    }
    matches.sort();

    Ok(json!({
        "root": root.to_string_lossy(),
        "pattern": pattern,
        "count": matches.len(),
        "truncated": truncated,
        "files": matches,
        "note": if matches.is_empty() { Some("No files matched. Try a looser pattern, e.g. \"*name*\".") } else { None },
    })
    .to_string())
}

/// `search_file_text` — regex/literal content search, returning path + line
/// number + the matching line. The exact-search counterpart to the semantic
/// `search_local_files`.
pub async fn search_file_text(
    args: &Value,
    zone_config: &Value,
    project_dir: Option<&str>,
) -> AppResult<String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    if query.trim().is_empty() {
        return Ok(json!({ "error": "a 'query' is required" }).to_string());
    }
    let literal = args.get("literal").and_then(|v| v.as_bool()).unwrap_or(false);
    let case_sensitive = args.get("case_sensitive").and_then(|v| v.as_bool()).unwrap_or(false);
    let max = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 500) as usize)
        .unwrap_or(50);
    let root = match search_root(args, zone_config, project_dir) {
        Ok(r) => r,
        Err(e) => return Ok(e),
    };

    let pattern = if literal { regex::escape(query) } else { query.to_string() };
    let re = match regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .size_limit(1 << 20)
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            return Ok(json!({
                "error": format!("invalid regular expression: {e} — pass literal: true to search for it as plain text")
            })
            .to_string())
        }
    };

    let file_glob = match args.get("glob").and_then(|v| v.as_str()).map(str::trim).filter(|g| !g.is_empty()) {
        Some(g) => match globset::GlobBuilder::new(g)
            .literal_separator(false)
            .case_insensitive(true)
            .build()
        {
            Ok(built) => Some(built.compile_matcher()),
            Err(e) => return Ok(json!({ "error": format!("invalid glob: {e}") }).to_string()),
        },
        None => None,
    };

    let root_for_walk = root.clone();
    let root_for_scan = root.clone();
    let scan = tokio::task::spawn_blocking(move || {
        let files = walk_files(&root_for_walk);
        let mut hits: Vec<Value> = Vec::new();
        let mut truncated = false;
        let mut files_searched = 0usize;

        for f in files {
            if hits.len() >= max {
                truncated = true;
                break;
            }
            let rel = f.strip_prefix(&root_for_scan).unwrap_or(&f);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if let Some(g) = &file_glob {
                let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if !g.is_match(rel_str.as_str()) && !g.is_match(name.as_str()) {
                    continue;
                }
            }
            let too_big = std::fs::metadata(&f)
                .map(|m| m.len() > MAX_SEARCHABLE_BYTES)
                .unwrap_or(true);
            if too_big {
                continue;
            }
            let bytes = match std::fs::read(&f) {
                Ok(b) => b,
                Err(_) => continue,
            };
            // Binary sniff: a NUL byte in the first block means don't treat it as text.
            if bytes.iter().take(1024).any(|b| *b == 0) {
                continue;
            }
            files_searched += 1;
            let content = bytes_to_string(bytes);
            for (i, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    if hits.len() >= max {
                        truncated = true;
                        break;
                    }
                    let trimmed = line.trim();
                    let text: String = if trimmed.chars().count() > 300 {
                        trimmed.chars().take(300).collect::<String>() + "…"
                    } else {
                        trimmed.to_string()
                    };
                    hits.push(json!({
                        "file": rel_str,
                        "line": i + 1,
                        "text": text,
                    }));
                }
            }
        }
        (hits, truncated, files_searched)
    })
    .await;

    let (hits, truncated, files_searched) = match scan {
        Ok(v) => v,
        Err(e) => return Ok(json!({ "error": format!("search task failed: {e}") }).to_string()),
    };

    Ok(json!({
        "root": root.to_string_lossy(),
        "query": query,
        "files_searched": files_searched,
        "count": hits.len(),
        "truncated": truncated,
        "matches": hits,
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
    let p = match checked_path(path, zone_config, project_dir) {
        Ok(p) => p,
        Err(e) => return Ok(e),
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory that is also the only allowed root, so the tests
    /// exercise the same scoping the tools enforce in the app.
    struct Sandbox {
        root: PathBuf,
    }

    impl Sandbox {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "mz_fs_test_{tag}_{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn zone_config(&self) -> Value {
            json!({ "file_system": { "allowed_roots": [self.root.to_string_lossy()] } })
        }

        fn write(&self, rel: &str, content: &str) {
            let p = self.root.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(p, content).unwrap();
        }

        fn dir(&self) -> Option<&str> {
            self.root.to_str()
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// The page note is the only thing telling the model it is looking at part
    /// of a document, so it has to read as a sentence for every shape of
    /// selection — one page, a run, and a scattered set.
    #[test]
    fn page_selections_read_as_prose() {
        assert_eq!(describe_pages(&[1]), "page 1");
        assert_eq!(describe_pages(&[1, 2, 3, 4]), "pages 1-4");
        assert_eq!(describe_pages(&[1, 2, 3, 7]), "pages 1-3, 7");
        assert_eq!(describe_pages(&[2, 9]), "pages 2, 9");
    }

    #[tokio::test]
    async fn move_file_renames_within_the_root() {
        let sb = Sandbox::new("move");
        sb.write("notes.txt", "hello");

        let out = move_file(
            &json!({ "from": "notes.txt", "to": "renamed.txt" }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();

        assert_eq!(v["ok"], true);
        assert!(!sb.root.join("notes.txt").exists());
        assert_eq!(
            std::fs::read_to_string(sb.root.join("renamed.txt")).unwrap(),
            "hello"
        );
    }

    #[tokio::test]
    async fn move_file_refuses_an_existing_destination_without_overwrite() {
        let sb = Sandbox::new("move_clobber");
        sb.write("a.txt", "keep me");
        sb.write("b.txt", "original");

        let out = move_file(
            &json!({ "from": "a.txt", "to": "b.txt" }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();

        assert!(v["error"].is_string(), "expected a refusal, got {v}");
        // Neither file was touched.
        assert_eq!(std::fs::read_to_string(sb.root.join("b.txt")).unwrap(), "original");
        assert!(sb.root.join("a.txt").exists());
    }

    #[tokio::test]
    async fn move_file_cannot_escape_the_allowed_roots() {
        let sb = Sandbox::new("escape");
        sb.write("secret.txt", "sensitive");

        let out = move_file(
            &json!({ "from": "secret.txt", "to": "../escaped.txt" }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();

        assert!(v["error"].as_str().unwrap().contains("outside"));
        assert!(sb.root.join("secret.txt").exists());
    }

    #[tokio::test]
    async fn delete_file_needs_recursive_for_a_directory_and_never_removes_the_root() {
        let sb = Sandbox::new("delete");
        sb.write("sub/inner.txt", "x");

        // A directory without `recursive` is refused...
        let out = delete_file(&json!({ "path": "sub" }), &sb.zone_config(), sb.dir())
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["error"].as_str().unwrap().contains("recursive"));
        assert!(sb.root.join("sub").exists());

        // ...and the allowed root itself is refused even with it.
        let out = delete_file(
            &json!({ "path": ".", "recursive": true }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["error"].as_str().unwrap().contains("refusing"));
        assert!(sb.root.exists());

        // With `recursive`, a real subdirectory goes.
        let out = delete_file(
            &json!({ "path": "sub", "recursive": true }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true);
        assert!(!sb.root.join("sub").exists());
    }

    #[tokio::test]
    async fn find_files_matches_globs_and_skips_noise_directories() {
        let sb = Sandbox::new("find");
        sb.write("src/main.rs", "fn main() {}");
        sb.write("src/lib.rs", "");
        sb.write("README.md", "");
        sb.write("node_modules/dep/index.rs", "should never be walked");

        let out = find_files(&json!({ "pattern": "**/*.rs" }), &sb.zone_config(), sb.dir())
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let files: Vec<&str> = v["files"].as_array().unwrap().iter().map(|f| f.as_str().unwrap()).collect();

        assert_eq!(files, vec!["src/lib.rs", "src/main.rs"]);
    }

    #[tokio::test]
    async fn search_file_text_reports_path_and_line_and_honours_the_glob() {
        let sb = Sandbox::new("grep");
        sb.write("src/a.rs", "let x = 1;\nlet needle = 2;\n");
        sb.write("src/b.ts", "const needle = 3;\n");

        // Unfiltered: both files hit.
        let out = search_file_text(&json!({ "query": "needle" }), &sb.zone_config(), sb.dir())
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["count"], 2);

        // Filtered to Rust: only a.rs, and the line number is 1-indexed.
        let out = search_file_text(
            &json!({ "query": "needle", "glob": "**/*.rs" }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let m = &v["matches"][0];
        assert_eq!(v["count"], 1);
        assert_eq!(m["file"], "src/a.rs");
        assert_eq!(m["line"], 2);
        assert_eq!(m["text"], "let needle = 2;");
    }

    #[tokio::test]
    async fn search_file_text_falls_back_cleanly_on_a_bad_regex() {
        let sb = Sandbox::new("badre");
        sb.write("a.txt", "cost is 5+ dollars");

        // An invalid regex is an error that tells the model how to recover...
        let out = search_file_text(&json!({ "query": "cost (5" }), &sb.zone_config(), sb.dir())
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert!(v["error"].as_str().unwrap().contains("literal"));

        // ...and `literal: true` searches for it verbatim.
        let out = search_file_text(
            &json!({ "query": "5+ dollars", "literal": true }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["count"], 1);
    }

    /// The forms models actually emit. Each of these used to come back as
    /// "path is outside the project directory and allowed_roots".
    #[tokio::test]
    async fn create_file_accepts_the_path_shapes_models_reach_for() {
        let sb = Sandbox::new("path_shapes");
        let folder = sb.root.file_name().unwrap().to_string_lossy().to_string();

        for (given, expected_rel) in [
            ("notes.md", "notes.md"),
            ("docs/nested/deep.md", "docs/nested/deep.md"),
            ("/docs/rooted.md", "docs/rooted.md"),
            ("~/home.md", "home.md"),
            ("./dotted.md", "dotted.md"),
        ] {
            let out = create_file(
                &json!({ "path": given, "content": given }),
                &sb.zone_config(),
                sb.dir(),
            )
            .await
            .unwrap();
            let v: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(v["ok"], true, "{given} was refused: {v}");
            assert_eq!(
                std::fs::read_to_string(sb.root.join(expected_rel)).unwrap(),
                given,
                "{given} did not land at {expected_rel}"
            );
        }

        // A path that repeats the project folder's own name resolves to the file
        // under it, but only because that file already exists by now.
        let out = create_file(
            &json!({ "path": format!("{folder}/notes.md"), "content": "rewritten" }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(
            std::fs::read_to_string(sb.root.join("notes.md")).unwrap(),
            "rewritten"
        );
    }

    /// A real escape is still refused — and the refusal now carries everything
    /// the model needs to write the path correctly on its next attempt.
    #[tokio::test]
    async fn create_file_refusal_explains_the_path_syntax() {
        let sb = Sandbox::new("path_refusal");

        let out = create_file(
            &json!({ "path": "../escaped.md", "content": "nope" }),
            &sb.zone_config(),
            sb.dir(),
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();

        assert!(v["error"].as_str().unwrap().contains("outside"));
        assert!(v["resolved_to"].is_string(), "{v}");
        assert!(!v["allowed_roots"].as_array().unwrap().is_empty(), "{v}");
        let hint = v["how_to_write_the_path"].as_str().unwrap();
        assert!(hint.contains(sb.dir().unwrap()), "hint must name the directory: {hint}");
        assert!(!sb.root.parent().unwrap().join("escaped.md").exists());
    }

    /// The descriptions the model reads must name the real working directory —
    /// that is what stops the bad path being written in the first place.
    #[test]
    fn tool_descriptions_name_the_working_directory() {
        let dir = r"F:\Development\MultiZone2";
        let defs = definitions(Some(dir));
        let create = defs.iter().find(|t| t.function.name == "create_file").unwrap();

        // The model needs the working directory spelled out somewhere to write a
        // path that resolves first time — but exactly once (0.9.10). It used to
        // be repeated in the `path` parameter too, doubling the cost of a hint
        // the model reads once.
        assert!(create.function.description.contains(dir));
        assert_eq!(create.function.description.matches(dir).count(), 1);

        let path_desc = create.function.parameters["properties"]["path"]["description"].as_str();
        assert!(
            path_desc.map_or(true, |d| !d.contains(dir)),
            "the path parameter repeats the working directory: {path_desc:?}",
        );

        // With no working directory set, the wording must not claim one.
        let defs = definitions(None);
        let create = defs.iter().find(|t| t.function.name == "create_file").unwrap();
        assert!(create.function.description.contains("allowed roots"));
    }
}
