//! Diffs, hunks, and applying a chosen subset of them (0.10.2).
//!
//! The approval prompt could only ever show what the model *said* it would do,
//! and for a file write that was a wall of proposed content — the one form in
//! which a change is hardest to judge. Everything here exists to turn a pending
//! `create_file` / `edit_file` into the same thing every code review in the
//! world uses: lines added, lines removed, grouped into hunks that can be taken
//! or left one at a time.
//!
//! Two properties are load-bearing:
//!
//! - **The hunks are the unit of approval, not of display.** [`apply_hunks`]
//!   rebuilds the file from a selection, so "approve the first two hunks" is a
//!   real, executed outcome rather than a note about intent.
//! - **Line-based.** A word-level diff reads better and cannot be applied
//!   safely; the line is the smallest thing that can be swapped without
//!   guessing at syntax.

use serde::{Deserialize, Serialize};
use similar::{ChangeTag, TextDiff};
use std::collections::HashSet;

/// A file past this is summarised rather than diffed. A model does not
/// hand-review a 2 MB minified bundle, and rendering one into the approval
/// prompt would freeze the window it is asking permission in.
pub const MAX_DIFF_BYTES: usize = 1024 * 1024;

/// Lines of unchanged context kept on each side of a change.
const CONTEXT: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// `context` · `add` · `remove`.
    pub kind: String,
    /// 1-based line number on the old side, absent for an addition.
    pub old_line: Option<usize>,
    /// 1-based line number on the new side, absent for a removal.
    pub new_line: Option<usize>,
    pub text: String,
}

/// One contiguous run of changes plus its surrounding context — what a reviewer
/// takes or leaves as a unit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// Position in the file's hunk list; what a selection names.
    pub index: usize,
    /// 0-based first old-side line the hunk covers, and how many it covers.
    /// These are what [`apply_hunks`] splices on, so they describe the whole
    /// hunk — context included.
    pub old_start: usize,
    pub old_len: usize,
    pub new_start: usize,
    pub new_len: usize,
    pub added: usize,
    pub removed: usize,
    pub lines: Vec<DiffLine>,
}

/// A pending change to one path, as the approval prompt shows it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// Absolute, resolved.
    pub path: String,
    /// The path as the model wrote it — what the user recognises.
    pub display_path: String,
    /// `create` (nothing there before) · `modify` · `delete` · `rename`.
    pub change: String,
    pub hunks: Vec<Hunk>,
    pub added: usize,
    pub removed: usize,
    /// Set when there is no diff to show, and why: a binary file, one past
    /// [`MAX_DIFF_BYTES`], or a tool whose change isn't textual (a rename).
    pub note: Option<String>,
}

impl FileDiff {
    fn summary_only(path: String, display_path: String, change: &str, note: String) -> Self {
        FileDiff {
            path,
            display_path,
            change: change.to_string(),
            hunks: Vec::new(),
            added: 0,
            removed: 0,
            note: Some(note),
        }
    }
}

/// Split into lines without their terminators. The trailing newline is carried
/// separately by [`join_lines`], because whether a file ends with one is a real
/// difference that `lines()` erases.
fn split_lines(s: &str) -> Vec<&str> {
    if s.is_empty() {
        return Vec::new();
    }
    s.split('\n')
        .enumerate()
        .filter_map(|(i, l)| {
            // A trailing "\n" yields a final empty element that is not a line.
            if l.is_empty() && i > 0 && s.ends_with('\n') && i == s.matches('\n').count() {
                None
            } else {
                Some(l)
            }
        })
        .collect()
}

fn join_lines(lines: &[String], trailing_newline: bool) -> String {
    let mut out = lines.join("\n");
    if trailing_newline && !out.is_empty() {
        out.push('\n');
    }
    out
}

