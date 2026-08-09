//! The theme blob, described in Rust (0.11.3).
//!
//! Appearance has always been reachable over the API — `PATCH
//! /api/settings/theme` merges into the same row the window reads — but only in
//! the sense that a hex editor makes a file reachable. Nothing said which fields
//! exist, what a palette key is called, which effects are real, or that a value
//! out of range would be written happily and then clamped, ignored or rendered
//! as nothing at all. A caller had to guess, and a model guessed the same way it
//! guesses anything: fluently and wrong (`"colour"`, `"darkMode": true`,
//! `"backgroundEffect": "snow"`).
//!
//! So this file is the schema, in two halves that must stay together:
//!
//! - [`schema`] is served by `GET /api/theme`, so the surface documents itself
//!   the way `GET /api/routes` documents the routes — the same principle, one
//!   level down, and the reason `app_control`'s description does not need to
//!   grow a copy of it.
//! - [`validate_patch`] rejects what the schema does not describe, *naming the
//!   mistake*. A rejected patch that says "unknown field `colour` — did you mean
//!   `accent`?" is one retry; a silently accepted one is a user asking why the
//!   assistant said it changed the theme and nothing happened.
//!
//! It duplicates the defaults in `src/store/app.ts`, which is a real cost and
//! the smaller one: the alternative is the API answering "what can I set?" with
//! a shrug. The [`tests`] at the bottom pin the field list, so the copy fails
//! loudly rather than drifting quietly.

use serde_json::{json, Map, Value};

/// The palette entries a user may override, paired with the CSS variable each
/// drives — a mirror of `THEME_COLOR_KEYS` in the frontend store. The CSS
/// variable is carried because it is exactly what someone writing custom CSS
/// needs to know, and `GET /api/theme` is where they will look for it.
pub const COLOR_KEYS: &[(&str, &str)] = &[
    ("bg", "--color-bg"),
    ("panel", "--color-panel"),
    ("panelHover", "--color-panel-hover"),
    ("border", "--color-border"),
    ("text", "--color-text"),
    ("textMuted", "--color-text-muted"),
];

/// The base palettes, mirroring the `:root` and `html.light` blocks in
/// `styles.css`. Ordered as [`COLOR_KEYS`] is.
pub const DARK_BASE: [&str; 6] = ["#0b0d10", "#14171c", "#242a33", "#2d333d", "#e4e6eb", "#8b929e"];
pub const LIGHT_BASE: [&str; 6] = ["#fafafa", "#ffffff", "#e9edf2", "#d8dde4", "#1f2329", "#5b6573"];

pub const BACKGROUND_EFFECTS: &[&str] = &[
    "none", "particles", "orbs", "aurora", "grid", "stars", "shooting", "waves", "fireflies",
    "boids", "matrix", "topography", "puzzle", "mountains", "fish",
];

pub const GLASS_STYLES: &[&str] = &["frosted", "clear", "tinted"];

/// Matches `MAX_CUSTOM_CSS` in the frontend store. Not a security boundary — the
/// stylesheet is the user's own and runs in their own window either way — but a
/// sheet this long is a mistake rather than a preference, and refusing it here
/// means the window never has to decide what to do with one.
pub const MAX_CUSTOM_CSS: usize = 100_000;

/// One field of the theme blob, as `GET /api/theme` reports it.
struct Field {
    name: &'static str,
    kind: Kind,
    default: Value,
    doc: &'static str,
}

enum Kind {
    Bool,
    /// A CSS colour the app will paint. Hex only — the window writes these
    /// straight into inline styles, and `rebeccapurple` parsing differently in
    /// two places is a bug nobody will find.
    Color,
    /// A colour, or the literal `"accent"` meaning "follow the accent colour".
    ColorOrAccent,
    Number { min: f64, max: f64 },
    Enum(&'static [&'static str]),
    /// A map of [`COLOR_KEYS`] entries to colours. Replaces the stored map
    /// whole (the merge is top-level), so `{}` is how a caller clears it.
    Palette,
    Css,
}

impl Kind {
    fn describe(&self) -> Value {
        match self {
            Kind::Bool => json!({ "type": "boolean" }),
            Kind::Color => json!({ "type": "string", "format": "hex-color" }),
            Kind::ColorOrAccent => {
                json!({ "type": "string", "format": "hex-color", "orLiteral": "accent" })
            }
            Kind::Number { min, max } => json!({ "type": "number", "min": min, "max": max }),
            Kind::Enum(values) => json!({ "type": "string", "enum": values }),
            Kind::Palette => json!({
                "type": "object",
                "keys": COLOR_KEYS.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
                "values": "hex-color",
                "note": "replaces the stored map whole; send {} to reset every colour in it",
            }),
            Kind::Css => json!({ "type": "string", "maxLength": MAX_CUSTOM_CSS }),
        }
    }
}

