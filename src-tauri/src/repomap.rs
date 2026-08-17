//! Repository map (0.14.5) — what is in this codebase, ranked by how much the
//! rest of it depends on each thing.
//!
//! An agent dropped into an unfamiliar repository spends its first several
//! steps finding out where things are: list a directory, read a file, search
//! for a name, read another file. That cost is paid once per agent, and a panel
//! of seven pays it seven times, in parallel, to arrive at the same answer.
//!
//! The map is a fixed-size answer to that: every file's definitions, ranked so
//! that the ones the codebase leans on hardest are the ones that fit, rendered
//! into a token budget and injected at session start.
//!
//! **Ranking is the whole idea.** An alphabetical dump of 4,000 symbols is
//! worse than nothing — it costs the context budget and buries the ten names
//! that matter. So the map is built as a graph: a file that mentions a symbol
//! defined elsewhere is a reference, references are edges, and PageRank over
//! that graph says which definitions the codebase is actually organised around.
//! It is the same reason PageRank worked on the web — being referenced by
//! something that is itself referenced counts for more than being referenced by
//! something nothing points at.
//!
//! **On extraction.** The plan called for tree-sitter. This uses per-language
//! line patterns instead, and the trade is worth naming: tree-sitter parses
//! precisely, at the cost of a C grammar per language — `tree-sitter-typescript`
//! alone is tens of megabytes of generated C on every clean build, in a repo
//! that has already moved its CI onto the development machine to keep the edit
//! loop short. Line patterns miss things a parser would catch (a definition
//! wrapped mid-line, an unusual macro), and the failure mode of missing one is
//! that a symbol ranks lower than it deserves — the map is a map, not an
//! index, and nothing downstream treats it as exhaustive. `definitions` is one
//! function and one enum; swapping a parser in behind it is a contained change
//! if the accuracy ever proves insufficient.

use serde::Serialize;
use sqlx::SqlitePool;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// Tokens of map injected into the system prompt, when the user has not chosen.
///
/// About a page. Enough for the shape of a project — its main modules and what
/// they are called — and not so much that it competes with the conversation.
pub const DEFAULT_TOKEN_BUDGET: usize = 1_000;

/// Rough characters per token. The map is mostly identifiers and punctuation,
/// which tokenize worse than prose, so this is deliberately conservative: an
/// over-estimate spends less of the budget than the user asked for, which is
/// the safe direction to be wrong in.
const CHARS_PER_TOKEN: usize = 3;

/// Files walked before the scan gives up. A repository larger than this has
/// other problems, and a map built from a truncated walk is still a map.
const MAX_FILES: usize = 6_000;

/// Files above this are skipped: generated bundles, checked-in minified
/// libraries, and data files masquerading as source. Their definitions are not
/// what anyone means by "what is in this project".
const MAX_FILE_BYTES: u64 = 512 * 1024;

/// Definitions kept per file. A 200-symbol file contributes its top few; the
/// long tail is what the ranking exists to leave out.
const MAX_DEFS_PER_FILE: usize = 12;

/// How long a map is served after the tree it was built from has moved on.
///
/// An agent working in a repository changes it constantly, and rebuilding on
/// every change would move the system prompt on every turn — which costs the
/// provider's prefix cache for the whole conversation behind it, to reflect one
/// function appearing in one file. Ten minutes keeps the map stable across a
/// working session and current across days.
const REFRESH_COOLDOWN_SECS: i64 = 600;

/// One definition found in a file.
#[derive(Debug, Clone, PartialEq)]
pub struct Def {
    pub name: String,
    /// How it is written back out — `fn`, `struct`, `class`. The keyword the
    /// language uses, so the map reads like the code.
    pub kind: &'static str,
}

/// A source file and what it defines.
#[derive(Debug, Clone)]
struct FileDefs {
    rel: String,
    defs: Vec<Def>,
}

/// The map, plus what it was built from — the counts are what the settings
/// panel shows so "a repo map" is not an opaque line in the context meter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoMap {
    pub text: String,
    pub files: usize,
    pub symbols: usize,
}

// ── Languages ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lang {
    Rust,
    /// TypeScript, TSX, JavaScript, JSX — one dialect for this purpose.
    Web,
    Python,
    Go,
    /// C, C++, C#, Java, Kotlin, Swift: brace languages whose type and function
    /// declarations share enough shape to be read by one set of patterns.
    Brace,
}

