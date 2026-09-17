//! Instruction files a project carries (0.14.5).
//!
//! Our own project memory is good, and it is entirely private to us: a snippet
//! typed into the project editor, injected into every chat on that project.
//! Most repositories an agent is pointed at already carry the same thing under
//! a name the rest of the world agreed on — `AGENTS.md`, or `CLAUDE.md` — and
//! until now we walked straight past it. A file whose entire purpose is to tell
//! an agent how to work in this repository is the cheapest context there is,
//! and seven agents rediscovering its contents one mistake at a time is the
//! expensive alternative.
//!
//! Two shapes, and the split between them is what each is good at:
//!
//! * **Root instructions** — read at the top of the tree and injected into the
//!   system prompt for every turn in that project. These are the standing facts:
//!   how the tests are run, which package manager, what never to touch.
//! * **Path-triggered rules** — an `AGENTS.md` deeper in the tree, injected the
//!   first time a file under its directory is read. `src/generated/` having its
//!   own rule is common and useful; putting every such rule in the base prompt
//!   would spend the context budget on directories the turn never visits.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Filenames read as instructions, in the order they are emitted.
///
/// Both, not one: a repository that carries both usually means them as one
/// document (`CLAUDE.md` is very often a symlink to `AGENTS.md`), and where it
/// does not, dropping either is dropping instructions the user wrote down.
/// Identical content is emitted once — see `read_dir_instructions`.
pub const INSTRUCTION_FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

/// Total characters of instruction text injected before it is cut.
///
/// Generous, because this is the *good* kind of context and a repository that
/// wrote 20k characters of agent instructions meant them. Not unbounded,
/// because it is re-sent on every step of every turn and a runaway file would
/// otherwise be a silent, permanent tax on the context budget.
const MAX_INSTRUCTION_CHARS: usize = 20_000;

/// One instruction file that was found.
#[derive(Debug, Clone, PartialEq)]
pub struct InstructionFile {
    pub path: PathBuf,
    pub text: String,
}

/// The instruction files governing a working directory, outermost first.
///
/// The walk goes up from the working directory and **stops at the repository
/// root** — the first ancestor holding a `.git`, inclusive. Walking further is
/// how a stray `CLAUDE.md` in a home directory ends up in the prompt of every
/// project underneath it, which is a surprise nobody asked for and one that is
/// very hard to notice from inside a chat. Where there is no repository, the
/// working directory alone is read.
///
/// Outermost first so the nearest file is read last: instructions are read in
/// order and the most specific one should be the one still in mind at the end.
pub fn collect(working_dir: &Path) -> Vec<InstructionFile> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut cur = working_dir.to_path_buf();
    loop {
        let at_repo_root = cur.join(".git").exists();
        dirs.push(cur.clone());
        if at_repo_root {
            break;
        }
        match cur.parent() {
            Some(p) if p != cur => cur = p.to_path_buf(),
            _ => {
                // No repository anywhere above: the working directory alone.
                dirs.truncate(1);
                break;
            }
        }
    }

    dirs.reverse();
    dirs.iter().flat_map(|d| read_dir_instructions(d)).collect()
}

/// The instruction files directly in one directory.
///
/// Byte-identical files are collapsed to the first, since `CLAUDE.md` beside an
/// identical `AGENTS.md` is one document with two names — sending it twice
/// would pay for it twice and read to the model as emphasis that nobody wrote.
pub fn read_dir_instructions(dir: &Path) -> Vec<InstructionFile> {
    let mut out: Vec<InstructionFile> = Vec::new();
    for name in INSTRUCTION_FILES {
        let path = dir.join(name);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let text = text.trim().to_string();
        if text.is_empty() || out.iter().any(|f| f.text == text) {
            continue;
        }
        out.push(InstructionFile { path, text });
    }
    out
}

/// The system-prompt block for a project's root instructions, or `None` when it
/// carries none.
pub fn block(working_dir: &Path) -> Option<String> {
    render(&collect(working_dir), Header::Root)
}

/// Which sentence introduces a set of instruction files.
#[derive(Clone, Copy)]
pub enum Header {
    /// Injected into the system prompt for the whole session.
    Root,
    /// Delivered mid-turn, the first time a file under the directory is read.
    Triggered,
}

