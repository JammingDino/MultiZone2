//! Folder-backed skills ("skill packs").
//!
//! A skill in the DB is one row: name, description, and a single markdown blob.
//! That covers skills you write here, but it cannot hold the format the wider
//! agent-skill ecosystem publishes in — a *directory*:
//!
//! ```text
//! impeccable/
//!   SKILL.md              # YAML frontmatter (name, description) + the entry instructions
//!   reference/*.md        # loaded on demand, one per command
//!   scripts/*.mjs         # run via run_command / execute_code when the zone has them
//! ```
//!
//! Installers (`npx impeccable install`, the HyperFrames installer, …) write
//! that tree under a harness folder — `.claude/skills/<name>/`, `.agents/skills/<name>/`
//! and so on. This module discovers those trees wherever they are, so a pack
//! installed for *any* harness is offered to MultiZone's agents as well, and
//! serves the sub-files back through `load_skill` rather than requiring the
//! zone to have filesystem tools enabled.
//!
//! Packs are read-only here: the installer owns the tree and `update` overwrites
//! it, so editing a pack in Settings would be silently discarded.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Harness folders an installer may have written a skills tree into. Scanned
/// under every configured root, so pointing MultiZone at a repo that already ran
/// `npx impeccable install` picks the pack up with no second install.
const PROVIDER_DIRS: [&str; 14] = [
    ".claude",
    ".agents",
    ".codex",
    ".cursor",
    ".gemini",
    ".github",
    ".grok",
    ".kiro",
    ".opencode",
    ".pi",
    ".qoder",
    ".trae",
    ".rovodev",
    ".vibe",
];

/// Caps. A pack is meant to be read by a model, so the file listing and any one
/// file have to stay inside a sane share of the context window.
const MAX_LISTED_FILES: usize = 300;
const MAX_WALK_DEPTH: usize = 5;
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Frontmatter descriptions in this format are routing text and run long
/// (impeccable's is ~900 chars). Kept, but bounded — every enabled pack's
/// description sits in the system prompt.
const MAX_DESCRIPTION: usize = 1200;
/// How much of a SKILL.md to read when discovering it. Frontmatter sits at the
/// very top; the longest in the wild is ~1 KB.
const FRONTMATTER_SCAN_BYTES: usize = 8 * 1024;

/// Directory names that are never a skill and would bloat a file listing.
const SKIP_DIRS: [&str; 6] = ["node_modules", ".git", "target", "dist", "__pycache__", ".venv"];

/// The managed skills folder — `<app data>/skills`. Set once at startup so the
/// tool layer can reach it without an `AppHandle`, mirroring `ocr::set_models_dir`.
static MANAGED_ROOT: OnceLock<PathBuf> = OnceLock::new();

pub fn set_managed_root(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = MANAGED_ROOT.set(dir);
}

pub fn managed_root() -> Option<PathBuf> {
    MANAGED_ROOT.get().cloned()
}

/// A skill discovered on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPack {
    pub name: String,
    pub description: String,
    /// Absolute path of the skill's own directory (the one holding SKILL.md).
    pub dir: String,
    /// The configured root it was found under — what the user sees as its source.
    pub root: String,
    /// Whether the folder holds anything beyond SKILL.md. A shallow check: this
    /// is on the per-message catalog path, so it must not walk the tree.
    pub multi_file: bool,
    /// Files in the tree, capped at [`MAX_LISTED_FILES`]. Only filled for the
    /// Settings view ([`with_file_counts`]) — counting means a full walk, which
    /// is far too much work to repeat on every message.
    pub file_count: Option<usize>,
    /// False when the user has switched it off in Settings → Skills.
    pub enabled: bool,
}

/// Add the file count to each pack. For the Settings list only.
pub fn with_file_counts(packs: Vec<SkillPack>) -> Vec<SkillPack> {
    packs
        .into_iter()
        .map(|mut p| {
            p.file_count = Some(list_files(Path::new(&p.dir)).len());
            p
        })
        .collect()
}