fn lang_of(path: &Path) -> Option<Lang> {
    Some(match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "rs" => Lang::Rust,
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "svelte" | "vue" => Lang::Web,
        "py" | "pyi" => Lang::Python,
        "go" => Lang::Go,
        "c" | "h" | "cc" | "cpp" | "hpp" | "cs" | "java" | "kt" | "swift" | "m" => Lang::Brace,
        _ => return None,
    })
}

/// The patterns that find a definition, per language.
///
/// Anchored at the start of a line (leading whitespace allowed) because that is
/// where declarations live in every language here, and an unanchored pattern
/// turns every mention of `fn` inside a string into a symbol.
struct Pattern {
    re: regex::Regex,
    kind: &'static str,
}

fn patterns(lang: Lang) -> &'static [Pattern] {
    macro_rules! pats {
        ($($kind:literal => $re:literal),* $(,)?) => {
            Box::leak(Box::new(vec![
                $(Pattern { re: regex::Regex::new($re).unwrap(), kind: $kind }),*
            ])).as_slice()
        };
    }
    static RUST: LazyLock<&'static [Pattern]> = LazyLock::new(|| {
        pats![
            "fn"     => r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+\x22[^\x22]*\x22\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)",
            "struct" => r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)",
            "enum"   => r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)",
            "trait"  => r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)",
            "type"   => r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_][A-Za-z0-9_]*)",
            "const"  => r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Z_][A-Z0-9_]*)",
            "macro"  => r"(?m)^\s*macro_rules!\s+([A-Za-z_][A-Za-z0-9_]*)",
        ]
    });
    static WEB: LazyLock<&'static [Pattern]> = LazyLock::new(|| {
        pats![
            "function"  => r"(?m)^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)",
            "class"     => r"(?m)^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            "interface" => r"(?m)^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            "type"      => r"(?m)^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            "enum"      => r"(?m)^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            // Only at column zero, and only `const`: an indented `let` is a
            // local variable, and a map full of locals is a map of nothing.
            "const"     => r"(?m)^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)",
        ]
    });
    static PYTHON: LazyLock<&'static [Pattern]> = LazyLock::new(|| {
        pats![
            "def"   => r"(?m)^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)",
            "class" => r"(?m)^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)",
        ]
    });
    static GO: LazyLock<&'static [Pattern]> = LazyLock::new(|| {
        pats![
            "func" => r"(?m)^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)",
            "type" => r"(?m)^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)",
        ]
    });
    static BRACE: LazyLock<&'static [Pattern]> = LazyLock::new(|| {
        pats![
            "class"  => r"(?m)^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|open|data)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)",
            "struct" => r"(?m)^\s*(?:(?:public|private|protected|internal|static|typedef)\s+)*struct\s+([A-Za-z_][A-Za-z0-9_]*)",
            "interface" => r"(?m)^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+([A-Za-z_][A-Za-z0-9_]*)",
            "enum"   => r"(?m)^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+(?:class\s+)?([A-Za-z_][A-Za-z0-9_]*)",
            "func"   => r"(?m)^\s*(?:(?:public|private|protected|internal|static|final|override|open|suspend|inline)\s+)*fun\s+([A-Za-z_][A-Za-z0-9_]*)",
            "define" => r"(?m)^\s*#define\s+([A-Za-z_][A-Za-z0-9_]*)",
        ]
    });
    match lang {
        Lang::Rust => *RUST,
        Lang::Web => *WEB,
        Lang::Python => *PYTHON,
        Lang::Go => *GO,
        Lang::Brace => *BRACE,
    }
}

/// Every definition one file's text declares, in the order they appear.
///
/// Deliberately not deduplicated across kinds: Rust's `struct Foo` beside
/// `impl Foo` is one name, and a name declared twice in one file (a trait
/// method and its implementation) should not count as two symbols.
pub fn definitions(path: &Path, text: &str) -> Vec<Def> {
    let Some(lang) = lang_of(path) else {
        return Vec::new();
    };
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<Def> = Vec::new();
    for p in patterns(lang) {
        for caps in p.re.captures_iter(text) {
            let Some(name) = caps.get(1).map(|m| m.as_str()) else {
                continue;
            };
            // One- and two-character names carry no information in a map and
            // collide with everything when references are counted.
            if name.len() < 3 || !seen.insert(name.to_string()) {
                continue;
            }
            out.push(Def { name: name.to_string(), kind: p.kind });
        }
    }
    out
}