fn fields() -> Vec<Field> {
    use Kind::*;
    vec![
        Field { name: "mode", kind: Enum(&["dark", "light"]), default: json!("dark"),
            doc: "Light or dark. Palette overrides are stored per mode, so this also swaps which of colorsDark/colorsLight is in force." },
        Field { name: "accent", kind: Color, default: json!("#4f9cf9"),
            doc: "The one colour everything interactive is drawn in." },
        Field { name: "colorsDark", kind: Palette, default: json!({}),
            doc: "Palette overrides used in dark mode. Anything left out falls back to the stylesheet." },
        Field { name: "colorsLight", kind: Palette, default: json!({}),
            doc: "Palette overrides used in light mode." },
        Field { name: "backgroundEffect", kind: Enum(BACKGROUND_EFFECTS), default: json!("none"),
            doc: "The animated background, drawn behind everything." },
        Field { name: "effectColor", kind: ColorOrAccent, default: json!("accent"),
            doc: "What colour the background effect is drawn in; \"accent\" follows the accent colour." },
        Field { name: "effectSpeed", kind: Number { min: 0.1, max: 3.0 }, default: json!(1.0),
            doc: "Multiplier on the effect's animation speed." },
        Field { name: "effectDensity", kind: Number { min: 10.0, max: 200.0 }, default: json!(60),
            doc: "How many elements the effect draws (for the grid, the cell size in px: 15–150)." },
        Field { name: "effectOpacity", kind: Number { min: 0.05, max: 1.0 }, default: json!(0.5),
            doc: "How strongly the effect shows through." },
        Field { name: "effectHue", kind: Number { min: 0.0, max: 180.0 }, default: json!(20),
            doc: "Degrees of hue spread around the effect colour; 0 paints everything one flat tone." },
        Field { name: "shadowsEnabled", kind: Bool, default: json!(true),
            doc: "Depth shadows on panels and cards." },
        Field { name: "bloomEnabled", kind: Bool, default: json!(false),
            doc: "Glow on interactive elements and accent colours." },
        Field { name: "bloomIntensity", kind: Number { min: 0.1, max: 1.0 }, default: json!(0.5),
            doc: "How far the bloom carries." },
        Field { name: "glassEnabled", kind: Bool, default: json!(false),
            doc: "Panels, menus and dialogs let the background through. Worth little with backgroundEffect \"none\" — there is nothing behind them to see." },
        Field { name: "glassStyle", kind: Enum(GLASS_STYLES), default: json!("frosted"),
            doc: "frosted: blurred and desaturated · clear: unblurred · tinted: frosted with the accent bled in." },
        Field { name: "glassStrength", kind: Number { min: 0.1, max: 1.0 }, default: json!(0.5),
            doc: "How far through the glass you can see." },
        Field { name: "customCssEnabled", kind: Bool, default: json!(false),
            doc: "Whether customCss is applied. Kept separate so a sheet can be switched off without being deleted." },
        Field { name: "customCss", kind: Css, default: json!(""),
            doc: "A stylesheet appended after the app's own, so an equally specific rule wins. Write colours as var(--color-panel) and friends (see `cssVariables`) or the sheet breaks the moment the user switches mode." },
    ]
}

/// The whole appearance surface, as `GET /api/theme` serves it: every field with
/// its type, range, default and a line saying what it is for, plus the CSS
/// variables custom CSS should be written against.
pub fn schema() -> Value {
    let described: Vec<Value> = fields()
        .into_iter()
        .map(|f| {
            let mut v = f.kind.describe();
            v["name"] = json!(f.name);
            v["default"] = f.default;
            v["description"] = json!(f.doc);
            v
        })
        .collect();

    let variables: Vec<Value> = COLOR_KEYS
        .iter()
        .enumerate()
        .map(|(i, (key, var))| {
            json!({
                "paletteKey": key,
                "cssVariable": var,
                "dark": DARK_BASE[i],
                "light": LIGHT_BASE[i],
            })
        })
        .chain(std::iter::once(json!({
            "paletteKey": "accent",
            "cssVariable": "--color-accent",
            "note": "set through the top-level `accent` field, not a palette map",
        })))
        .collect();

    json!({
        "settingsKey": "theme",
        "fields": described,
        "cssVariables": variables,
        "note": "PATCH /api/theme merges the fields you send and validates them. \
                 PATCH /api/settings/theme still writes the same row unvalidated.",
    })
}