/// Read the app settings JSON blob. Skill-pack config lives there with the rest
/// of the user's preferences rather than in its own table.
async fn app_settings(db: &SqlitePool) -> serde_json::Value {
    let raw: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_settings'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    raw.and_then(|r| serde_json::from_str(&r).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn string_list(settings: &serde_json::Value, key: &str) -> Vec<String> {
    settings
        .get(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Every root to scan: the managed folder first, then any folder the user added.
pub async fn roots(db: &SqlitePool) -> Vec<PathBuf> {
    let settings = app_settings(db).await;
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(managed) = managed_root() {
        out.push(managed);
    }
    for dir in string_list(&settings, "skillPackDirs") {
        let p = PathBuf::from(dir);
        if !out.iter().any(|r| r == &p) {
            out.push(p);
        }
    }
    out
}

/// All packs across all roots, in catalog order. Names are unique: the first
/// root that provides a name wins, so the managed folder shadows a stale copy
/// in a project checkout rather than the catalog listing the same skill twice.
pub async fn discover(db: &SqlitePool) -> Vec<SkillPack> {
    let settings = app_settings(db).await;
    let disabled: Vec<String> = string_list(&settings, "disabledSkillPacks")
        .into_iter()
        .map(|s| s.to_lowercase())
        .collect();
    let roots = roots(db).await;

    // Off the async runtime: this is real filesystem work on the path that
    // builds every system prompt.
    tokio::task::spawn_blocking(move || {
        let mut out: Vec<SkillPack> = Vec::new();
        for root in roots {
            for mut pack in scan_root(&root) {
                if out.iter().any(|p| p.name.eq_ignore_ascii_case(&pack.name)) {
                    continue;
                }
                pack.enabled = !disabled.contains(&pack.name.to_lowercase());
                out.push(pack);
            }
        }
        out.sort_by_key(|p| p.name.to_lowercase());
        out
    })
    .await
    .unwrap_or_default()
}

/// One enabled pack by name, for `load_skill`.
pub async fn find_enabled(db: &SqlitePool, name: &str) -> Option<SkillPack> {
    discover(db)
        .await
        .into_iter()
        .find(|p| p.enabled && p.name.eq_ignore_ascii_case(name))
}

/// Directories under `root` that may hold `<name>/SKILL.md`: the root itself,
/// `<root>/skills`, and each harness folder's `skills` dir.
fn skills_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf(), root.join("skills")];
    for provider in PROVIDER_DIRS {
        dirs.push(root.join(provider).join("skills"));
    }
    dirs
}

fn scan_root(root: &Path) -> Vec<SkillPack> {
    let mut out: Vec<SkillPack> = Vec::new();
    for dir in skills_dirs(root) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(dir_name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if SKIP_DIRS.contains(&dir_name) {
                continue;
            }
            if let Some(pack) = read_pack(&path, root) {
                if !out.iter().any(|p| p.name.eq_ignore_ascii_case(&pack.name)) {
                    out.push(pack);
                }
            }
        }
    }
    out
}

/// Build a pack from a directory, or `None` when it holds no `SKILL.md`.
///
/// Only the head of SKILL.md is read: discovery needs the frontmatter, not the
/// body, and some of these files run to tens of KB.
fn read_pack(dir: &Path, root: &Path) -> Option<SkillPack> {
    let skill_md = dir.join("SKILL.md");
    if !skill_md.is_file() {
        return None;
    }
    let head = read_head(&skill_md, FRONTMATTER_SCAN_BYTES)?;
    let fallback = dir.file_name()?.to_str()?.to_string();
    let (name, description, _) = parse_frontmatter(&head, &fallback);
    Some(SkillPack {
        name,
        description,
        dir: dir.to_string_lossy().to_string(),
        root: root.to_string_lossy().to_string(),
        multi_file: has_more_than_skill_md(dir),
        file_count: None,
        enabled: true,
    })
}

/// Does this folder hold anything besides SKILL.md? One `read_dir`, no recursion.
fn has_more_than_skill_md(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_name()
            .to_str()
            .map(|n| !n.eq_ignore_ascii_case("SKILL.md"))
            .unwrap_or(false)
    })
}