/// Render instruction files into one block, truncating at the budget.
///
/// The preamble is deliberate about precedence, because the model is about to
/// be handed instructions from a third party — whoever wrote the repository —
/// and needs to know where they sit relative to the user in front of it. They
/// outrank its own habits; they do not outrank the person asking.
pub fn render(files: &[InstructionFile], header: Header) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let mut out = String::from(match header {
        Header::Root => {
            "# Project instructions\n\nThis project carries instruction files written for agents \
             working in it. Treat them as standing instructions from the user: they outrank your \
             own defaults and habits. They do not outrank what the user asks for in this \
             conversation — where the two conflict, follow the user and say that the project file \
             says otherwise.\n"
        }
        Header::Triggered => {
            "# Directory instructions\n\nYou have just read a file in a directory that carries its \
             own instructions. They apply to work in that directory, on top of the project's \
             instructions, and for the rest of this turn and the ones after it.\n"
        }
    });

    let mut budget = MAX_INSTRUCTION_CHARS;
    let mut cut: Vec<String> = Vec::new();
    for f in files {
        let name = f.path.to_string_lossy();
        if budget == 0 {
            cut.push(name.to_string());
            continue;
        }
        // Truncating mid-sentence is better than dropping the file silently, so
        // long as the cut says so — an instruction file that stops halfway with
        // no note reads as a complete document that simply ends oddly.
        let (text, clipped) = if f.text.chars().count() > budget {
            (f.text.chars().take(budget).collect::<String>(), true)
        } else {
            (f.text.clone(), false)
        };
        budget -= text.chars().count();
        out.push_str(&format!("\n## {name}\n\n{text}\n"));
        if clipped {
            out.push_str("\n…(cut here: this project's instructions exceed the space kept for them)\n");
        }
    }
    if !cut.is_empty() {
        out.push_str(&format!(
            "\nNot included, for the same reason: {}. Read them with `read` if the work goes \
             near what they cover.\n",
            cut.join(", ")
        ));
    }
    Some(out)
}

/// Tools whose arguments name one file the model is working on, and therefore
/// a directory whose conventions have just become relevant.
///
/// Reads and writes, not searches: `glob` sweeping a tree is not the
/// model deciding to work in a directory, and treating it as such would fire
/// every rule in the repository on one glob.
const TRIGGERING_TOOLS: [&str; 3] = ["read", "edit", "write"];