/// Apply the app's defaults to a stored theme blob, so a reader sees the values
/// actually in force rather than only the ones that happen to have been written.
pub fn resolve(stored: Option<&str>) -> Value {
    let parsed = stored
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .and_then(|v| match v {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();

    let mut out = Map::new();
    for f in fields() {
        let value = parsed.get(f.name).cloned().unwrap_or(f.default);
        out.insert(f.name.to_string(), value);
    }
    // Anything the window persists that this file does not describe is still the
    // user's setting; hiding it would make a read-modify-write drop it.
    for (k, v) in parsed {
        out.entry(k).or_insert(v);
    }
    Value::Object(out)
}

/// Check a patch against the schema, returning the first thing wrong with it in
/// words a caller can act on.
pub fn validate_patch(patch: &Map<String, Value>) -> Result<(), String> {
    if patch.is_empty() {
        return Err("no fields to change — send at least one, e.g. {\"mode\":\"light\"}. \
                    GET /api/theme lists them all"
            .into());
    }
    let known = fields();
    for (key, value) in patch {
        let Some(field) = known.iter().find(|f| f.name == key) else {
            return Err(format!(
                "unknown theme field `{key}` — the fields are: {}. GET /api/theme describes each one",
                known.iter().map(|f| f.name).collect::<Vec<_>>().join(", "),
            ));
        };
        check(field, value).map_err(|why| format!("`{key}`: {why}"))?;
    }
    Ok(())
}

fn check(field: &Field, value: &Value) -> Result<(), String> {
    match &field.kind {
        Kind::Bool => value
            .as_bool()
            .map(|_| ())
            .ok_or_else(|| "must be true or false".to_string()),
        Kind::Color => as_color(value, false),
        Kind::ColorOrAccent => as_color(value, true),
        Kind::Number { min, max } => match value.as_f64() {
            Some(n) if n >= *min && n <= *max => Ok(()),
            Some(n) => Err(format!("{n} is outside {min}–{max}")),
            None => Err(format!("must be a number between {min} and {max}")),
        },
        Kind::Enum(values) => match value.as_str() {
            Some(s) if values.contains(&s) => Ok(()),
            _ => Err(format!("must be one of: {}", values.join(", "))),
        },
        Kind::Palette => {
            let Some(map) = value.as_object() else {
                return Err(format!(
                    "must be an object of palette keys to colours ({}), or {{}} to reset",
                    COLOR_KEYS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", "),
                ));
            };
            for (k, v) in map {
                if !COLOR_KEYS.iter().any(|(key, _)| key == k) {
                    return Err(format!(
                        "`{k}` is not a palette key — they are: {}",
                        COLOR_KEYS.iter().map(|(key, _)| *key).collect::<Vec<_>>().join(", "),
                    ));
                }
                as_color(v, false).map_err(|why| format!("`{k}` {why}"))?;
            }
            Ok(())
        }
        Kind::Css => match value.as_str() {
            Some(s) if s.len() <= MAX_CUSTOM_CSS => Ok(()),
            Some(s) => Err(format!(
                "{} characters is over the {MAX_CUSTOM_CSS} limit",
                s.len()
            )),
            None => Err("must be a string of CSS (\"\" to clear it)".into()),
        },
    }
}

/// `#rgb`, `#rrggbb` or `#rrggbbaa`, optionally the literal `accent`.
fn as_color(value: &Value, allow_accent: bool) -> Result<(), String> {
    let Some(s) = value.as_str() else {
        return Err("must be a hex colour string like \"#4f9cf9\"".into());
    };
    if allow_accent && s == "accent" {
        return Ok(());
    }
    let ok = s.starts_with('#')
        && matches!(s.len(), 4 | 7 | 9)
        && s[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else if allow_accent {
        Err(format!("`{s}` is not a hex colour like \"#4f9cf9\", nor the literal \"accent\""))
    } else {
        Err(format!("`{s}` is not a hex colour like \"#4f9cf9\""))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn patch(raw: &str) -> Map<String, Value> {
        match serde_json::from_str(raw).unwrap() {
            Value::Object(m) => m,
            _ => panic!("test patch must be an object"),
        }
    }

    /// The field list is a hand-copy of the frontend's `ThemePrefs`. Pin it, so
    /// a field added on one side and forgotten on the other is a failing test
    /// rather than an API that quietly cannot set it.
    #[test]
    fn the_documented_fields_are_the_ones_we_expect() {
        let names: Vec<&str> = fields().iter().map(|f| f.name).collect();
        assert_eq!(
            names,
            vec![
                "mode", "accent", "colorsDark", "colorsLight", "backgroundEffect", "effectColor",
                "effectSpeed", "effectDensity", "effectOpacity", "effectHue", "shadowsEnabled",
                "bloomEnabled", "bloomIntensity", "glassEnabled", "glassStyle", "glassStrength",
                "customCssEnabled", "customCss",
            ],
        );
    }

    #[test]
    fn good_patches_pass() {
        assert!(validate_patch(&patch(r#"{"mode":"light"}"#)).is_ok());
        assert!(validate_patch(&patch(r##"{"accent":"#fff"}"##)).is_ok());
        assert!(validate_patch(&patch(r#"{"effectColor":"accent"}"#)).is_ok());
        assert!(validate_patch(&patch(r##"{"colorsDark":{"panelHover":"#242a33"}}"##)).is_ok());
        assert!(validate_patch(&patch(r#"{"colorsLight":{}}"#)).is_ok());
        assert!(validate_patch(
            &patch(r#"{"customCss":".sidebar{width:220px}","customCssEnabled":true}"#)
        )
        .is_ok());
    }

    /// Each of these is a mistake a caller actually makes; the point of the
    /// check is that the answer names it rather than accepting the write.
    #[test]
    fn bad_patches_say_what_is_wrong() {
        let cases = [
            (r#"{}"#, "no fields"),
            (r##"{"colour":"#fff"}"##, "unknown theme field `colour`"),
            (r#"{"mode":"midnight"}"#, "one of: dark, light"),
            (r#"{"mode":true}"#, "one of: dark, light"),
            (r#"{"accent":"rebeccapurple"}"#, "not a hex colour"),
            (r#"{"effectSpeed":12}"#, "outside 0.1–3"),
            (r#"{"backgroundEffect":"snow"}"#, "must be one of"),
            (r##"{"colorsDark":{"sidebar":"#fff"}}"##, "not a palette key"),
            (r#"{"colorsDark":{"panel":"blue"}}"#, "not a hex colour"),
            (r##"{"colorsDark":"#fff"}"##, "must be an object"),
            (r#"{"shadowsEnabled":"yes"}"#, "true or false"),
            (r#"{"customCss":42}"#, "must be a string"),
        ];
        for (raw, expected) in cases {
            let err = validate_patch(&patch(raw)).expect_err(raw);
            assert!(err.contains(expected), "{raw} → {err:?}, expected to mention {expected:?}");
        }
    }

    #[test]
    fn a_custom_sheet_over_the_limit_is_refused() {
        let long = "a".repeat(MAX_CUSTOM_CSS + 1);
        let err = validate_patch(&patch(&json!({ "customCss": long }).to_string())).unwrap_err();
        assert!(err.contains("over the"), "{err}");
    }

    /// A read has to show the values in force, not only the written ones —
    /// otherwise a caller reading before writing sees "no effect configured"
    /// where the app is drawing one from its defaults.
    #[test]
    fn resolve_fills_in_defaults_and_keeps_unknown_keys() {
        let v = resolve(Some(r#"{"mode":"light","somethingNewer":7}"#));
        assert_eq!(v["mode"], json!("light"));
        assert_eq!(v["accent"], json!("#4f9cf9")); // default, not written
        assert_eq!(v["customCssEnabled"], json!(false));
        assert_eq!(v["somethingNewer"], json!(7)); // not ours to drop
        // An absent or unparseable row is the full set of defaults.
        assert_eq!(resolve(None)["mode"], json!("dark"));
        assert_eq!(resolve(Some("not json"))["backgroundEffect"], json!("none"));
    }

    /// The palette table is what someone writing custom CSS reads to find out
    /// what to target, so every key must carry its variable and both bases.
    #[test]
    fn the_schema_documents_every_css_variable() {
        let s = schema();
        let vars = s["cssVariables"].as_array().unwrap();
        assert_eq!(vars.len(), COLOR_KEYS.len() + 1); // + accent
        assert_eq!(DARK_BASE.len(), COLOR_KEYS.len());
        assert_eq!(LIGHT_BASE.len(), COLOR_KEYS.len());
        assert!(vars.iter().any(|v| v["cssVariable"] == "--color-panel-hover"));
        assert!(vars.iter().any(|v| v["cssVariable"] == "--color-accent"));
    }
}
