//! Turn-wide citation numbering (0.9.10).
//!
//! Every citing tool numbers its own results from 1 and tells the model to write
//! `[ref]` after a claim that result supports. On its own that is ambiguous the
//! moment a turn calls more than one of them: a search returns `ref: 1`, a
//! `read_file` after it also returns `ref: 1`, and the `[1]` in the answer now
//! names two different sources. The frontend cannot tell them apart either — it
//! matches a marker against the numbers the tools reported — so it would either
//! attribute the sentence to the wrong source or list both, and a citation that
//! resolves to two sources is not provenance.
//!
//! Rather than teach every tool about the others, results are renumbered in one
//! place as they come back from `dispatch`, against a counter that lives for the
//! length of a turn. Each tool keeps emitting 1-based refs and stays testable on
//! its own; the model sees one flat numbering across the whole turn, which is
//! what it is being asked to cite against.

use serde_json::Value;

/// Rewrite the `ref` fields in one tool result so they continue the turn's
/// numbering, advancing `next` past them.
///
/// Handles both shapes a citing tool returns: a `results` array whose entries
/// carry a `ref` (the searches), and a single top-level `ref` (`read_file`).
/// Anything else — a non-citing tool, an error, a non-JSON payload — is returned
/// untouched, so this is safe to run over every tool result.
pub fn renumber_refs(result: String, next: &mut u32) -> String {
    let Ok(mut v) = serde_json::from_str::<Value>(&result) else {
        return result;
    };

    let mut changed = false;

    if let Some(rows) = v.get_mut("results").and_then(Value::as_array_mut) {
        for row in rows.iter_mut() {
            // Only renumber rows the tool actually numbered. A results array
            // without refs isn't a citation list and must not grow one.
            if row.get("ref").is_some() {
                row["ref"] = Value::from(*next);
                *next += 1;
                changed = true;
            }
        }
    } else if v.get("ref").is_some() {
        v["ref"] = Value::from(*next);
        *next += 1;
        changed = true;
    }

    if changed {
        serde_json::to_string(&v).unwrap_or(result)
    } else {
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs_of(s: &str) -> Vec<u64> {
        let v: Value = serde_json::from_str(s).unwrap();
        match v.get("results").and_then(Value::as_array) {
            Some(rows) => rows.iter().filter_map(|r| r["ref"].as_u64()).collect(),
            None => v.get("ref").and_then(Value::as_u64).into_iter().collect(),
        }
    }

    /// The case this module exists for: a search and a file read in one turn
    /// must not both claim `[1]`.
    #[test]
    fn numbering_continues_across_tool_calls() {
        let mut next = 1;
        let search = renumber_refs(
            r#"{"results":[{"ref":1,"url":"a"},{"ref":2,"url":"b"}]}"#.into(),
            &mut next,
        );
        let read = renumber_refs(r#"{"ref":1,"source":"notes.md"}"#.into(), &mut next);
        let search2 = renumber_refs(r#"{"results":[{"ref":1,"url":"c"}]}"#.into(), &mut next);

        assert_eq!(refs_of(&search), vec![1, 2]);
        assert_eq!(refs_of(&read), vec![3]);
        assert_eq!(refs_of(&search2), vec![4]);
        assert_eq!(next, 5);
    }

    #[test]
    fn non_citing_results_are_returned_verbatim() {
        let mut next = 1;
        for input in [
            r#"{"error":"nope"}"#,                       // an error
            r#"{"results":[{"path":"a"},{"path":"b"}]}"#, // a list, but not a citation list
            "not json at all",
            r#"[{"type":"text","text":"hi"}]"#,          // read_file's image shape
        ] {
            let out = renumber_refs(input.to_string(), &mut next);
            assert_eq!(out, input, "rewrote a result it should have left alone");
        }
        assert_eq!(next, 1, "a non-citing result must not consume a number");
    }
}
