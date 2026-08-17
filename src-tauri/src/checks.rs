//! Per-project checks (0.14.5) — turning "the implementer thinks it is done"
//! into evidence.
//!
//! An agent that has just edited four files reports success in prose. Prose is
//! what it is good at, which is exactly the problem: a confident paragraph and
//! a working change look identical from outside, and the whole panel is built
//! on being able to tell two candidate diffs apart. A compete-mode leader
//! choosing between two implementations currently chooses between two
//! descriptions of implementations.
//!
//! So: a project carries a lint command and a test command, they run once the
//! edits of a turn have landed, and the output goes back to the model as input.
//!
//! **Where this differs from the plan.** The plan said "output fed back as the
//! next turn's input". It is fed back within the *same* turn instead, as one
//! further step — because a failing test the model learns about next turn is a
//! failing test the user has already been told is a success. The turn ends on
//! what the checks actually said. The cost of being wrong about this is one
//! extra step per turn that edits files; the cost of the other choice is a
//! report that contradicts the build.
//!
//! Once per turn, whatever happens next. A check that fails, is fixed, and
//! fails again is a conversation for the *next* turn — re-running after every
//! repair is how a thirty-second test suite becomes the whole step budget.

use crate::error::AppResult;
use serde_json::{json, Value};
use sqlx::SqlitePool;

/// How long a check may run before it is killed.
///
/// Generous next to the shell tool's 30 seconds, because this is a test suite
/// rather than an `ls` — and still bounded, because a hung check would
/// otherwise hold a turn open indefinitely with nothing on screen explaining
/// why.
const CHECK_TIMEOUT_SECS: u64 = 240;

/// Characters of output kept per check. Enough for a compiler's error list;
/// short enough that a test suite printing every passing case does not become
/// the turn's context.
const MAX_OUTPUT_CHARS: usize = 4_000;

/// What one check did.
#[derive(Debug, Clone)]
pub struct Outcome {
    /// `lint` or `tests` — what the user called it when they configured it.
    pub label: &'static str,
    pub command: String,
    pub exit_code: Option<i64>,
    /// stdout and stderr, interleaved as the model should read them, truncated.
    pub output: String,
    pub passed: bool,
}

/// The commands configured for the chat's project, in the order they run.
///
/// Lint before tests, deliberately: a type error explains a test failure, so
/// reporting the type error first is reporting the cause rather than the
/// symptom. And a lint that fails is cheap to read, where a test suite failing
/// for the same reason is fifty lines of stack.
async fn commands(db: &SqlitePool, chat_id: &str) -> Vec<(&'static str, String)> {
    let row: Option<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT p.lint_command, p.test_command FROM projects p
         JOIN chats c ON c.project_id = p.id
         WHERE c.id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    let Some((lint, test)) = row else {
        return Vec::new();
    };
    [("lint", lint), ("tests", test)]
        .into_iter()
        .filter_map(|(label, cmd)| {
            let cmd = cmd?.trim().to_string();
            (!cmd.is_empty()).then_some((label, cmd))
        })
        .collect()
}

/// Run the project's checks in its working directory.
///
/// Empty when the project has none configured, which is the default — a check
/// nobody wrote down is not a check we invent, and guessing `npm test` in a
/// repository that has never been installed produces a failure about the
/// wrong thing.
pub async fn run(db: &SqlitePool, chat_id: &str, project_dir: Option<&str>) -> Vec<Outcome> {
    let mut out = Vec::new();
    for (label, command) in commands(db, chat_id).await {
        out.push(run_one(label, &command, project_dir).await);
    }
    out
}

async fn run_one(label: &'static str, command: &str, project_dir: Option<&str>) -> Outcome {
    // Through the shell tool's own runner rather than a second process launcher:
    // shell selection, the Windows console-window suppression and the timeout
    // are all decisions this app has already made once, and two implementations
    // of "run a command here" is how they drift.
    let args = json!({ "command": command });
    let zone_config = json!({ "shell_exec": { "timeout_secs": CHECK_TIMEOUT_SECS } });
    let raw: AppResult<String> = crate::tools::shell::run(&args, &zone_config, project_dir).await;
    let v: Value = raw
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);

    let exit_code = v.get("exit_code").and_then(Value::as_i64);
    let mut text = String::new();
    for key in ["stdout", "stderr", "error"] {
        if let Some(s) = v.get(key).and_then(Value::as_str) {
            let s = s.trim();
            if !s.is_empty() {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(s);
            }
        }
    }
    // The end, not the beginning. A compiler prints its errors last and a test
    // runner prints its summary last; the first 4,000 characters of a build log
    // are the part nobody reads.
    let output = if text.chars().count() > MAX_OUTPUT_CHARS {
        let tail: String = text
            .chars()
            .skip(text.chars().count() - MAX_OUTPUT_CHARS)
            .collect();
        format!("…(earlier output omitted)\n{tail}")
    } else {
        text
    };

    Outcome {
        label,
        command: command.to_string(),
        // No exit code at all means the command never ran — a missing shell, a
        // timeout. That is a failed check, not a passed one: "we could not tell"
        // must never read as "it is fine".
        passed: exit_code == Some(0),
        exit_code,
        output,
    }
}

