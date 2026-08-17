//! Loop detection for a runaway turn (0.14.1).
//!
//! The step budget already stops a turn that goes on too long, but it stops it
//! *late* and it stops it silently: a model that calls the same failing command
//! twenty times spends the entire budget, costs twenty requests, and ends with a
//! wrap-up that says nothing about why. A panel of seven agents multiplies that
//! by seven, and a background sub-agent does it where nobody is watching.
//!
//! Three shapes are worth catching, and they are genuinely different:
//!
//! 1. **The repeat.** The same call with the same arguments returning the same
//!    thing, over and over. Usually a model that has stopped reading results.
//! 2. **The stuck error.** The same failure three times running — a missing
//!    binary, a path that does not exist, a permission that will not be granted.
//!    Nothing about a fourth attempt will differ.
//! 3. **The oscillation.** A, B, A, B — the shape a stuck agent takes when it
//!    fixes one thing by breaking another. Neither call repeats *consecutively*,
//!    which is why a naive "same as last time" check never sees it.
//!
//! What counts is the whole triple `(tool, arguments, result)`. Two reads of the
//! same file returning different contents are progress; two reads returning the
//! same bytes are not. Arguments alone would flag a legitimate poll, and results
//! alone would flag two different tools that happen to both return `{}`.
//!
//! Only the *hash* of each triple is kept. A window of tool results is otherwise
//! megabytes of retained memory per turn, for data that is already in the
//! transcript.

use std::collections::hash_map::DefaultHasher;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};

/// How many recent calls are considered. Long enough to see an oscillation with
/// a couple of unrelated calls mixed in, short enough that four repeats spread
/// across a genuinely varied twenty-step run do not read as a loop.
const WINDOW: usize = 12;
/// Identical triples in the window before the turn is stopped.
const REPEAT_LIMIT: usize = 4;
/// Consecutive identical failures before the turn is stopped.
const ERROR_LIMIT: usize = 3;
/// Error text kept for the report. Enough to identify the failure, not enough to
/// paste a stack trace into the next request.
const ERROR_KEEP: usize = 400;

/// What the guard concluded after the call it was just shown.
#[derive(Debug, Clone, PartialEq)]
pub enum Runaway {
    None,
    /// The same call, with the same arguments and the same result, `times` times
    /// within the window.
    Repeat { tool: String, times: usize },
    /// The same failure `times` times in a row.
    StuckError { tool: String, error: String, times: usize },
    /// Two calls alternating: `a`, `b`, `a`, `b`.
    Oscillation { a: String, b: String },
}

impl Runaway {
    pub fn is_some(&self) -> bool {
        !matches!(self, Runaway::None)
    }

    /// A short kind, for the session event log.
    pub fn kind(&self) -> &'static str {
        match self {
            Runaway::None => "none",
            Runaway::Repeat { .. } => "repeat",
            Runaway::StuckError { .. } => "stuck_error",
            Runaway::Oscillation { .. } => "oscillation",
        }
    }

    /// The line a person reads in the transcript and the event log.
    pub fn label(&self) -> String {
        match self {
            Runaway::None => String::new(),
            Runaway::Repeat { tool, times } => {
                format!("Stopped: `{tool}` was called {times} times with the same arguments and the same result")
            }
            Runaway::StuckError { tool, times, .. } => {
                format!("Stopped: `{tool}` failed {times} times in a row with the same error")
            }
            Runaway::Oscillation { a, b } => {
                format!("Stopped: `{a}` and `{b}` were alternating without progress")
            }
        }
    }

    /// What the model is told, on the wrap-up step where it has no tools left.
    ///
    /// It has to state the evidence rather than the verdict. "You are looping"
    /// invites a model to argue or to try the same call once more with a
    /// preamble; "you called X four times with the same arguments and got the
    /// same result each time" leaves it with reporting as the only move.
    pub fn note(&self) -> String {
        let evidence = match self {
            Runaway::None => return String::new(),
            Runaway::Repeat { tool, times } => format!(
                "You have called `{tool}` {times} times with the same arguments and received the \
                 same result every time."
            ),
            Runaway::StuckError { tool, error, times } => format!(
                "`{tool}` has failed {times} times in a row with the same error: {error}"
            ),
            Runaway::Oscillation { a, b } => format!(
                "You have been alternating between `{a}` and `{b}`, returning to each one after \
                 the other, without the results changing."
            ),
        };
        format!(
            "{evidence}\n\nThis run has been stopped and your tools have been withdrawn — repeating \
             it cannot produce a different answer. Do not try again. Reply with: what you were \
             trying to do, what actually happened, what you think is blocking it, and what the \
             person reading this should try instead. If part of the task was finished before this, \
             say which part."
        )
    }
}

