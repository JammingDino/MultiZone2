//! Utilities for handling inline `<think>` / `<thinking>` / `<reasoning>`
//! tags that some local models (Qwen QwQ, DeepSeek-Distill variants, etc.)
//! emit as part of the regular `content` stream. Providers that split
//! thinking into a separate `reasoning_content` field handle this at the
//! protocol layer and don't go through these helpers.

const TAG_PAIRS: &[(&str, &str)] = &[
    ("<think>", "</think>"),
    ("<thinking>", "</thinking>"),
    ("<reasoning>", "</reasoning>"),
];

/// Removes every inline thinking block from `input`. Handles unterminated
/// blocks too — if the closing tag is missing (the response was truncated
/// mid-thought), everything from the opening tag onward is dropped.
pub fn strip_thinking_blocks(input: &str) -> String {
    let mut working = input.to_string();
    for (open, close) in TAG_PAIRS {
        working = strip_pair(&working, open, close);
    }
    working
}

fn strip_pair(input: &str, open: &str, close: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        match rest.find(open) {
            Some(start) => {
                out.push_str(&rest[..start]);
                let after_open = &rest[start + open.len()..];
                match after_open.find(close) {
                    Some(end_rel) => {
                        rest = &after_open[end_rel + close.len()..];
                    }
                    None => {
                        // Unterminated — everything from the open tag is reasoning.
                        return out;
                    }
                }
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_terminated_blocks() {
        assert_eq!(
            strip_thinking_blocks("hello <think>internal</think> world"),
            "hello  world"
        );
    }

    #[test]
    fn strips_unterminated_blocks() {
        assert_eq!(
            strip_thinking_blocks("answer here <think>still pondering"),
            "answer here "
        );
    }

    #[test]
    fn strips_multiple_variants() {
        let src = "<thinking>a</thinking>X<reasoning>b</reasoning>Y";
        assert_eq!(strip_thinking_blocks(src), "XY");
    }

    #[test]
    fn passes_through_plain_text() {
        assert_eq!(strip_thinking_blocks("just an answer"), "just an answer");
    }
}