/// Group a line diff into hunks with [`CONTEXT`] lines either side.
pub fn diff_hunks(before: &str, after: &str) -> Vec<Hunk> {
    let old_lines = split_lines(before);
    let new_lines = split_lines(after);
    let diff = TextDiff::from_slices(&old_lines, &new_lines);

    let mut hunks = Vec::new();
    for group in diff.grouped_ops(CONTEXT) {
        let mut lines = Vec::new();
        let (mut added, mut removed) = (0usize, 0usize);
        let (mut old_start, mut new_start) = (usize::MAX, usize::MAX);
        let (mut old_end, mut new_end) = (0usize, 0usize);

        for op in &group {
            for change in diff.iter_changes(op) {
                let old_idx = change.old_index();
                let new_idx = change.new_index();
                if let Some(i) = old_idx {
                    old_start = old_start.min(i);
                    old_end = old_end.max(i + 1);
                }
                if let Some(i) = new_idx {
                    new_start = new_start.min(i);
                    new_end = new_end.max(i + 1);
                }
                let kind = match change.tag() {
                    ChangeTag::Equal => "context",
                    ChangeTag::Insert => {
                        added += 1;
                        "add"
                    }
                    ChangeTag::Delete => {
                        removed += 1;
                        "remove"
                    }
                };
                lines.push(DiffLine {
                    kind: kind.to_string(),
                    old_line: old_idx.map(|i| i + 1),
                    new_line: new_idx.map(|i| i + 1),
                    text: change.to_string_lossy().trim_end_matches('\n').to_string(),
                });
            }
        }
        if lines.is_empty() {
            continue;
        }
        // A pure insertion covers no old lines; it splices at the position the
        // surrounding context puts it, with zero length.
        let old_start = if old_start == usize::MAX { old_end } else { old_start };
        let new_start = if new_start == usize::MAX { new_end } else { new_start };
        hunks.push(Hunk {
            index: hunks.len(),
            old_start,
            old_len: old_end.saturating_sub(old_start),
            new_start,
            new_len: new_end.saturating_sub(new_start),
            added,
            removed,
            lines,
        });
    }
    hunks
}

/// Rebuild the file with only `selected` hunks applied.
///
/// Everything outside a hunk is old content by definition; inside one it is the
/// new side if the hunk was taken and the old side if it was left. That is what
/// makes rejecting a hunk a real outcome rather than a note — the model's call
/// runs, against content the user actually agreed to.
///
/// Selecting every hunk reproduces the model's proposal exactly; selecting none
/// reproduces `before`. Both are returned verbatim rather than rebuilt, so the
/// ordinary answers cannot be changed by a reconstruction bug.
///
/// `after` is otherwise consulted for one thing only: whether the file ends
/// with a newline, which line-splitting erases and which is a real difference
/// to every tool that reads the file afterwards.
pub fn apply_hunks(before: &str, after: &str, hunks: &[Hunk], selected: &HashSet<usize>) -> String {
    if hunks.is_empty() || selected.is_empty() {
        return before.to_string();
    }
    if hunks.iter().all(|h| selected.contains(&h.index)) {
        return after.to_string();
    }

    let old_lines: Vec<String> = split_lines(before).into_iter().map(String::from).collect();
    let mut out: Vec<String> = Vec::new();
    let mut cursor = 0usize;

    // Hunks come out of `grouped_ops` in file order and never overlap, so a
    // single pass with a cursor is enough.
    for hunk in hunks {
        if hunk.old_start > cursor {
            out.extend_from_slice(&old_lines[cursor.min(old_lines.len())..hunk.old_start.min(old_lines.len())]);
        }
        let take_new = selected.contains(&hunk.index);
        for line in &hunk.lines {
            let keep = if take_new {
                line.kind != "remove"
            } else {
                line.kind != "add"
            };
            if keep {
                out.push(line.text.clone());
            }
        }
        cursor = (hunk.old_start + hunk.old_len).max(cursor);
    }
    if cursor < old_lines.len() {
        out.extend_from_slice(&old_lines[cursor..]);
    }

    // Whether the file ends with a newline follows whichever side supplied its
    // last line: the last hunk is the only one that can reach the end of the
    // file, so its fate decides.
    let last_taken = hunks
        .last()
        .is_some_and(|h| selected.contains(&h.index));
    join_lines(&out, if last_taken { after.ends_with('\n') } else { before.ends_with('\n') })
}

/// The diff between two texts as a whole `FileDiff`, or a summary when there is
/// nothing readable to show.
pub fn file_diff(path: &str, display_path: &str, before: Option<&str>, after: &str) -> FileDiff {
    let change = if before.is_none() { "create" } else { "modify" };
    let before_text = before.unwrap_or("");

    if before_text.len() > MAX_DIFF_BYTES || after.len() > MAX_DIFF_BYTES {
        return FileDiff::summary_only(
            path.to_string(),
            display_path.to_string(),
            change,
            format!(
                "too large to diff ({} KB); over the {} KB preview limit",
                after.len() / 1024,
                MAX_DIFF_BYTES / 1024
            ),
        );
    }

    let hunks = diff_hunks(before_text, after);
    let added = hunks.iter().map(|h| h.added).sum();
    let removed = hunks.iter().map(|h| h.removed).sum();
    let note = hunks
        .is_empty()
        .then(|| "no change — the proposed content matches what is already there".to_string());

    FileDiff {
        path: path.to_string(),
        display_path: display_path.to_string(),
        change: change.to_string(),
        hunks,
        added,
        removed,
        note,
    }
}

/// A file whose bytes aren't text: shown as a summary, never as a diff.
pub fn binary_diff(path: &str, display_path: &str, change: &str) -> FileDiff {
    FileDiff::summary_only(
        path.to_string(),
        display_path.to_string(),
        change,
        "binary file — not shown as a diff".to_string(),
    )
}