/// Read at most `max` bytes from the start of a file, truncated on a char
/// boundary so the frontmatter parser gets valid UTF-8.
fn read_head(path: &Path, max: usize) -> Option<String> {
    use std::io::Read;
    let mut buf = vec![0u8; max];
    let mut file = std::fs::File::open(path).ok()?;
    let read = file.read(&mut buf).ok()?;
    buf.truncate(read);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Split YAML frontmatter off a SKILL.md, returning (name, description, body).
///
/// Deliberately minimal — enough for the `name:`/`description:` scalars this
/// format uses, ignoring the harness-specific keys (`allowed-tools:`,
/// `argument-hint:`, …) that mean nothing here. Mirrors `parseSkill` in
/// src/lib/skillFile.ts.
fn parse_frontmatter(raw: &str, fallback_name: &str) -> (String, String, String) {
    let text = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let rest = match text.strip_prefix("---\n").or_else(|| text.strip_prefix("---\r\n")) {
        Some(r) => r,
        None => return (fallback_name.to_string(), String::new(), text.to_string()),
    };
    // Find the closing fence at the start of a line.
    let mut fm_end = None;
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            fm_end = Some((offset, offset + line.len()));
            break;
        }
        offset += line.len();
    }
    let Some((fm_stop, body_start)) = fm_end else {
        return (fallback_name.to_string(), String::new(), text.to_string());
    };

    let mut name = String::new();
    let mut description = String::new();
    let mut current: Option<&str> = None;
    for line in rest[..fm_stop].lines() {
        // A nested list/continuation line belongs to whichever key opened it.
        if line.starts_with([' ', '\t', '-']) {
            let cont = line.trim_start_matches(['-', ' ', '\t']).trim();
            match current {
                Some("name") if !cont.is_empty() => push_continuation(&mut name, cont),
                Some("description") if !cont.is_empty() => push_continuation(&mut description, cont),
                _ => {}
            }
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let value = unquote(value.trim());
        match key.as_str() {
            "name" => name = value,
            "description" => description = value,
            _ => {}
        }
        current = match key.as_str() {
            "name" => Some("name"),
            "description" => Some("description"),
            _ => None,
        };
    }

    let name = if name.trim().is_empty() { fallback_name.to_string() } else { name.trim().to_string() };
    let mut description = description.trim().to_string();
    if description.chars().count() > MAX_DESCRIPTION {
        description = description.chars().take(MAX_DESCRIPTION).collect::<String>() + "…";
    }
    (name, description, rest[body_start..].to_string())
}

/// Append a folded/continuation line to the value its key opened.
fn push_continuation(target: &mut String, cont: &str) {
    if !target.is_empty() {
        target.push(' ');
    }
    target.push_str(cont);
}

/// Strip surrounding quotes and YAML block-scalar markers from a scalar value.
fn unquote(v: &str) -> String {
    let v = v.trim();
    let v = v.strip_prefix('>').or_else(|| v.strip_prefix('|')).unwrap_or(v);
    let v = v.trim_start_matches(['-', '+']).trim();
    if v.len() >= 2 {
        let bytes = v.as_bytes();
        let first = bytes[0];
        let last = bytes[v.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return v[1..v.len() - 1].to_string();
        }
    }
    v.to_string()
}

/// The pack's instructions: SKILL.md with its frontmatter removed.
pub fn instructions(dir: &Path) -> AppResult<String> {
    let raw = std::fs::read_to_string(dir.join("SKILL.md"))
        .map_err(|e| AppError::Other(format!("could not read SKILL.md: {e}")))?;
    let fallback = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("skill")
        .to_string();
    let (_, _, body) = parse_frontmatter(&raw, &fallback);
    Ok(body.trim_start().to_string())
}

/// Every file in the pack as a forward-slashed relative path, sorted, capped.
/// This is the map the model navigates by, so it goes back with the load.
pub fn list_files(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(dir.to_path_buf(), 0)];
    while let Some((current, depth)) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            if out.len() >= MAX_LISTED_FILES {
                break;
            }
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if path.is_dir() {
                if depth < MAX_WALK_DEPTH && !SKIP_DIRS.contains(&file_name) {
                    queue.push((path, depth + 1));
                }
                continue;
            }
            if let Ok(rel) = path.strip_prefix(dir) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    out
}

