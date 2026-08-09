//! The connector catalog (0.11.2) — MCP servers as something you install, not
//! something you configure.
//!
//! Adding an MCP server today means knowing what a stdio transport is, which
//! command to run, which environment variables it wants, and where each
//! credential comes from. A catalog entry carries all four, so the panel can ask
//! for the one thing only the user has — the credential — and write the rest.
//! This is the zone-library pattern applied to `mcp_servers` rows: no protocol
//! work at all, and the reason it is worth doing is that the alternative is a
//! settings form that assumes you read code.
//!
//! Entries are **data, not code**: the shipped set is a JSON file compiled in,
//! and any JSON file in `<app_data_dir>/connectors/` is read alongside it, so
//! the set is community-extensible and importing one from a URL is a download
//! and a write rather than a release.
//!
//! Nothing here starts a process or sends a request. Installing an entry writes
//! an `mcp_servers` row and stops; connecting stays the explicit act it was.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The shipped entries. Compiled in rather than seeded to disk on first run, so
/// a fixed URL or a corrected description arrives with an app update instead of
/// living on in a stale copy the user never asked to keep.
const BUILTIN: &str = include_str!("connectors.json");

/// One value the user has to supply — an environment variable for a stdio
/// server, or an HTTP header for a hosted one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorField {
    /// The env var name, or the header name (`Authorization`).
    pub key: String,
    /// What to call it in the form.
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Where this value comes from — the page the user has to visit. The single
    /// most useful field in the entry, and the one a hand-written form never has.
    #[serde(default)]
    pub credential_url: Option<String>,
    /// A value that has to be present before the server can work. Install
    /// refuses without it rather than writing a row that cannot connect.
    #[serde(default)]
    pub required: bool,
    /// Masked in the UI. Not a storage claim — it lands in SQLite like the rest.
    #[serde(default)]
    pub secret: bool,
    /// How the typed value becomes the stored one, `{value}` marking the hole:
    /// `"Bearer {value}"` means the user pastes a token, not a header.
    #[serde(default)]
    pub template: Option<String>,
    /// Pre-filled when the field is a path or a choice rather than a secret.
    #[serde(default)]
    pub default: Option<String>,
}

impl ConnectorField {
    /// Apply the field's template to what the user typed.
    pub fn render(&self, value: &str) -> String {
        match &self.template {
            Some(t) if t.contains("{value}") => t.replace("{value}", value),
            _ => value.to_string(),
        }
    }
}

/// A curated MCP server: everything needed to install it except the credential.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorEntry {
    /// Stable slug (`google-gmail`). Also the filename of an imported entry and
    /// the `catalog_id` written onto the installed server.
    pub id: String,
    pub name: String,
    pub description: String,
    /// Grouping for the picker — "Google", "Developer tools", "Web".
    #[serde(default)]
    pub category: Option<String>,
    /// "stdio" or "sse", matching `McpServer::transport`.
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: Vec<ConnectorField>,
    #[serde(default)]
    pub headers: Vec<ConnectorField>,
    /// What has to be true before this can work — "Node 18+ (for npx)", "a
    /// Google Cloud project with the Gmail API enabled". Shown before the form,
    /// because a missing prerequisite is the failure the form cannot explain.
    #[serde(default)]
    pub prerequisites: Vec<String>,
    /// The setup guide worth reading, for the cases prose can't compress.
    #[serde(default)]
    pub docs_url: Option<String>,
    /// Shipped with the app (vs. imported). Set by the loader, not by the file:
    /// a downloaded entry cannot promote itself to curated.
    #[serde(default)]
    pub curated: bool,
    /// Where an imported entry came from.
    #[serde(default)]
    pub source: Option<String>,
}