/// Instructions for the directory a tool call just touched, the first time it
/// is touched.
///
/// `seen` is this turn's record of which directories have already been
/// answered for — including the ones that turned out to carry nothing, so a
/// model working through twenty files in one folder pays for the lookup once.
///
/// Only directories strictly *below* the working directory are considered:
/// everything at or above it is already in the system prompt, and repeating it
/// mid-turn would spend context to say something the model has been told and
/// tell it, by implication, that this copy matters more.
pub fn triggered(
    tool: &str,
    arguments: &str,
    working_dir: Option<&str>,
    seen: &mut HashSet<PathBuf>,
) -> Option<String> {
    if !TRIGGERING_TOOLS.contains(&tool) {
        return None;
    }
    let root = PathBuf::from(working_dir.map(str::trim).filter(|d| !d.is_empty())?);
    let raw = serde_json::from_str::<serde_json::Value>(arguments)
        .ok()?
        .get("path")?
        .as_str()?
        .trim()
        .to_string();
    let file = crate::tools::filesystem::resolve_path(&raw, working_dir);

    // Outermost first, matching `collect`, and stopping at the working
    // directory: a file two folders down picks up both folders' rules in the
    // order a person would read them.
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut cur = file.parent()?.to_path_buf();
    while cur != root && cur.starts_with(&root) {
        dirs.push(cur.clone());
        match cur.parent() {
            Some(p) if p != cur => cur = p.to_path_buf(),
            _ => break,
        }
    }
    dirs.reverse();

    let mut files: Vec<InstructionFile> = Vec::new();
    for dir in dirs {
        if !seen.insert(dir.clone()) {
            continue;
        }
        files.extend(read_dir_instructions(&dir));
    }
    render(&files, Header::Triggered)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temporary tree that cleans itself up. The behaviour under test is
    /// filesystem behaviour, so a mock of it would prove nothing.
    struct Tree(PathBuf);

    impl Tree {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("mz-instructions-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn dir(&self, rel: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(&p).unwrap();
            p
        }
        fn write(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.0.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, content).unwrap();
            p
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn an_agents_file_in_the_working_directory_is_read() {
        let t = Tree::new("basic");
        t.write("AGENTS.md", "Use pnpm, never npm.");
        let found = collect(&t.0);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "Use pnpm, never npm.");
        assert!(block(&t.0).unwrap().contains("Use pnpm, never npm."));
    }

    #[test]
    fn a_directory_with_no_instructions_produces_no_block() {
        let t = Tree::new("empty");
        t.dir("src");
        assert!(block(&t.0).is_none());
    }

    /// Both names are read, because a repository that carries both and made
    /// them differ meant both.
    #[test]
    fn both_names_are_read_when_they_differ() {
        let t = Tree::new("both");
        t.write("AGENTS.md", "Run cargo test.");
        t.write("CLAUDE.md", "Never push to main.");
        let found = collect(&t.0);
        assert_eq!(found.len(), 2);
    }

    /// …and collapsed when they do not. `CLAUDE.md` beside an identical
    /// `AGENTS.md` is one document with two names.
    #[test]
    fn identical_files_are_emitted_once() {
        let t = Tree::new("dup");
        t.write("AGENTS.md", "Run cargo test.");
        t.write("CLAUDE.md", "Run cargo test.");
        assert_eq!(collect(&t.0).len(), 1);
    }

    /// A working directory inside a repository still gets the repository's own
    /// instructions, which is where they almost always live.
    #[test]
    fn the_walk_reaches_the_repository_root() {
        let t = Tree::new("walkup");
        t.dir(".git");
        t.write("AGENTS.md", "Root rules.");
        let sub = t.dir("crates/inner");
        let found = collect(&sub);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "Root rules.");
    }

    /// Outermost first, so the nearest instructions are the last thing read.
    #[test]
    fn the_nearest_file_is_read_last() {
        let t = Tree::new("order");
        t.dir(".git");
        t.write("AGENTS.md", "Root rules.");
        t.write("crates/inner/AGENTS.md", "Inner rules.");
        let found = collect(&t.0.join("crates/inner"));
        assert_eq!(
            found.iter().map(|f| f.text.as_str()).collect::<Vec<_>>(),
            ["Root rules.", "Inner rules."]
        );
    }

    /// The walk stops at the repository root. Anything above it belongs to
    /// whoever owns that directory, not to this project — a stray `CLAUDE.md`
    /// in a home directory must not end up in the prompt of every project
    /// underneath it.
    #[test]
    fn the_walk_stops_at_the_repository_root() {
        let t = Tree::new("boundary");
        t.write("CLAUDE.md", "Everything above the repo.");
        let repo = t.dir("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        t.write("repo/AGENTS.md", "Repo rules.");
        let found = collect(&repo);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].text, "Repo rules.");
    }

    /// With no repository at all, only the working directory is read — the walk
    /// must not fall back to climbing to the filesystem root.
    #[test]
    fn without_a_repository_only_the_working_directory_is_read() {
        let t = Tree::new("norepo");
        t.write("AGENTS.md", "Outer.");
        let sub = t.dir("sub");
        std::fs::write(sub.join("AGENTS.md"), "Inner.").unwrap();
        let found = collect(&sub);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "Inner.");
    }

    /// A runaway file is cut rather than allowed to become a permanent tax on
    /// every step of every turn — and the cut says so, because instructions
    /// that stop halfway with no note read as a document that merely ends oddly.
    #[test]
    fn an_enormous_file_is_cut_and_says_so() {
        let t = Tree::new("huge");
        t.write("AGENTS.md", &"x".repeat(MAX_INSTRUCTION_CHARS + 5_000));
        let block = block(&t.0).unwrap();
        assert!(block.contains("cut here"), "no note about the cut");
        assert!(block.len() < MAX_INSTRUCTION_CHARS + 2_000);
    }

    /// Once the budget is gone, later files are named rather than silently
    /// dropped: "there are instructions you have not been shown" is exactly the
    /// thing a model cannot work out for itself.
    #[test]
    fn files_past_the_budget_are_named() {
        let t = Tree::new("named");
        t.write("AGENTS.md", &"x".repeat(MAX_INSTRUCTION_CHARS));
        t.write("CLAUDE.md", "The second one.");
        let block = block(&t.0).unwrap();
        assert!(block.contains("Not included"), "{}", &block[block.len() - 300..]);
        assert!(block.contains("CLAUDE.md"));
        assert!(!block.contains("The second one."));
    }

    /// An empty or whitespace-only file is not instructions.
    #[test]
    fn an_empty_file_is_not_instructions() {
        let t = Tree::new("blank");
        t.write("AGENTS.md", "   \n\n");
        assert!(block(&t.0).is_none());
    }

    // ── Path-triggered rules ─────────────────────────────────────────────────

    fn read(path: &str) -> String {
        serde_json::json!({ "path": path }).to_string()
    }

    #[test]
    fn reading_a_file_fires_its_directorys_rules() {
        let t = Tree::new("trigger");
        t.write("src/generated/AGENTS.md", "Never edit these by hand.");
        let dir = t.0.to_string_lossy().to_string();
        let mut seen = HashSet::new();
        let note = triggered("read", &read("src/generated/api.ts"), Some(&dir), &mut seen)
            .expect("expected the directory's rules");
        assert!(note.contains("Never edit these by hand."));
        assert!(note.contains("Directory instructions"));
    }

    /// The point of the mechanism: it fires once. A model working through
    /// twenty files in one folder is not told the same thing twenty times.
    #[test]
    fn a_directory_fires_only_once_per_turn() {
        let t = Tree::new("once");
        t.write("src/generated/AGENTS.md", "Never edit these by hand.");
        let dir = t.0.to_string_lossy().to_string();
        let mut seen = HashSet::new();
        assert!(triggered("read", &read("src/generated/a.ts"), Some(&dir), &mut seen).is_some());
        assert!(triggered("read", &read("src/generated/b.ts"), Some(&dir), &mut seen).is_none());
    }

    /// A directory with no rules is remembered too, so twenty reads of an
    /// ordinary folder cost one lookup rather than twenty.
    #[test]
    fn a_directory_without_rules_is_remembered_as_well() {
        let t = Tree::new("nothing");
        t.dir("src");
        let dir = t.0.to_string_lossy().to_string();
        let mut seen = HashSet::new();
        assert!(triggered("read", &read("src/a.ts"), Some(&dir), &mut seen).is_none());
        assert!(seen.contains(&t.0.join("src")));
    }

    /// The root file is already in the system prompt. Repeating it mid-turn
    /// would spend context saying something the model has been told, and imply
    /// that this copy of it matters more.
    #[test]
    fn the_working_directorys_own_rules_do_not_fire_again() {
        let t = Tree::new("noroot");
        t.write("AGENTS.md", "Root rules.");
        let dir = t.0.to_string_lossy().to_string();
        let mut seen = HashSet::new();
        assert!(triggered("read", &read("a.ts"), Some(&dir), &mut seen).is_none());
    }

    /// Nested directories fire in reading order, outermost first.
    #[test]
    fn nested_directories_fire_outermost_first() {
        let t = Tree::new("nested");
        t.write("src/AGENTS.md", "Src rules.");
        t.write("src/generated/AGENTS.md", "Generated rules.");
        let dir = t.0.to_string_lossy().to_string();
        let mut seen = HashSet::new();
        let note = triggered("read", &read("src/generated/a.ts"), Some(&dir), &mut seen).unwrap();
        let src = note.find("Src rules.").expect("src rules missing");
        let gen = note.find("Generated rules.").expect("generated rules missing");
        assert!(src < gen, "the nearer rules should be read last");
    }

    /// A sweep over the tree is not the model deciding to work in a directory.
    #[test]
    fn a_search_does_not_fire_every_rule_in_the_repository() {
        let t = Tree::new("sweep");
        t.write("src/generated/AGENTS.md", "Never edit these by hand.");
        let dir = t.0.to_string_lossy().to_string();
        let mut seen = HashSet::new();
        assert!(triggered("glob", &read("src/generated/a.ts"), Some(&dir), &mut seen).is_none());
        assert!(triggered("grep", &read("src/generated/a.ts"), Some(&dir), &mut seen).is_none());
    }

    /// A path outside the working directory has no directory chain to walk,
    /// and inventing one would read a file the project never claimed.
    #[test]
    fn a_file_outside_the_working_directory_fires_nothing() {
        let t = Tree::new("outside");
        t.write("elsewhere/AGENTS.md", "Not this project's rules.");
        let inside = t.dir("project");
        let dir = inside.to_string_lossy().to_string();
        let mut seen = HashSet::new();
        let path = t.0.join("elsewhere/a.ts").to_string_lossy().to_string();
        assert!(triggered("read", &read(&path), Some(&dir), &mut seen).is_none());
    }
}