/// What the model is told. `None` when nothing ran.
pub fn note(outcomes: &[Outcome]) -> Option<String> {
    if outcomes.is_empty() {
        return None;
    }
    let failed: Vec<&Outcome> = outcomes.iter().filter(|o| !o.passed).collect();
    let mut out = String::from("# Project checks\n\n");
    if failed.is_empty() {
        out.push_str(
            "Your edits landed and this project's checks were run against them. They passed:\n\n",
        );
        for o in outcomes {
            out.push_str(&format!("- {} — `{}` — exit 0\n", o.label, o.command));
        }
        out.push_str(
            "\nThis is evidence rather than permission: the checks passing means what they cover \
             still works, not that the change is right. Finish your answer.\n",
        );
        return Some(out);
    }

    out.push_str(
        "Your edits landed and this project's checks were run against them. They did not pass. \
         Fix what they report, then finish your answer — and if a failure is unrelated to your \
         change or was already there, say so rather than working around it.\n",
    );
    for o in outcomes {
        let status = match (o.passed, o.exit_code) {
            (true, _) => "passed".to_string(),
            (false, Some(code)) => format!("exit {code}"),
            (false, None) => "did not run".to_string(),
        };
        out.push_str(&format!("\n## {} — `{}` — {status}\n", o.label, o.command));
        if !o.passed && !o.output.is_empty() {
            out.push_str(&format!("\n```\n{}\n```\n", o.output));
        }
    }
    Some(out)
}

/// A one-line summary for the session event log and the UI.
pub fn summary(outcomes: &[Outcome]) -> String {
    let failed: Vec<&str> = outcomes.iter().filter(|o| !o.passed).map(|o| o.label).collect();
    if failed.is_empty() {
        let names: Vec<&str> = outcomes.iter().map(|o| o.label).collect();
        format!("Project checks passed ({})", names.join(", "))
    } else {
        format!("Project checks failed ({})", failed.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(label: &'static str, code: Option<i64>, output: &str) -> Outcome {
        Outcome {
            label,
            command: format!("run {label}"),
            exit_code: code,
            output: output.to_string(),
            passed: code == Some(0),
        }
    }

    #[test]
    fn nothing_configured_says_nothing() {
        assert!(note(&[]).is_none());
    }

    /// A pass is reported as evidence, not as permission — a check that covers
    /// a tenth of the change passing is not the change being right.
    #[test]
    fn a_pass_is_reported_as_evidence() {
        let note = note(&[outcome("lint", Some(0), ""), outcome("tests", Some(0), "ok")]).unwrap();
        assert!(note.contains("passed"));
        assert!(note.contains("evidence rather than permission"), "{note}");
    }

    /// The failing output is what the model needs; the passing one is noise.
    #[test]
    fn a_failure_carries_its_output_and_the_passes_do_not() {
        let note = note(&[
            outcome("lint", Some(0), "no problems found in 400 files"),
            outcome("tests", Some(1), "FAIL src/a.test.ts — expected 2, got 3"),
        ])
        .unwrap();
        assert!(note.contains("expected 2, got 3"));
        assert!(!note.contains("400 files"), "{note}");
    }

    /// "We could not tell" must never read as "it is fine". A command that
    /// never started is a failed check.
    #[test]
    fn a_check_that_could_not_run_has_not_passed() {
        let o = outcome("tests", None, "Command timed out after 240s");
        assert!(!o.passed);
        let note = note(std::slice::from_ref(&o)).unwrap();
        assert!(note.contains("did not run"), "{note}");
    }

    /// A pre-existing failure being blamed on this change is the way this
    /// mechanism turns into a repair loop over someone else's bug.
    #[test]
    fn the_model_is_told_it_may_disown_an_unrelated_failure() {
        let note = note(&[outcome("tests", Some(1), "boom")]).unwrap();
        assert!(note.contains("unrelated to your change"), "{note}");
    }

    #[test]
    fn the_summary_names_what_failed() {
        assert_eq!(
            summary(&[outcome("lint", Some(0), ""), outcome("tests", Some(2), "")]),
            "Project checks failed (tests)"
        );
        assert_eq!(
            summary(&[outcome("lint", Some(0), ""), outcome("tests", Some(0), "")]),
            "Project checks passed (lint, tests)"
        );
    }
}