/// A change that has no content to diff: a delete, or a rename.
pub fn summary_diff(path: &str, display_path: &str, change: &str, note: &str) -> FileDiff {
    FileDiff::summary_only(
        path.to_string(),
        display_path.to_string(),
        change,
        note.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(indices: &[usize]) -> HashSet<usize> {
        indices.iter().copied().collect()
    }

    /// Two changes far apart are two hunks — the whole premise of per-hunk
    /// approval is that they can be judged separately.
    #[test]
    fn distant_changes_become_separate_hunks() {
        let before = (1..=40).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let mut after: Vec<String> = before.lines().map(String::from).collect();
        after[2] = "line 3 — changed at the top".into();
        after[35] = "line 36 — changed at the bottom".into();
        let after = after.join("\n");

        let hunks = diff_hunks(&before, &after);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].index, 0);
        assert_eq!(hunks[1].index, 1);
        assert_eq!(hunks.iter().map(|h| h.added).sum::<usize>(), 2);
        assert_eq!(hunks.iter().map(|h| h.removed).sum::<usize>(), 2);
    }

    /// Taking every hunk reproduces the proposal byte for byte, and taking none
    /// reproduces the original. Anything else and "approve all" would quietly
    /// mean something other than what the model asked for.
    #[test]
    fn selecting_all_or_nothing_is_lossless() {
        let before = "alpha\nbravo\ncharlie\ndelta\n";
        let after = "alpha\nBRAVO\ncharlie\nDELTA\n";
        let hunks = diff_hunks(before, after);

        let all: HashSet<usize> = hunks.iter().map(|h| h.index).collect();
        assert_eq!(apply_hunks(before, after, &hunks, &all), after);
        assert_eq!(apply_hunks(before, after, &hunks, &HashSet::new()), before);
    }

    /// The point of the release: three edits land, one doesn't, in one call.
    #[test]
    fn rejecting_one_hunk_keeps_the_original_lines_there() {
        let before = (1..=60).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let mut lines: Vec<String> = before.lines().map(String::from).collect();
        lines[5] = "wanted change".into();
        lines[30] = "unwanted change".into();
        lines[55] = "also wanted".into();
        let after = lines.join("\n");

        let hunks = diff_hunks(&before, &after);
        assert_eq!(hunks.len(), 3, "three distant edits");

        let result = apply_hunks(&before, &after, &hunks, &selection(&[0, 2]));
        assert!(result.contains("wanted change"));
        assert!(result.contains("also wanted"));
        assert!(!result.contains("unwanted change"));
        assert!(result.contains("line 31"), "the rejected hunk's original line stays");
        // Nothing else moved: same line count, same untouched neighbours.
        assert_eq!(result.lines().count(), 60);
        assert!(result.contains("line 60"));
    }

    /// A pure insertion covers no old lines. Splicing it with a length of
    /// anything but zero would eat the line it was inserted before.
    #[test]
    fn an_insertion_does_not_consume_the_line_it_precedes() {
        let before = "one\ntwo\nthree\n";
        let after = "one\ninserted\ntwo\nthree\n";
        let hunks = diff_hunks(before, after);
        let all: HashSet<usize> = hunks.iter().map(|h| h.index).collect();
        assert_eq!(apply_hunks(before, after, &hunks, &all), after);
        assert_eq!(apply_hunks(before, after, &hunks, &HashSet::new()), before);
    }

    /// Creating a file is a diff against nothing, so every line reads as an
    /// addition rather than the prompt showing a wall of content with no shape.
    #[test]
    fn creating_a_file_diffs_against_nothing() {
        let d = file_diff("/tmp/new.txt", "new.txt", None, "first\nsecond\n");
        assert_eq!(d.change, "create");
        assert_eq!(d.added, 2);
        assert_eq!(d.removed, 0);
        assert!(d.note.is_none());
    }

    /// A proposal identical to what is on disk is worth saying out loud — it is
    /// the case where approving changes nothing and the user should know before
    /// they are asked.
    #[test]
    fn an_identical_proposal_is_reported_as_no_change() {
        let d = file_diff("/tmp/same.txt", "same.txt", Some("unchanged\n"), "unchanged\n");
        assert!(d.hunks.is_empty());
        assert_eq!(d.note.as_deref(), Some("no change — the proposed content matches what is already there"));
    }

    /// A file with no trailing newline keeps not having one.
    #[test]
    fn a_missing_trailing_newline_is_preserved() {
        let before = "a\nb";
        let after = "a\nB";
        let hunks = diff_hunks(before, after);
        let all: HashSet<usize> = hunks.iter().map(|h| h.index).collect();
        assert_eq!(apply_hunks(before, after, &hunks, &all), after);
    }
}