/// Read one file from inside a pack.
///
/// Jailed to the pack directory: the relative path is resolved and then checked
/// against the canonical pack root, so neither `../` nor a symlink out of the
/// tree can turn `load_skill` into an arbitrary file reader for a zone that was
/// never given filesystem tools.
pub fn read_file(dir: &Path, rel: &str) -> AppResult<String> {
    let rel = rel.trim().trim_start_matches(['/', '\\']);
    if rel.is_empty() {
        return Err(AppError::Other("no file path given".into()));
    }
    // Tolerate the harness-prefixed paths that SKILL.md files write inline,
    // e.g. `.claude/skills/impeccable/reference/polish.md` → `reference/polish.md`.
    let normalized = rel.replace('\\', "/");
    let rel = match normalized.split_once("/skills/") {
        Some((head, tail)) if head.starts_with('.') => tail
            .split_once('/')
            .map(|(_, after)| after.to_string())
            .unwrap_or_else(|| tail.to_string()),
        _ => normalized,
    };

    let base = dir
        .canonicalize()
        .map_err(|e| AppError::Other(format!("skill directory is unreadable: {e}")))?;
    let target = base.join(&rel);
    let target = target
        .canonicalize()
        .map_err(|_| AppError::Other(format!("no file '{rel}' in this skill")))?;
    if !target.starts_with(&base) {
        return Err(AppError::Other(format!("'{rel}' is outside the skill directory")));
    }
    let meta = std::fs::metadata(&target)
        .map_err(|e| AppError::Other(format!("could not stat '{rel}': {e}")))?;
    if meta.is_dir() {
        return Err(AppError::Other(format!("'{rel}' is a directory, not a file")));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::Other(format!(
            "'{rel}' is {} KB — too large to load ({} KB limit)",
            meta.len() / 1024,
            MAX_FILE_BYTES / 1024
        )));
    }
    let bytes = std::fs::read(&target).map_err(|e| AppError::Other(format!("could not read '{rel}': {e}")))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let raw = "---\nname: impeccable\ndescription: \"Use when designing UI.\"\nversion: 4.0.2\nallowed-tools:\n  - Bash(npx impeccable *)\n---\n\nBody text.\n";
        let (name, description, body) = parse_frontmatter(raw, "fallback");
        assert_eq!(name, "impeccable");
        assert_eq!(description, "Use when designing UI.");
        assert_eq!(body.trim(), "Body text.");
    }

    #[test]
    fn falls_back_to_folder_name_without_frontmatter() {
        let (name, description, body) = parse_frontmatter("# Just markdown\n", "my-skill");
        assert_eq!(name, "my-skill");
        assert!(description.is_empty());
        assert_eq!(body.trim(), "# Just markdown");
    }

    /// A throwaway directory tree, removed when the test ends.
    struct Fixture(PathBuf);

    impl Fixture {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mz-skillpacks-{tag}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, rel: &str, body: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const SKILL_MD: &str = "---\nname: impeccable\ndescription: Design help.\n---\n\nSee reference/polish.md\n";

    #[test]
    fn finds_packs_in_every_supported_layout() {
        let fx = Fixture::new("layouts");
        // The three shapes a root can take: a harness install, a bare skills
        // dir, and a folder of skill folders.
        fx.write(".claude/skills/impeccable/SKILL.md", SKILL_MD);
        fx.write("skills/hyperframes/SKILL.md", "---\nname: hyperframes\n---\nbody");
        fx.write("loose-skill/SKILL.md", "# no frontmatter");

        let names: Vec<String> = scan_root(&fx.0).into_iter().map(|p| p.name).collect();
        assert!(names.contains(&"impeccable".to_string()), "{names:?}");
        assert!(names.contains(&"hyperframes".to_string()), "{names:?}");
        assert!(names.contains(&"loose-skill".to_string()), "{names:?}");
    }

    #[test]
    fn ignores_directories_without_a_skill_md() {
        let fx = Fixture::new("empty");
        fx.write("skills/not-a-skill/README.md", "nope");
        assert!(scan_root(&fx.0).is_empty());
    }

    #[test]
    fn reads_a_sub_file_including_the_harness_prefixed_path() {
        let fx = Fixture::new("subfile");
        fx.write(".claude/skills/impeccable/SKILL.md", SKILL_MD);
        fx.write(".claude/skills/impeccable/reference/polish.md", "polish steps");
        let dir = fx.0.join(".claude/skills/impeccable");

        assert_eq!(read_file(&dir, "reference/polish.md").unwrap(), "polish steps");
        // The form a SKILL.md actually writes inline, resolved to the same file.
        assert_eq!(
            read_file(&dir, ".claude/skills/impeccable/reference/polish.md").unwrap(),
            "polish steps"
        );
        assert_eq!(read_file(&dir, "reference\\polish.md").unwrap(), "polish steps");
    }

    #[test]
    fn refuses_to_read_outside_the_pack() {
        let fx = Fixture::new("escape");
        fx.write("skills/x/SKILL.md", SKILL_MD);
        fx.write("secret.txt", "private");
        let dir = fx.0.join("skills/x");
        assert!(read_file(&dir, "../../secret.txt").is_err());
        assert!(read_file(&dir, "nope.md").is_err());
    }

    #[test]
    fn lists_files_relative_to_the_pack() {
        let fx = Fixture::new("listing");
        fx.write("skills/x/SKILL.md", SKILL_MD);
        fx.write("skills/x/reference/a.md", "a");
        fx.write("skills/x/scripts/run.mjs", "//");
        fx.write("skills/x/node_modules/dep/index.js", "//");

        let files = list_files(&fx.0.join("skills/x"));
        assert_eq!(files, vec!["SKILL.md", "reference/a.md", "scripts/run.mjs"]);
    }

    #[test]
    fn allowed_tools_list_does_not_leak_into_description() {
        let raw = "---\nname: x\ndescription: Short.\nallowed-tools:\n  - Bash(ls)\n---\nbody";
        let (_, description, _) = parse_frontmatter(raw, "x");
        assert_eq!(description, "Short.");
    }
}