impl ConnectorEntry {
    fn validate(&self) -> AppResult<()> {
        if self.id.trim().is_empty() || self.name.trim().is_empty() {
            return Err(AppError::Invalid("a connector entry needs an id and a name".into()));
        }
        // The id becomes a filename. Keep it to something that cannot escape the
        // connectors directory or collide with a shipped entry by accident.
        if !self
            .id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(AppError::Invalid(format!(
                "connector id '{}' may only contain letters, digits, - and _",
                self.id
            )));
        }
        match self.transport.as_str() {
            "stdio" => {
                if self.command.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    return Err(AppError::Invalid(format!(
                        "connector '{}' is stdio but has no command",
                        self.id
                    )));
                }
            }
            "sse" | "http" => {
                if self.url.as_deref().map(str::trim).unwrap_or("").is_empty() {
                    return Err(AppError::Invalid(format!(
                        "connector '{}' is {} but has no url",
                        self.id, self.transport
                    )));
                }
            }
            other => {
                return Err(AppError::Invalid(format!(
                    "connector '{}' has unknown transport '{other}'",
                    self.id
                )))
            }
        }
        Ok(())
    }

    /// Every field the user has to fill, env and headers together.
    pub fn fields(&self) -> impl Iterator<Item = &ConnectorField> {
        self.env.iter().chain(self.headers.iter())
    }
}

pub fn connectors_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("connectors")
}

/// Parse the shipped entries. A failure here is a bug in a file we compiled in,
/// so it is logged and treated as an empty set rather than breaking the panel.
fn builtin() -> Vec<ConnectorEntry> {
    match serde_json::from_str::<Vec<ConnectorEntry>>(BUILTIN) {
        Ok(v) => v
            .into_iter()
            .map(|mut e| {
                e.curated = true;
                e
            })
            .collect(),
        Err(err) => {
            tracing::error!("built-in connector catalog is malformed: {err}");
            Vec::new()
        }
    }
}

/// The whole catalog: shipped entries plus every JSON file in the connectors
/// directory. A file whose id matches a shipped entry replaces it — that is how
/// a user corrects an entry that has gone stale between releases.
pub fn load(app_data_dir: &Path) -> Vec<ConnectorEntry> {
    let mut entries = builtin();
    let dir = connectors_dir(app_data_dir);
    if let Ok(read) = std::fs::read_dir(&dir) {
        for e in read.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read_to_string(&path).map_err(AppError::from).and_then(|t| {
                serde_json::from_str::<ConnectorEntry>(&t).map_err(|err| {
                    AppError::Invalid(format!("{}: {err}", path.display()))
                })
            }) {
                Ok(mut entry) => {
                    if entry.validate().is_err() {
                        tracing::warn!("skipping invalid connector file {path:?}");
                        continue;
                    }
                    entry.curated = false;
                    match entries.iter().position(|x| x.id == entry.id) {
                        Some(i) => entries[i] = entry,
                        None => entries.push(entry),
                    }
                }
                Err(err) => tracing::warn!("skipping bad connector file: {err}"),
            }
        }
    }
    entries.sort_by(|a, b| {
        a.category
            .as_deref()
            .unwrap_or("")
            .cmp(b.category.as_deref().unwrap_or(""))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

pub fn find(app_data_dir: &Path, id: &str) -> Option<ConnectorEntry> {
    load(app_data_dir).into_iter().find(|e| e.id == id)
}

/// Accept what an import actually finds at a URL: one entry, a bare array, or an
/// object with an `entries` array. Anything else is a clear error rather than a
/// silent empty import.
pub fn parse_import(text: &str) -> AppResult<Vec<ConnectorEntry>> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| AppError::Invalid(format!("that URL did not return JSON: {e}")))?;
    let list = match value {
        serde_json::Value::Array(_) => value,
        serde_json::Value::Object(ref map) => match map.get("entries").or_else(|| map.get("connectors")) {
            Some(v) => v.clone(),
            None => serde_json::Value::Array(vec![value.clone()]),
        },
        _ => return Err(AppError::Invalid("expected a connector entry or a list of them".into())),
    };
    let entries: Vec<ConnectorEntry> = serde_json::from_value(list)
        .map_err(|e| AppError::Invalid(format!("that is not a connector catalog: {e}")))?;
    if entries.is_empty() {
        return Err(AppError::Invalid("that catalog is empty".into()));
    }
    for entry in &entries {
        entry.validate()?;
    }
    Ok(entries)
}