/// Identifiers appearing in a file, with how often. The reference side of the
/// graph: a name here that is defined somewhere else is an edge.
fn identifiers(text: &str) -> HashMap<&str, usize> {
    static WORD: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"[A-Za-z_$][A-Za-z0-9_$]{2,}").unwrap());
    let mut out: HashMap<&str, usize> = HashMap::new();
    for m in WORD.find_iter(text) {
        *out.entry(m.as_str()).or_insert(0) += 1;
    }
    out
}

// ── Scanning ────────────────────────────────────────────────────────────────

/// One file as the walk saw it, before anything is read.
struct Entry {
    path: PathBuf,
    rel: String,
    size: u64,
    mtime: u64,
}

/// Walk the tree, collecting source files and their metadata.
///
/// Metadata only, because that is what the cache signature is made of: a walk
/// is milliseconds and reading several thousand files is not, so an unchanged
/// repository must be recognisable without reading any of it.
fn walk(root: &Path) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= MAX_FILES {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                // Hidden directories as well as the named ones: `.venv`,
                // `.next` and friends are where a scan goes to die, and no
                // dot-directory holds the code a person means by "this project".
                if name.starts_with('.') || crate::tools::filesystem::SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if lang_of(&path).is_none() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_FILE_BYTES {
                continue;
            }
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push(Entry { path, rel, size: meta.len(), mtime });
            if out.len() >= MAX_FILES {
                break;
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

/// A cheap fingerprint of the tree: which files exist, how big they are, and
/// when they last changed. Two scans with the same signature would produce the
/// same map, so the second one does not have to happen.
fn signature(entries: &[Entry]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for e in entries {
        h.update(e.rel.as_bytes());
        h.update(e.size.to_le_bytes());
        h.update(e.mtime.to_le_bytes());
    }
    format!("{:x}", h.finalize())
}

// ── Ranking ─────────────────────────────────────────────────────────────────

/// PageRank over the file reference graph.
///
/// `edges[i]` is the files file *i* refers to, with how many distinct mentions.
/// Damping 0.85 and 20 iterations, which is where this converges for graphs of
/// this size; there is no need for a convergence test on a computation that
/// takes milliseconds and is cached afterwards.
///
/// A file that references nothing (a leaf, a config module) distributes its
/// rank evenly rather than losing it — otherwise rank drains out of the graph
/// through every dead end and the scores stop being comparable.
fn pagerank(edges: &[HashMap<usize, usize>], n: usize) -> Vec<f64> {
    const DAMPING: f64 = 0.85;
    const ITERATIONS: usize = 20;
    if n == 0 {
        return Vec::new();
    }
    let mut rank = vec![1.0 / n as f64; n];
    for _ in 0..ITERATIONS {
        let mut next = vec![(1.0 - DAMPING) / n as f64; n];
        let mut dangling = 0.0;
        for (i, out) in edges.iter().enumerate() {
            let total: usize = out.values().sum();
            if total == 0 {
                dangling += rank[i];
                continue;
            }
            for (&j, &w) in out {
                next[j] += DAMPING * rank[i] * (w as f64 / total as f64);
            }
        }
        let spread = DAMPING * dangling / n as f64;
        for r in next.iter_mut() {
            *r += spread;
        }
        rank = next;
    }
    rank
}

// ── Building ────────────────────────────────────────────────────────────────

/// Build the map for a directory. Synchronous and CPU-bound — call it from a
/// blocking task.
pub fn build(root: &Path, token_budget: usize) -> Option<RepoMap> {
    let entries = walk(root);
    if entries.is_empty() {
        return None;
    }
    build_from(&entries, token_budget)
}

fn build_from(entries: &[Entry], token_budget: usize) -> Option<RepoMap> {
    // Read once. Everything below works off these strings.
    let texts: Vec<String> = entries
        .iter()
        .map(|e| std::fs::read_to_string(&e.path).unwrap_or_default())
        .collect();

    let files: Vec<FileDefs> = entries
        .iter()
        .zip(&texts)
        .map(|(e, text)| FileDefs { rel: e.rel.clone(), defs: definitions(&e.path, text) })
        .collect();

    // name → the files defining it. A name defined in several files (a `new`
    // method, a `Config` struct per module) is genuinely ambiguous, and
    // splitting the reference across its definers is the honest handling: it
    // is evidence for each of them, and weaker evidence than a unique name.
    let mut defined_in: HashMap<&str, Vec<usize>> = HashMap::new();
    for (i, f) in files.iter().enumerate() {
        for d in &f.defs {
            defined_in.entry(d.name.as_str()).or_default().push(i);
        }
    }

    let mut edges: Vec<HashMap<usize, usize>> = vec![HashMap::new(); files.len()];
    // How often each symbol is referred to from a file that does not define it.
    let mut symbol_refs: HashMap<&str, usize> = HashMap::new();
    for (i, text) in texts.iter().enumerate() {
        for (word, count) in identifiers(text) {
            let Some(owners) = defined_in.get(word) else {
                continue;
            };
            // A file mentioning its own definitions is not a dependency.
            if owners.contains(&i) {
                continue;
            }
            *symbol_refs.entry(word).or_insert(0) += count;
            for &owner in owners {
                *edges[i].entry(owner).or_insert(0) += count;
            }
        }
    }

    let rank = pagerank(&edges, files.len());
    let mut order: Vec<usize> = (0..files.len()).filter(|&i| !files[i].defs.is_empty()).collect();
    order.sort_by(|&a, &b| {
        rank[b]
            .partial_cmp(&rank[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            // Ties broken by path, so the same repository always renders the
            // same map — a system prompt that differs between two identical
            // scans is a prefix cache thrown away for nothing.
            .then_with(|| files[a].rel.cmp(&files[b].rel))
    });

    render(&files, &order, &symbol_refs, token_budget)
}

fn render(
    files: &[FileDefs],
    order: &[usize],
    symbol_refs: &HashMap<&str, usize>,
    token_budget: usize,
) -> Option<RepoMap> {
    let header = "# Repository map\n\nThe definitions this project is organised around, ranked by \
                  how much of the rest of the code refers to them. Names only — read a file when \
                  you need a body. This is a map rather than an index: a symbol missing from it is \
                  less connected than the ones here, not absent from the project.\n\n";
    let budget = token_budget.saturating_mul(CHARS_PER_TOKEN);
    let mut body = String::new();
    let mut shown_files = 0usize;
    let mut shown_symbols = 0usize;

    for &i in order {
        let f = &files[i];
        let mut defs: Vec<&Def> = f.defs.iter().collect();
        defs.sort_by_key(|d| std::cmp::Reverse(symbol_refs.get(d.name.as_str()).copied().unwrap_or(0)));
        defs.truncate(MAX_DEFS_PER_FILE);

        let mut chunk = format!("{}\n", f.rel);
        for d in &defs {
            chunk.push_str(&format!("  {} {}\n", d.kind, d.name));
        }
        if body.len() + chunk.len() > budget {
            // Stop at the first file that does not fit rather than skipping it
            // for a smaller one further down: the order is the ranking, and
            // reordering it to pack the budget would quietly promote small
            // files over important ones.
            break;
        }
        body.push_str(&chunk);
        shown_files += 1;
        shown_symbols += defs.len();
    }

    if shown_symbols == 0 {
        return None;
    }
    let omitted = order.len().saturating_sub(shown_files);
    let mut text = format!("{header}{body}");
    if omitted > 0 {
        text.push_str(&format!(
            "\n…and {omitted} more files, less referenced than these. Use `find_files` and \
             `search_file_text` for anything not listed.\n"
        ));
    }
    Some(RepoMap { text, files: shown_files, symbols: shown_symbols })
}

// ── Cache ───────────────────────────────────────────────────────────────────

/// The map for a working directory, built if the tree has changed since last
/// time and read from the cache if it has not.
///
/// The walk still happens on every call — it is milliseconds and it is what
/// decides whether anything changed. What the cache saves is reading and
/// parsing several thousand files, which is the part that would otherwise be
/// paid at the start of every session.
pub async fn cached(db: &SqlitePool, root: &Path, token_budget: usize) -> Option<RepoMap> {
    if token_budget == 0 {
        return None;
    }
    let key = root.to_string_lossy().to_string();
    let root = root.to_path_buf();
    let budget = token_budget;

    let scanned = tokio::task::spawn_blocking(move || {
        let entries = walk(&root);
        let sig = signature(&entries);
        (entries, sig)
    })
    .await
    .ok()?;
    let (entries, sig) = scanned;
    if entries.is_empty() {
        return None;
    }

    let hit: Option<(String, i64, String, i64)> = sqlx::query_as(
        "SELECT content, symbols, signature, generated_at FROM repo_maps
          WHERE directory = ?1 AND token_budget = ?2",
    )
    .bind(&key)
    .bind(budget as i64)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    if let Some((content, symbols, cached_sig, generated_at)) = hit {
        // Fresh, or freshly stale. The cooldown is what keeps the map *stable
        // within a session*: an agent editing files changes the signature on
        // almost every turn, and a system prompt that moves on every turn is a
        // provider-side prefix cache thrown away on every turn — for a map
        // whose ranking barely moves when one function is added to one file.
        // The plan's phrase was "injected at session start", and this is what
        // that means in an app with no explicit session boundary.
        let fresh = cached_sig == sig
            || chrono::Utc::now().timestamp() - generated_at < REFRESH_COOLDOWN_SECS;
        if fresh {
            return Some(RepoMap { text: content, files: 0, symbols: symbols as usize });
        }
    }

    let built = tokio::task::spawn_blocking(move || build_from(&entries, budget))
        .await
        .ok()
        .flatten()?;

    let _ = sqlx::query(
        "INSERT INTO repo_maps (directory, signature, token_budget, content, files, symbols, generated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(directory) DO UPDATE SET
             signature = excluded.signature,
             token_budget = excluded.token_budget,
             content = excluded.content,
             files = excluded.files,
             symbols = excluded.symbols,
             generated_at = excluded.generated_at",
    )
    .bind(&key)
    .bind(&sig)
    .bind(budget as i64)
    .bind(&built.text)
    .bind(built.files as i64)
    .bind(built.symbols as i64)
    .bind(chrono::Utc::now().timestamp())
    .execute(db)
    .await;

    Some(built)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tree(PathBuf);

    impl Tree {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("mz-repomap-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn write(&self, rel: &str, content: &str) {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, content).unwrap();
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn names(defs: &[Def]) -> Vec<&str> {
        defs.iter().map(|d| d.name.as_str()).collect()
    }

    #[test]
    fn rust_declarations_are_found() {
        let defs = definitions(
            Path::new("a.rs"),
            "pub struct Policy {}\n\
             pub(crate) async fn resolve_path(x: u8) {}\n\
             enum Decision { Auto }\n\
             pub trait Renderer {}\n\
             pub const MAX_STEPS: usize = 4;\n\
             macro_rules! pats {}\n",
        );
        assert_eq!(
            names(&defs).into_iter().collect::<HashSet<_>>(),
            HashSet::from(["Policy", "resolve_path", "Decision", "Renderer", "MAX_STEPS", "pats"])
        );
    }

    #[test]
    fn typescript_declarations_are_found() {
        let defs = definitions(
            Path::new("a.ts"),
            "export interface ApprovalPolicy {}\n\
             export async function buildSystemSnippets() {}\n\
             export type StreamEvent = never;\n\
             export const DEFAULT_APP_SETTINGS = {};\n\
             class ChatPanel {}\n",
        );
        assert!(names(&defs).contains(&"ApprovalPolicy"));
        assert!(names(&defs).contains(&"buildSystemSnippets"));
        assert!(names(&defs).contains(&"StreamEvent"));
        assert!(names(&defs).contains(&"DEFAULT_APP_SETTINGS"));
        assert!(names(&defs).contains(&"ChatPanel"));
    }

    /// An indented `const` is a local. A map full of locals is a map of nothing.
    #[test]
    fn a_local_variable_is_not_a_definition() {
        let defs = definitions(
            Path::new("a.ts"),
            "export function render() {\n  const helper = 1;\n  return helper;\n}\n",
        );
        assert_eq!(names(&defs), ["render"]);
    }

    #[test]
    fn python_and_go_declarations_are_found() {
        let py = definitions(Path::new("a.py"), "class Trainer:\n    def fit(self):\n        pass\n");
        assert_eq!(names(&py).into_iter().collect::<HashSet<_>>(), HashSet::from(["Trainer", "fit"]));
        let go = definitions(Path::new("a.go"), "func (s *Server) Serve() {}\ntype Config struct{}\n");
        assert_eq!(names(&go).into_iter().collect::<HashSet<_>>(), HashSet::from(["Serve", "Config"]));
    }

    /// A name declared twice in one file is one symbol.
    #[test]
    fn a_name_is_counted_once_per_file() {
        let defs = definitions(Path::new("a.rs"), "struct Foo;\ntype Foo = u8;\n");
        assert_eq!(defs.len(), 1);
    }

    /// The whole point: the file everything refers to comes first, even when it
    /// is small and defines little.
    #[test]
    fn the_most_referenced_file_ranks_first() {
        let t = Tree::new("rank");
        t.write("src/core.rs", "pub struct Engine;\npub fn ignite() {}\n");
        for i in 0..5 {
            t.write(
                &format!("src/user{i}.rs"),
                "fn main() { let e = Engine; ignite(); }\n",
            );
        }
        let map = build(&t.0, 500).expect("expected a map");
        let core = map.text.find("src/core.rs").expect("core.rs missing");
        let user = map.text.find("src/user0.rs").unwrap_or(usize::MAX);
        assert!(core < user, "the referenced file should rank first:\n{}", map.text);
    }

    /// Being referenced by something that is itself referenced counts for more
    /// than being referenced by something nothing points at. This is the only
    /// reason to run PageRank rather than count mentions.
    #[test]
    fn a_reference_from_an_important_file_counts_for_more() {
        // `hub` is referenced by everything; `hub` refers only to `deep`.
        // `shallow` is referenced once, by an isolated file.
        let edges: Vec<HashMap<usize, usize>> = vec![
            HashMap::from([(3, 1)]),          // 0: hub → deep
            HashMap::from([(0, 1)]),          // 1 → hub
            HashMap::from([(0, 1)]),          // 2 → hub
            HashMap::new(),                   // 3: deep
            HashMap::from([(5, 1)]),          // 4 → shallow
            HashMap::new(),                   // 5: shallow
        ];
        let rank = pagerank(&edges, 6);
        assert!(rank[3] > rank[5], "deep {} should outrank shallow {}", rank[3], rank[5]);
    }

    /// A file that refers to nothing must not drain rank out of the graph.
    #[test]
    fn ranks_stay_a_distribution() {
        let edges: Vec<HashMap<usize, usize>> =
            vec![HashMap::from([(1, 1)]), HashMap::new(), HashMap::new()];
        let total: f64 = pagerank(&edges, 3).iter().sum();
        assert!((total - 1.0).abs() < 1e-6, "ranks summed to {total}");
    }

    #[test]
    fn the_budget_is_respected_and_the_remainder_is_named() {
        let t = Tree::new("budget");
        for i in 0..40 {
            t.write(
                &format!("src/mod{i}.rs"),
                &format!("pub struct Thing{i};\npub fn make{i}() {{}}\n"),
            );
        }
        let map = build(&t.0, 60).expect("expected a map");
        assert!(map.text.len() <= 60 * CHARS_PER_TOKEN + 600, "len {}", map.text.len());
        assert!(map.text.contains("more files"), "{}", map.text);
    }

    /// Two scans of an unchanged tree must produce identical bytes, or the
    /// system prompt moves under the provider's prefix cache for no reason.
    #[test]
    fn the_map_is_byte_stable_across_scans() {
        let t = Tree::new("stable");
        t.write("src/a.rs", "pub struct Alpha;\npub fn alpha() {}\n");
        t.write("src/b.rs", "fn use_alpha() { Alpha; alpha(); }\n");
        let first = build(&t.0, 500).unwrap().text;
        let second = build(&t.0, 500).unwrap().text;
        assert_eq!(first, second);
    }

    #[test]
    fn a_tree_with_no_source_produces_no_map() {
        let t = Tree::new("empty");
        t.write("README.md", "# hello");
        t.write("data.csv", "a,b,c");
        assert!(build(&t.0, 500).is_none());
    }

    /// Dependency and build directories are where a scan goes to die, and their
    /// contents are not what anyone means by "what is in this project".
    #[test]
    fn dependency_directories_are_not_walked() {
        let t = Tree::new("skip");
        t.write("src/a.rs", "pub fn mine() {}\n");
        t.write("node_modules/dep/index.js", "export function theirs() {}\n");
        t.write("target/debug/build.rs", "pub fn generated() {}\n");
        t.write(".venv/lib/thing.py", "def vendored(): pass\n");
        let map = build(&t.0, 500).unwrap();
        assert!(map.text.contains("mine"));
        assert!(!map.text.contains("theirs"), "{}", map.text);
        assert!(!map.text.contains("generated"), "{}", map.text);
        assert!(!map.text.contains("vendored"), "{}", map.text);
    }

    /// The signature has to move when a file's content does, or an edited
    /// repository keeps serving yesterday's map.
    #[test]
    fn the_signature_changes_when_a_file_does() {
        let t = Tree::new("sig");
        t.write("src/a.rs", "pub fn one() {}\n");
        let before = signature(&walk(&t.0));
        // Size is part of the signature, so this moves it even where the
        // filesystem's mtime resolution would not.
        t.write("src/a.rs", "pub fn one() {}\npub fn two() {}\n");
        assert_ne!(before, signature(&walk(&t.0)));
    }
}
