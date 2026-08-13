//! Keeping a multi-step turn going (0.9.6).
//!
//! The agentic loop stops as soon as a model returns an assistant message with
//! no tool calls. That is the right rule for a model that has actually finished
//! — and the wrong rule for the two ways a turn dies early in practice:
//!
//!   1. **The blank turn.** After a long run of tool results (dozens of file
//!      reads), a model returns nothing at all — no content, no tool calls. The
//!      loop breaks, an empty bubble is saved, and the user is left with a wall
//!      of tool steps and no answer.
//!   2. **The announced turn.** The model says what it is about to do — "All
//!      tabs closed. Now opening the six opportunities." — and then stops
//!      without calling the tool it just promised. Small models do this
//!      constantly; it reads as a progress note, not an answer.
//!
//! Both are stalls, not completions, and both are recoverable by simply asking
//! again. [`classify_stall`] tells them apart from a genuine final answer, and
//! the nudges below are what the loop sends back.
//!
//! The third failure mode is the step budget itself: the loop used to run a
//! fixed eight iterations and then fall out silently, ending the turn on a tool
//! result with no prose. Here the budget is a user setting, and the last steps
//! of it are spent landing the plane — the model is warned it is running out
//! and then called once with no tools at all, so every turn ends in an answer.

/// Per-turn tool-step budget when the user hasn't set one. Each step is one
/// assistant message, which may carry several parallel tool calls — so this is
/// well over 30 tool calls in practice.
pub const DEFAULT_MAX_STEPS: usize = 30;

/// Bounds on the user-set budget. The floor keeps a misconfigured setting from
/// disabling tool use entirely; the ceiling is a backstop against a model that
/// has found a loop it likes (the cancel button is the real defence).
pub const MIN_MAX_STEPS: usize = 4;
pub const MAX_MAX_STEPS: usize = 200;

/// How many steps before the end the model is told to start wrapping up. One
/// warned step, then the forced final answer.
const WRAPUP_RESERVE: usize = 2;

/// Most stalls clear on the first retry; a model that stalls repeatedly is stuck
/// on something a nudge won't fix, and re-asking just burns tokens.
pub const MAX_NUDGES_PER_TURN: usize = 3;

/// Clamps a configured step budget into the supported range.
pub fn clamp_steps(configured: usize) -> usize {
    configured.clamp(MIN_MAX_STEPS, MAX_MAX_STEPS)
}

/// Why an assistant turn that produced no tool calls should not be treated as
/// the end of the turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stall {
    /// The model produced a real answer — the turn is genuinely over.
    None,
    /// Nothing came back at all. Nothing to show the user, nothing to lose.
    Empty,
    /// The model narrated its next action instead of taking it.
    Announced,
}

/// Sign-offs that hand control back to the user. Checked before anything else,
/// because they share their opening words with the intent phrases below — "let
/// me know if you want the fix applied" is a finished answer, and re-prompting
/// it produces a confused model and a second, worse answer.
const HANDOFF_MARKERS: &[&str] = &[
    "let me know",
    "would you like",
    "do you want",
    "shall i",
    "want me to",
    "if you want",
    "if you'd like",
    "anything else",
];

/// First-person statements of intent, matched anywhere in the final sentence.
/// The subject makes them unambiguous — "I'll open the file" is a promise no
/// matter what precedes it in the sentence.
const INTENT_PHRASES: &[&str] = &[
    "i'll ",
    "i will ",
    "i am going to ",
    "i'm going to ",
    "let me ",
    "let's ",
    "going to ",
    "about to ",
    "one moment",
    "stand by",
    "hold on",
];

/// Subject-less announcements, matched only at the *start* of the final
/// sentence. As a `contains` these would fire on ordinary prose — "the error
/// happens when reading the file" is a finding, not a plan.
///
/// Deliberately excludes bare gerunds ("opening…", "searching…", "running…").
/// A leading gerund is just as often the sentence's *subject* — "running the
/// suite takes four minutes" is a result — and telling the two apart needs a
/// parser, not a word list. Dropping them costs little: a model that stalls
/// almost always does it in the first person or with a "Now …", both kept below.
const INTENT_PREFIXES: &[&str] = &[
    "now ",
    "next, ",
    "next i",
    "starting with ",
    "moving on ",
    "continuing ",
    "proceeding ",
];

/// An announcement is a short note, not an essay. A model that wrote four
/// paragraphs and closed with "let me know if you want more" has answered; the
/// length is the signal that separates the two.
const MAX_ANNOUNCEMENT_CHARS: usize = 400;

/// Decides whether a tool-call-free assistant turn ended the task or stalled.
///
/// `used_tools_this_turn` gates the [`Stall::Announced`] case: the very first
/// message of a turn is allowed to say "let me look into that" — there is no
/// work in flight yet, and a model that opens by restating the task and then
/// calls a tool next iteration is behaving correctly. It is only a stall when
/// tools were already running and the model narrated instead of continuing.
pub fn classify_stall(content: &str, used_tools_this_turn: bool) -> Stall {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Stall::Empty;
    }
    if !used_tools_this_turn || trimmed.len() > MAX_ANNOUNCEMENT_CHARS {
        return Stall::None;
    }
    if last_sentence_is_intent(trimmed) {
        Stall::Announced
    } else {
        Stall::None
    }
}