/// One observed call, reduced to what the detector needs.
#[derive(Debug, Clone)]
struct Step {
    tool: String,
    /// Hash of `(tool, arguments, result)`.
    triple: u64,
    /// `Some` when the result was an error, holding the (clipped) error text.
    error: Option<String>,
}

/// Per-turn state. Created fresh for every turn — a repeat across two turns is
/// the user asking twice, not an agent looping.
#[derive(Debug, Default)]
pub struct LoopGuard {
    recent: VecDeque<Step>,
}

impl LoopGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an executed call and say whether the turn should stop.
    ///
    /// `error` carries the failure text when the result was an error — the
    /// caller already classifies that (`tool_usage::result_is_error`), and
    /// re-deriving it here would be a second opinion that can disagree.
    pub fn observe(&mut self, tool: &str, arguments: &str, result: &str, error: bool) -> Runaway {
        let mut hasher = DefaultHasher::new();
        tool.hash(&mut hasher);
        arguments.hash(&mut hasher);
        result.hash(&mut hasher);

        let step = Step {
            tool: tool.to_string(),
            triple: hasher.finish(),
            error: error.then(|| clip(result)),
        };

        self.recent.push_back(step);
        while self.recent.len() > WINDOW {
            self.recent.pop_front();
        }

        self.stuck_error()
            .or_else(|| self.repeat())
            .or_else(|| self.oscillation())
            .unwrap_or(Runaway::None)
    }

    /// The same failure, consecutively. Checked first: when a call is both
    /// repeating and failing, the error is the more useful thing to report.
    fn stuck_error(&self) -> Option<Runaway> {
        let last = self.recent.back()?;
        let error = last.error.as_ref()?;
        let times = self
            .recent
            .iter()
            .rev()
            .take_while(|s| s.error.as_ref() == Some(error) && s.tool == last.tool)
            .count();
        (times >= ERROR_LIMIT).then(|| Runaway::StuckError {
            tool: last.tool.clone(),
            error: error.clone(),
            times,
        })
    }

    fn repeat(&self) -> Option<Runaway> {
        let last = self.recent.back()?;
        let times = self.recent.iter().filter(|s| s.triple == last.triple).count();
        (times >= REPEAT_LIMIT).then(|| Runaway::Repeat {
            tool: last.tool.clone(),
            times,
        })
    }

    /// A, B, A, B over the last four calls. Requires the two triples to differ,
    /// or this would fire on a plain repeat the other rule already owns.
    fn oscillation(&self) -> Option<Runaway> {
        if self.recent.len() < 4 {
            return None;
        }
        let s: Vec<&Step> = self.recent.iter().rev().take(4).collect();
        let (b, a) = (s[0], s[1]);
        if a.triple == b.triple || s[2].triple != b.triple || s[3].triple != a.triple {
            return None;
        }
        Some(Runaway::Oscillation {
            a: a.tool.clone(),
            b: b.tool.clone(),
        })
    }
}

