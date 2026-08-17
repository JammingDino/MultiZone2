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
            "\nNot included, for the same reason: {}. Read them with `read_file` if the work goes \
             near what they cover.\n",
            cut.join(", ")
        ));
    }
    Some(out)
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
}