/// Write imported entries into the connectors directory, one file per entry.
pub fn save(app_data_dir: &Path, entries: &[ConnectorEntry], source: Option<&str>) -> AppResult<()> {
    let dir = connectors_dir(app_data_dir);
    std::fs::create_dir_all(&dir)?;
    for entry in entries {
        let mut entry = entry.clone();
        // `curated` is the loader's to decide, and `source` records where this
        // came from so an entry that misbehaves can be traced back.
        entry.curated = false;
        if entry.source.is_none() {
            entry.source = source.map(str::to_string);
        }
        let path = dir.join(format!("{}.json", entry.id));
        std::fs::write(&path, serde_json::to_string_pretty(&entry)?)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shipped catalog is compiled in, so a typo in it is a compile-time
    /// asset that only fails at runtime. This is the test that catches it.
    #[test]
    fn builtin_catalog_parses_and_is_valid() {
        let entries = builtin();
        assert!(!entries.is_empty(), "the shipped catalog should not be empty");
        for e in &entries {
            e.validate().unwrap_or_else(|err| panic!("{}: {err}", e.id));
            assert!(e.curated, "{} should be marked curated by the loader", e.id);
            assert!(!e.description.trim().is_empty(), "{} needs a description", e.id);
            // A field the user cannot source is a form they cannot fill.
            for f in e.fields() {
                assert!(!f.label.trim().is_empty(), "{}/{} needs a label", e.id, f.key);
                if f.secret {
                    assert!(
                        f.credential_url.is_some() || e.docs_url.is_some(),
                        "{}/{} is a secret with nowhere to get it",
                        e.id,
                        f.key
                    );
                }
            }
        }
        let mut ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(count, ids.len(), "duplicate connector ids in the shipped catalog");
    }

    #[test]
    fn a_template_wraps_what_the_user_typed() {
        let f = ConnectorField {
            key: "Authorization".into(),
            label: "Access token".into(),
            description: None,
            credential_url: None,
            required: true,
            secret: true,
            template: Some("Bearer {value}".into()),
            default: None,
        };
        assert_eq!(f.render("abc123"), "Bearer abc123");
        let plain = ConnectorField { template: None, ..f };
        assert_eq!(plain.render("abc123"), "abc123");
    }

    #[test]
    fn import_accepts_one_entry_a_list_or_an_envelope() {
        let one = r#"{"id":"x","name":"X","description":"d","transport":"sse","url":"https://e/mcp"}"#;
        assert_eq!(parse_import(one).unwrap().len(), 1);
        assert_eq!(parse_import(&format!("[{one}]")).unwrap().len(), 1);
        assert_eq!(parse_import(&format!("{{\"entries\":[{one}]}}")).unwrap().len(), 1);
        assert!(parse_import("not json").is_err());
        assert!(parse_import("[]").is_err());
    }

    /// An id becomes a filename, so a traversal attempt in an imported catalog
    /// must be refused rather than written.
    #[test]
    fn an_id_cannot_escape_the_connectors_directory() {
        let bad = r#"{"id":"../../evil","name":"X","description":"d","transport":"sse","url":"https://e"}"#;
        assert!(parse_import(bad).is_err());
    }

    #[test]
    fn a_transport_without_its_target_is_refused() {
        let no_cmd = r#"{"id":"x","name":"X","description":"d","transport":"stdio"}"#;
        assert!(parse_import(no_cmd).is_err());
        let no_url = r#"{"id":"x","name":"X","description":"d","transport":"sse"}"#;
        assert!(parse_import(no_url).is_err());
    }
}