fn clip(s: &str) -> String {
    if s.chars().count() <= ERROR_KEEP {
        return s.to_string();
    }
    s.chars().take(ERROR_KEEP).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> LoopGuard {
        LoopGuard::new()
    }

    /// Ordinary work must never trip this. The cost of a false positive is a
    /// turn killed mid-task, which is worse than the loop it prevented.
    #[test]
    fn varied_work_is_never_a_loop() {
        let mut g = guard();
        for i in 0..20 {
            let v = g.observe("read_file", &format!("{{\"path\":\"f{i}.rs\"}}"), &format!("body {i}"), false);
            assert_eq!(v, Runaway::None, "step {i}");
        }
    }

    /// Same file, same bytes, four times.
    #[test]
    fn four_identical_calls_stop_the_turn() {
        let mut g = guard();
        for _ in 0..3 {
            assert_eq!(g.observe("read_file", "{\"path\":\"a\"}", "same", false), Runaway::None);
        }
        match g.observe("read_file", "{\"path\":\"a\"}", "same", false) {
            Runaway::Repeat { tool, times } => {
                assert_eq!(tool, "read_file");
                assert_eq!(times, 4);
            }
            other => panic!("expected a repeat, got {other:?}"),
        }
    }

    /// The same arguments returning something different each time is progress —
    /// a directory being written to, a log being tailed, a build running.
    #[test]
    fn the_same_call_with_changing_results_is_progress() {
        let mut g = guard();
        for i in 0..8 {
            let v = g.observe("run_command", "{\"cmd\":\"ls\"}", &format!("{i} files"), false);
            assert_eq!(v, Runaway::None);
        }
    }

    #[test]
    fn three_identical_errors_in_a_row_stop_the_turn_with_the_error() {
        let mut g = guard();
        let err = "{\"error\":\"cargo: command not found\"}";
        assert_eq!(g.observe("run_command", "{\"cmd\":\"cargo b\"}", err, true), Runaway::None);
        assert_eq!(g.observe("run_command", "{\"cmd\":\"cargo t\"}", err, true), Runaway::None);
        match g.observe("run_command", "{\"cmd\":\"cargo r\"}", err, true) {
            Runaway::StuckError { tool, error, times } => {
                assert_eq!(tool, "run_command");
                assert_eq!(times, 3);
                assert!(error.contains("command not found"));
            }
            other => panic!("expected a stuck error, got {other:?}"),
        }
    }

    /// Different arguments each time, so the repeat rule cannot see it — this is
    /// the case the error rule exists for.
    #[test]
    fn a_successful_call_between_failures_resets_the_error_run() {
        let mut g = guard();
        let err = "{\"error\":\"nope\"}";
        g.observe("run_command", "a", err, true);
        g.observe("run_command", "b", err, true);
        g.observe("read_file", "c", "fine", false);
        assert_eq!(g.observe("run_command", "d", err, true), Runaway::None);
    }

    /// Two different errors alternating are not a stuck error — the agent is
    /// getting new information, even if it is not using it well.
    #[test]
    fn different_errors_are_not_a_stuck_error() {
        let mut g = guard();
        g.observe("run_command", "a", "{\"error\":\"one\"}", true);
        g.observe("run_command", "b", "{\"error\":\"two\"}", true);
        assert_eq!(g.observe("run_command", "c", "{\"error\":\"three\"}", true), Runaway::None);
    }

    #[test]
    fn an_alternating_pair_is_caught() {
        let mut g = guard();
        g.observe("edit_file", "x", "wrote", false);
        g.observe("run_command", "test", "failed", false);
        g.observe("edit_file", "x", "wrote", false);
        match g.observe("run_command", "test", "failed", false) {
            Runaway::Oscillation { a, b } => {
                assert_eq!(a, "edit_file");
                assert_eq!(b, "run_command");
            }
            other => panic!("expected an oscillation, got {other:?}"),
        }
    }

    /// A→B→A→B where the second B differs is the ordinary edit/test cycle that
    /// is actually getting somewhere.
    #[test]
    fn an_edit_test_cycle_that_makes_progress_is_left_alone() {
        let mut g = guard();
        g.observe("edit_file", "x", "wrote", false);
        g.observe("run_command", "test", "3 failed", false);
        g.observe("edit_file", "y", "wrote", false);
        assert_eq!(g.observe("run_command", "test", "1 failed", false), Runaway::None);
    }

    /// The window slides: four repeats spread far enough apart are not a loop.
    #[test]
    fn repeats_outside_the_window_do_not_accumulate() {
        let mut g = guard();
        for round in 0..4 {
            g.observe("read_file", "a", "same", false);
            for i in 0..5 {
                g.observe("other", &format!("{round}-{i}"), "x", false);
            }
        }
        // The window holds at most 12 steps, so at most two of those repeats can
        // be in it at once.
        assert_eq!(g.observe("other", "final", "x", false), Runaway::None);
    }

    #[test]
    fn the_note_states_the_evidence_and_forbids_another_attempt() {
        let r = Runaway::Repeat { tool: "read_file".into(), times: 4 };
        let note = r.note();
        assert!(note.contains("`read_file` 4 times"), "{note}");
        assert!(note.contains("Do not try again"), "{note}");
        assert!(r.label().contains("read_file"));
    }

    #[test]
    fn a_long_error_is_clipped_before_it_is_repeated_back() {
        let mut g = guard();
        let err = "x".repeat(5000);
        g.observe("t", "a", &err, true);
        g.observe("t", "a", &err, true);
        match g.observe("t", "a", &err, true) {
            Runaway::StuckError { error, .. } => assert!(error.chars().count() <= ERROR_KEEP + 1),
            other => panic!("expected a stuck error, got {other:?}"),
        }
    }
}
