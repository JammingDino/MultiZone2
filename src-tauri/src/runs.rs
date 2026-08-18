//! Saved parameterised runs (0.15.4) — the task, the way a zone is the worker.
//!
//! Schema and reasoning are in migration 043. This module is the part with
//! actual behaviour: what a parameter is, and what rendering a template means.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One declared parameter of a run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunParam {
    pub name: String,
    /// What to call it in the form. Falls back to `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default)]
    pub required: bool,
}

/// A saved run as stored. `params` is JSON in the database and a list here.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SavedRun {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub template: String,
    /// Raw JSON, kept as text so the row maps straight from SQL. Use
    /// [`SavedRun::params`] to read it.
    #[sqlx(rename = "params")]
    pub params_json: String,
    pub zone_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl SavedRun {
    /// The declared parameters, or an empty list if the column is unreadable.
    ///
    /// A run whose params JSON has been corrupted is still a runnable prompt —
    /// refusing to load it would lose the template too, which is the part that
    /// took the work.
    pub fn params(&self) -> Vec<RunParam> {
        serde_json::from_str(&self.params_json).unwrap_or_default()
    }
}

/// Every `{{name}}` placeholder in a template, in order, without duplicates.
///
/// Used to check a saved run against its own template: a parameter nobody
/// references is a form field that does nothing, and a placeholder with no
/// parameter is a prompt that will be sent with `{{like_this}}` still in it.
pub fn placeholders(template: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let bytes = template.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'{' && bytes[i + 1] == b'{' {
            if let Some(end) = template[i + 2..].find("}}") {
                let name = template[i + 2..i + 2 + end].trim();
                if !name.is_empty() && !out.iter().any(|n| n == name) {
                    out.push(name.to_string());
                }
                i = i + 2 + end + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Substitutes `{{name}}` for the supplied values.
///
/// Deliberately dumb: no expressions, no conditionals, no escaping rules. The
/// output is a chat message, not code — there is nothing to inject *into*, and
/// a template language here would be a second thing to learn and a second thing
/// to get wrong.
///
/// A placeholder with no value falls back to the parameter's default, and then
/// to empty. Empty rather than leaving `{{name}}` in place: a prompt that
/// reaches the model with its own scaffolding still in it is worse than one
/// with a gap, because the model will try to interpret the scaffolding.
pub fn render(template: &str, params: &[RunParam], values: &Value) -> String {
    let mut out = template.to_string();
    for name in placeholders(template) {
        let supplied = values.get(&name).and_then(Value::as_str);
        let fallback = params
            .iter()
            .find(|p| p.name == name)
            .and_then(|p| p.default.as_deref());
        let value = supplied.filter(|s| !s.is_empty()).or(fallback).unwrap_or("");
        out = out.replace(&format!("{{{{{name}}}}}"), value);
        // `{{ name }}` with padding is the same placeholder to `placeholders`,
        // so it has to be the same one here too.
        out = out.replace(&format!("{{{{ {name} }}}}"), value);
    }
    out
}

/// Required parameters with nothing to fill them, so the caller can ask rather
/// than sending a prompt with a hole in it.
pub fn missing_required(params: &[RunParam], values: &Value) -> Vec<String> {
    params
        .iter()
        .filter(|p| p.required)
        .filter(|p| {
            let supplied = values.get(&p.name).and_then(Value::as_str).unwrap_or("");
            supplied.is_empty() && p.default.as_deref().unwrap_or("").is_empty()
        })
        .map(|p| p.name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(name: &str, default: Option<&str>, required: bool) -> RunParam {
        RunParam {
            name: name.into(),
            label: None,
            description: None,
            default: default.map(str::to_string),
            required,
        }
    }

    #[test]
    fn placeholders_are_found_once_each_in_order() {
        assert_eq!(
            placeholders("{{repo}} for {{audience}}, again for {{repo}}"),
            vec!["repo", "audience"]
        );
        assert_eq!(placeholders("no params here"), Vec::<String>::new());
        // An unclosed placeholder is text, not a parse error.
        assert_eq!(placeholders("{{oops"), Vec::<String>::new());
        assert_eq!(placeholders("{{ padded }}"), vec!["padded"]);
    }

    #[test]
    fn values_replace_every_occurrence() {
        let params = vec![p("repo", None, false)];
        let out = render("{{repo}} and {{repo}}", &params, &json!({ "repo": "multizone" }));
        assert_eq!(out, "multizone and multizone");
    }

    #[test]
    fn a_default_fills_what_was_left_blank() {
        let params = vec![p("audience", Some("the team"), false)];
        assert_eq!(render("for {{audience}}", &params, &json!({})), "for the team");
        // An explicitly empty value is not a value — fall back rather than
        // sending a prompt with a hole where a default was offered.
        assert_eq!(
            render("for {{audience}}", &params, &json!({ "audience": "" })),
            "for the team"
        );
        assert_eq!(
            render("for {{audience}}", &params, &json!({ "audience": "the board" })),
            "for the board"
        );
    }

    /// A prompt that reaches the model with `{{repo}}` still in it is worse
    /// than one with a gap: the model tries to interpret the scaffolding.
    #[test]
    fn an_unfilled_placeholder_leaves_a_gap_not_scaffolding() {
        let out = render("summarise {{repo}} now", &[], &json!({}));
        assert_eq!(out, "summarise  now");
        assert!(!out.contains("{{"));
    }

    #[test]
    fn padding_inside_the_braces_still_substitutes() {
        let out = render("{{ repo }}", &[], &json!({ "repo": "x" }));
        assert_eq!(out, "x");
    }

    #[test]
    fn required_params_are_reported_when_there_is_nothing_to_fill_them() {
        let params = vec![p("repo", None, true), p("who", Some("us"), true), p("opt", None, false)];
        assert_eq!(missing_required(&params, &json!({})), vec!["repo"]);
        assert!(missing_required(&params, &json!({ "repo": "multizone" })).is_empty());
        assert_eq!(missing_required(&params, &json!({ "repo": "" })), vec!["repo"]);
    }

    /// A corrupted params column must not take the template down with it.
    #[test]
    fn a_run_with_unreadable_params_still_has_its_prompt() {
        let run = SavedRun {
            id: "r1".into(),
            name: "Weekly".into(),
            description: None,
            template: "do the thing".into(),
            params_json: "not json".into(),
            zone_id: None,
            created_at: 0,
            updated_at: 0,
        };
        assert!(run.params().is_empty());
        assert_eq!(run.template, "do the thing");
    }
}