/// True when the closing sentence reads as "here is what I am about to do".
fn last_sentence_is_intent(text: &str) -> bool {
    let lower = text.to_lowercase();
    let trailing_colon = lower.trim_end().ends_with(':');
    let last = lower
        .rsplit(['.', '!', '?', '\n'])
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| lower.trim());

    if HANDOFF_MARKERS.iter().any(|m| last.contains(m)) {
        return false;
    }
    // A trailing colon is the other shape this takes: "Opening the six
    // opportunities:" followed by nothing at all.
    trailing_colon
        || INTENT_PHRASES.iter().any(|m| last.contains(m))
        || INTENT_PREFIXES.iter().any(|m| last.starts_with(m))
}

/// The message sent back to a stalled model to restart it. Phrased so that it
/// still produces something useful if the classification was wrong and the model
/// really was finished.
pub fn stall_nudge(stall: Stall) -> &'static str {
    match stall {
        Stall::Empty => {
            "Your last message was empty. You are mid-task and the tool results above are \
             already in your context. Continue: either call the next tool, or write the final \
             answer for the user now. Do not reply with an empty message again."
        }
        Stall::Announced | Stall::None => {
            "You described what you were about to do but did not do it. Carry it out now by \
             calling the tool — or, if the task is already finished, give the user the final \
             answer instead of describing more steps. Do not stop again without doing one or \
             the other."
        }
    }
}

/// The standing instruction block that teaches a model how this loop works.
/// Injected into the system prompt for any zone that has tools, because a model
/// that doesn't know it will be called again after a tool result has every
/// reason to stop and wait for the user.
///
/// Deliberately short: the models that need it most are the ones that degrade
/// fastest as the system prompt grows.
pub fn multi_step_preamble(max_steps: usize, has_plan_tool: bool) -> String {
    let mut s = format!(
        "# Working through a task\n\
         You are running in a loop: every tool result comes back to you and you are called \
         again, up to {max_steps} times this turn. Nothing ends the turn except you giving a \
         final answer, so keep working until the task is actually done.\n\
         - Never announce an action without taking it. If you say you will do something, make \
         the tool call in the same message — do not stop and wait to be told to continue.\n\
         - After a tool result, do the next thing or answer. Never reply with an empty message.\n\
         - Stop only when the work is finished, or when you need something only the user can \
         give you — then say plainly what you need.\n\
         - Finish with a written answer: what you did, what you found, and anything still \
         outstanding. Tool output on its own is not an answer to the user."
    );
    if has_plan_tool {
        s.push_str(
            "\n- For anything that will take more than about three steps, call `update_plan` \
             first with the whole plan, then update it as you finish each step.",
        );
    }
    s
}

/// Warning injected once, `WRAPUP_RESERVE` steps from the end of the budget.
pub fn wrapup_nudge(steps_left: usize, max_steps: usize) -> String {
    format!(
        "# Step budget\n\
         You have {steps_left} tool step(s) left of the {max_steps} allowed this turn. Stop \
         starting new lines of work. Do only what is essential to answer, then write your final \
         answer. If you cannot finish, say clearly what is done and what is left."
    )
}

/// Injected on the final step, where the request goes out with no tools at all —
/// so this turn always ends in prose rather than a dangling tool result.
pub fn final_step_nudge(max_steps: usize) -> String {
    format!(
        "# Out of steps\n\
         You have used all {max_steps} tool steps for this turn, and tools are switched off for \
         this message. Answer the user now with what you already have: what you did, what you \
         found, and exactly what remains. Do not say you will continue — you cannot, until the \
         user replies."
    )
}

/// The budget a planning turn gets (0.12.7).
///
/// Planning is the one kind of turn whose entire output is reading: search the
/// web, follow what it returns, read the files, then write the plan a step at a
/// time — each of which is a step of the loop. Held to the ordinary budget, a
/// model planning properly runs out during the research and files whatever it
/// has, which is exactly the thin plan this release exists to stop. Nothing here
/// can change anything on disk, so the usual reason to be miserly does not
/// apply; the ceiling and the cancel button remain the real limits.
pub fn plan_mode_steps(base: usize) -> usize {
    base.saturating_mul(2).max(PLAN_MODE_MIN_STEPS).min(MAX_MAX_STEPS)
}

/// Floor for a planning turn, so a user who set a small budget for ordinary work
/// does not get a plan written from three searches.
const PLAN_MODE_MIN_STEPS: usize = 24;

/// The last-step nudge for a turn that is *planning*, where tools are not fully
/// withheld: `exit_plan_mode` survives, because a plan mode turn that runs out of
/// budget and answers in prose has produced the one thing the mode exists to
/// prevent — a plan the user cannot edit or approve.
pub fn final_step_plan_nudge(max_steps: usize) -> String {
    format!(
        "# Out of steps\n\
         You have used all {max_steps} tool steps for this turn. Every tool is switched off for \
         this message except the ones that file your plan. Stop researching and call \
         `exit_plan_mode` now with what you have — file the plan even if it is less complete \
         than you wanted, and say what is still open in its context. Do not write the plan out \
         in prose instead: prose is not something the user can edit or approve."
    )
}

/// True when this step should carry the wrap-up warning. `step` is zero-based.
pub fn is_wrapup_step(step: usize, max_steps: usize) -> bool {
    step + WRAPUP_RESERVE == max_steps
}

/// True when this is the last step, which runs with tools disabled.
pub fn is_final_step(step: usize, max_steps: usize) -> bool {
    step + 1 >= max_steps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_content_is_a_stall() {
        assert_eq!(classify_stall("", true), Stall::Empty);
        assert_eq!(classify_stall("   \n  ", true), Stall::Empty);
        // Even before any tool ran — a blank first message is never an answer.
        assert_eq!(classify_stall("", false), Stall::Empty);
    }

    /// The exact shape from the bug report: a progress note mid-task.
    #[test]
    fn announced_next_action_is_a_stall() {
        assert_eq!(
            classify_stall("All tabs closed. Now opening the six opportunities.", true),
            Stall::Announced
        );
        assert_eq!(
            classify_stall("Let me read the remaining files.", true),
            Stall::Announced
        );
        assert_eq!(
            classify_stall("I'll check the config next.", true),
            Stall::Announced
        );
        assert_eq!(
            classify_stall("Opening the six opportunities:", true),
            Stall::Announced
        );
    }

    /// Opening a turn by restating the plan is fine — no work is in flight yet
    /// and the model gets its tool call on the next iteration.
    #[test]
    fn intent_before_any_tool_ran_is_not_a_stall() {
        assert_eq!(
            classify_stall("Let me read the remaining files.", false),
            Stall::None
        );
    }

    #[test]
    fn a_real_answer_is_not_a_stall() {
        assert_eq!(
            classify_stall("The config sets the timeout to 30 seconds.", true),
            Stall::None
        );
        // Intent words inside a finished answer don't make it a stall.
        assert_eq!(
            classify_stall(
                "I read all four files. The bug is in parse_args: it drops the last \
                 argument when the list is empty. Let me know if you want the fix applied.",
                true
            ),
            Stall::None
        );
    }

    /// Every common way of handing back to the user must survive, because these
    /// share their opening words with the intent phrases. A false positive here
    /// re-prompts a model that had finished, and it answers again, worse.
    #[test]
    fn handoffs_are_answers_not_stalls() {
        for closer in [
            "Done. Let me know if you want more.",
            "Fixed the parser. Would you like me to run the tests?",
            "That's the whole config. Do you want it applied?",
            "The index is rebuilt. Shall I re-run the search?",
            "Anything else you need?",
        ] {
            assert_eq!(classify_stall(closer, true), Stall::None, "{closer}");
        }
    }

    /// Ordinary findings that merely mention a verb of action are answers —
    /// including the ones that open with a gerund, which is why bare gerunds are
    /// not in [`INTENT_PREFIXES`].
    #[test]
    fn prose_about_actions_is_not_an_announcement() {
        for answer in [
            "The crash happens when reading the file.",
            "The bug appears when opening a second tab.",
            "Searching the index is what makes it slow.",
            "Running the suite takes four minutes.",
            "Reading the config twice was the bug.",
        ] {
            assert_eq!(classify_stall(answer, true), Stall::None, "{answer}");
        }
    }

    /// Length alone rescues a long answer that happens to end mid-thought.
    #[test]
    fn long_answers_are_never_announcements() {
        let long = format!("{} Let me continue.", "x".repeat(MAX_ANNOUNCEMENT_CHARS));
        assert_eq!(classify_stall(&long, true), Stall::None);
    }

    #[test]
    fn budget_is_clamped_both_ways() {
        assert_eq!(clamp_steps(0), MIN_MAX_STEPS);
        assert_eq!(clamp_steps(1_000), MAX_MAX_STEPS);
        assert_eq!(clamp_steps(30), 30);
    }

    /// The last two steps of any budget are the warned step and the forced
    /// answer, and they are never the same step.
    #[test]
    fn wrapup_precedes_the_final_step() {
        let max = 10;
        assert!(is_wrapup_step(8, max));
        assert!(!is_wrapup_step(7, max));
        assert!(!is_wrapup_step(9, max));
        assert!(is_final_step(9, max));
        assert!(!is_final_step(8, max));
    }

    /// At the floor the phases must still be distinct and in range.
    #[test]
    fn phases_hold_at_the_minimum_budget() {
        let max = MIN_MAX_STEPS;
        let wrapup: Vec<usize> = (0..max).filter(|s| is_wrapup_step(*s, max)).collect();
        let final_: Vec<usize> = (0..max).filter(|s| is_final_step(*s, max)).collect();
        assert_eq!(wrapup, vec![max - 2]);
        assert_eq!(final_, vec![max - 1]);
    }
}
