//! Thinking, per model (0.17.9).
//!
//! Two things live here. The first is the older one: helpers for the inline
//! `<think>` / `<thinking>` / `<reasoning>` tags that some models (Gemma, Qwen
//! QwQ, DeepSeek distills) emit inside the regular `content` stream. Providers
//! that split thinking into a separate `reasoning_content` field handle this at
//! the protocol layer and don't go through those helpers.
//!
//! The second is [`profile`]: how to *ask* a given model to think, or not.
//! There is no portable switch. OpenAI's reasoning models and most hosted
//! gateways read `reasoning_effort`; local servers (vLLM, SGLang, llama.cpp,
//! LM Studio) hand `chat_template_kwargs: {enable_thinking}` to the chat
//! template, which is how Qwen3 and the DeepSeek distills are turned on and
//! off; Gemma thinks inline and takes no parameter at all; QwQ and R1 think
//! whether asked or not; and gpt-4o has nothing to turn on — OpenAI answers
//! `reasoning_effort` on it with a 400. Until now every zone with thinking on
//! sent `reasoning_effort: "medium"` to whatever model it named, which was
//! right for one of those families and wrong, sometimes fatally, for the rest.
//!
//! The profile is a best first guess, not a promise: model names are free text
//! and providers change. So the client treats a rejected request that carried
//! thinking fields as evidence, retries without them, and remembers (see
//! `LlmClient::chat_stream_once`). The guess only has to be right often enough
//! that the retry is rare.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// The knob a model exposes for its reasoning, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Control {
    /// `reasoning_effort` with a level. OpenAI o-series/gpt-5/gpt-oss, Claude
    /// and Gemini through OpenAI-compatible gateways, Grok's mini models.
    Effort,
    /// `reasoning: {"effort": level}` — OpenRouter's shape, and the one several
    /// routers copied (0.18.1).
    ReasoningObject,
    /// `thinking: {"type": "enabled" | "disabled"}` — GLM on Z.ai, DeepSeek and
    /// Kimi on the hosts that expose a switch (0.18.1).
    ThinkingObject,
    /// A top-level `enable_thinking: bool` — DashScope and SiliconFlow's Qwen
    /// (0.18.1).
    EnableThinking,
    /// `chat_template_kwargs: {"enable_thinking": bool}` — a local server's
    /// chat template decides. Qwen3, DeepSeek distills, GLM, Nemotron.
    Toggle,
    /// Thinks inline in `<think>` tags with no parameter to speak of. Gemma.
    Inline,
    /// Reasons whether or not it is asked (QwQ, R1, Magistral): nothing is
    /// sent, and the switch only decides whether the thinking is shown.
    Always,
    /// Has no reasoning mode at all. Nothing is sent, the switch is inert.
    None,
}

/// How to talk to one model about thinking, as the zone editor shows it and
/// the request builder applies it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// Human name of the family the model was matched to, for the editor.
    pub family: &'static str,
    pub control: Control,
    /// Effort levels the model accepts, in ascending order; empty unless
    /// `control` is `Effort`.
    pub levels: Vec<&'static str>,
    /// Whether "off" can actually be expressed to this model.
    pub can_disable: bool,
    /// One line for the editor: what the switch will do for this model.
    pub note: String,
}

/// The request fields that carry a decision, ready to drop into `ChatRequest`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Controls {
    pub reasoning_effort: Option<String>,
    pub chat_template_kwargs: Option<Value>,
    /// Other top-level fields: `reasoning`, `thinking`, `enable_thinking`.
    pub extra: Map<String, Value>,
    /// Watch the content stream for inline `<think>` tags and split them out.
    pub parse_inline: bool,
    /// Set when the shape was a guess the client may swap for the next one in
    /// [`FALLBACK_CHAIN`] if the provider refuses it.
    pub ask: Option<Ask>,
}

/// What a zone asked for, kept so a refused shape can be re-expressed.
#[derive(Debug, Clone, PartialEq)]
pub struct Ask {
    pub enabled: bool,
    pub level: String,
    pub style: Control,
    pub family: &'static str,
}

/// The hosted shapes, in the order a refusal walks them (0.18.1). Every one
/// is some gateway's native dialect, and a gateway that does not understand a
/// field usually says so with a 400 — which is what lets the client move on
/// instead of giving up on thinking altogether.
pub const FALLBACK_CHAIN: &[Control] =
    &[Control::Effort, Control::ReasoningObject, Control::ThinkingObject, Control::EnableThinking];

/// Evidence beyond the name: the user's per-model choice, and whether the
/// models.dev catalogue lists the model as a reasoning model.
#[derive(Debug, Clone, Copy, Default)]
pub struct Hint {
    pub control: Option<Control>,
    pub catalog_reasoning: Option<bool>,
}

/// Is this base URL a server on this machine or LAN, rather than a hosted API?
/// Local servers are the ones that read `chat_template_kwargs`.
pub fn is_local_server(base_url: &str) -> bool {
    let host = base_url
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .split('/')
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("")
        .to_lowercase();
    // `[::1]:8000` keeps its colons; anything else loses the port.
    let name = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    name == "localhost"
        || name == "0.0.0.0"
        || name == "::1"
        || name.starts_with("127.")
        || name.starts_with("10.")
        || name.starts_with("192.168.")
        || name.ends_with(".local")
        || name.ends_with(".lan")
        || name.ends_with(".internal")
        || (name.starts_with("172.")
            && name
                .split('.')
                .nth(1)
                .and_then(|s| s.parse::<u8>().ok())
                .is_some_and(|n| (16..=31).contains(&n)))
        || host.starts_with("host.docker.internal")
}

/// Work out the family and its knob from a model name and where it is served,
/// corrected by what the user chose and what the catalogue says.
pub fn profile_with(model: &str, base_url: &str, hint: Hint) -> Profile {
    let mut p = guess(model, base_url);
    if let Some(control) = hint.control {
        p.control = control;
        p.levels = match control {
            Control::Effort | Control::ReasoningObject if p.levels.is_empty() => vec!["low", "medium", "high"],
            Control::Effort | Control::ReasoningObject => p.levels,
            _ => vec![],
        };
        p.can_disable = !matches!(control, Control::Always | Control::None | Control::Inline);
        p.note = format!("Set by you: {}.", describe(control));
        return p;
    }
    // An unrecognised model is the case the catalogue can settle: it knows
    // most gateway models by id, and whether they reason.
    if p.family == "hosted model" {
        match hint.catalog_reasoning {
            Some(false) => {
                p.control = Control::None;
                p.levels = vec![];
                p.note = "The models.dev catalogue lists this model as not reasoning; nothing is sent.".into();
            }
            Some(true) => {
                p.family = "reasoning model";
                p.note = "The models.dev catalogue lists this as a reasoning model. Asked as reasoning_effort first; a gateway that refuses it is tried with the other common shapes.".into();
            }
            None => {}
        }
    }
    p
}

/// What a shape sends, for the editor's note.
fn describe(control: Control) -> &'static str {
    match control {
        Control::Effort => "sent as reasoning_effort",
        Control::ReasoningObject => "sent as reasoning: {effort}",
        Control::ThinkingObject => "sent as thinking: {type: enabled/disabled}",
        Control::EnableThinking => "sent as enable_thinking",
        Control::Toggle => "sent as chat_template_kwargs.enable_thinking",
        Control::Inline => "read from inline <think> tags, nothing sent",
        Control::Always => "the model always reasons, nothing sent",
        Control::None => "nothing is sent",
    }
}

fn guess(model: &str, base_url: &str) -> Profile {
    let m = model.to_lowercase();
    // Gateways prefix a vendor ("openai/gpt-5", "anthropic/claude-…"); the
    // last path segment is the model that decides.
    let leaf = m.rsplit('/').next().unwrap_or(&m).to_string();
    let local = is_local_server(base_url);
    let has = |needle: &str| m.contains(needle);
    let levels3 = vec!["low", "medium", "high"];

    let p = |family: &'static str, control: Control, levels: Vec<&'static str>, can_disable: bool, note: String| Profile {
        family,
        control,
        levels,
        can_disable,
        note,
    };

    if has("gemma") {
        return p("Gemma", Control::Inline, vec![], false,
            "Gemma thinks inline in <think> tags and takes no parameter; the switch decides whether that is shown as a step.".into());
    }
    if has("gpt-oss") {
        return p("gpt-oss", Control::Effort, levels3, false,
            "gpt-oss always reasons; the level sets how much (sent as reasoning_effort). Off sends 'low'.".into());
    }
    if has("gpt-4") || has("gpt-3.5") || has("chatgpt") {
        return p("GPT-4 class", Control::None, vec![], true,
            "This model has no reasoning mode; nothing is sent and the switch is ignored.".into());
    }
    if has("gpt-5") || has("codex") {
        return p("GPT-5", Control::Effort, vec!["minimal", "low", "medium", "high"], true,
            "Sent as reasoning_effort. Off sends 'minimal', the least this family can do.".into());
    }
    if leaf.starts_with("o1") || leaf.starts_with("o3") || leaf.starts_with("o4") {
        return p("OpenAI o-series", Control::Effort, levels3, false,
            "Always reasons; the level is sent as reasoning_effort. Off sends nothing and the model uses its default.".into());
    }
    if has("claude") {
        return p("Claude", Control::Effort, levels3, true,
            "Extended thinking, asked for as reasoning_effort (Anthropic's and OpenRouter's OpenAI-compatible endpoints both read it). Off sends nothing: Claude does not think unless asked.".into());
    }
    if has("gemini") {
        return p("Gemini", Control::Effort, levels3, true,
            "Sent as reasoning_effort; off sends 'none' (2.5 Flash honours it; Pro cannot stop thinking and the app falls back to the default).".into());
    }
    if has("grok") {
        return p("Grok", Control::Effort, vec!["low", "high"], false,
            "Grok's mini models take reasoning_effort low or high (medium is sent as high); the larger ones reason regardless and the field is dropped if refused.".into());
    }
    if has("qwq") || has("r1") || has("magistral") || has("-thinking") || has("reasoner") {
        return p("always-reasoning", Control::Always, vec![], false,
            "This model reasons whether or not it is asked; nothing is sent, and the switch decides whether the thinking is shown.".into());
    }
    if has("qwen") || has("deepseek") || has("glm") || has("nemotron") || has("smollm") || has("exaone") {
        return if local {
            p("Qwen/DeepSeek class (local)", Control::Toggle, vec![], true,
                "Switched with enable_thinking in chat_template_kwargs, which vLLM, SGLang, llama.cpp and LM Studio hand to the chat template.".into())
        } else {
            p("Qwen/DeepSeek class (hosted)", Control::Effort, levels3, true,
                "Hosted, so asked for as reasoning_effort; providers that reject it get the request again without it.".into())
        };
    }
    if local {
        p("local model", Control::Toggle, vec![], true,
            "Unrecognised model on a local server: switched with enable_thinking in chat_template_kwargs, which a template that does not read it ignores.".into())
    } else {
        p("hosted model", Control::Effort, levels3, true,
            "Unrecognised hosted model: asked as reasoning_effort first; a gateway that refuses it is tried with reasoning, thinking and enable_thinking in turn. If none works, set the parameter by hand.".into())
    }
}

/// [`controls_with`] with no hint: the tests' shorthand.
#[cfg(test)]
pub fn controls(model: &str, base_url: &str, enabled: bool, effort: &str) -> Controls {
    controls_with(model, base_url, enabled, effort, Hint::default())
}

/// Turn a zone's switch and level into request fields for this model, with
/// the user's choice and the catalogue taken into account.
///
/// `effort` is the zone's level (`low`/`medium`/`high`); a level the model does
/// not offer is snapped to the nearest one it does. Only a hosted guess
/// carries an [`Ask`]: a shape the user picked is theirs, and a local server
/// ignores what it does not read rather than refusing it.
pub fn controls_with(model: &str, base_url: &str, enabled: bool, effort: &str, hint: Hint) -> Controls {
    let prof = profile_with(model, base_url, hint);
    let level = snap_level(&effort.trim().to_lowercase(), &prof.levels);
    let mut c = fields_for(prof.control, enabled, &level, prof.family);
    let sends_something =
        c.reasoning_effort.is_some() || c.chat_template_kwargs.is_some() || !c.extra.is_empty();
    if hint.control.is_none() && sends_something && FALLBACK_CHAIN.contains(&prof.control) && enabled {
        c.ask = Some(Ask { enabled, level, style: prof.control, family: prof.family });
    }
    c
}

/// The request fields one shape uses to say "think at this level" or "don't".
pub fn fields_for(style: Control, enabled: bool, level: &str, family: &'static str) -> Controls {
    let mut c = Controls::default();
    match style {
        Control::Inline => c.parse_inline = enabled,
        Control::None | Control::Always => {}
        Control::Toggle => c.chat_template_kwargs = Some(json!({ "enable_thinking": enabled })),
        Control::Effort => {
            c.reasoning_effort = if enabled {
                Some(level.to_string())
            } else {
                match family {
                    "gpt-oss" => Some("low".to_string()),
                    "GPT-5" => Some("minimal".to_string()),
                    "Gemini" => Some("none".to_string()),
                    _ => None,
                }
            };
        }
        Control::ReasoningObject => {
            let v = if enabled { json!({ "effort": level }) } else { json!({ "enabled": false }) };
            c.extra.insert("reasoning".into(), v);
        }
        Control::ThinkingObject => {
            let t = if enabled { "enabled" } else { "disabled" };
            c.extra.insert("thinking".into(), json!({ "type": t }));
        }
        Control::EnableThinking => {
            c.extra.insert("enable_thinking".into(), json!(enabled));
        }
    }
    c
}

/// The shape to try after `style` was refused, if any is left.
pub fn next_style(style: Control) -> Option<Control> {
    let i = FALLBACK_CHAIN.iter().position(|c| *c == style)?;
    FALLBACK_CHAIN.get(i + 1).copied()
}

/// The nearest level a model offers to the one asked for. Levels are ordered
/// ascending, so an unknown or middling request lands in the middle.
fn snap_level(asked: &str, levels: &[&str]) -> String {
    if levels.iter().any(|l| *l == asked) {
        return asked.to_string();
    }
    let rank = match asked {
        "none" | "minimal" => 0.0,
        "low" => 0.25,
        "high" => 1.0,
        _ => 0.5,
    };
    if levels.is_empty() {
        return "medium".into();
    }
    let idx = ((levels.len() - 1) as f64 * rank).round() as usize;
    levels[idx.min(levels.len() - 1)].to_string()
}

/// Does a provider's rejection name one of the thinking fields? Used to blame
/// the right field when a request carries several optional ones.
pub fn rejection_names_thinking(body: &str) -> bool {
    let b = body.to_lowercase();
    b.contains("reasoning_effort")
        || b.contains("reasoning.effort")
        || b.contains("chat_template_kwargs")
        || b.contains("enable_thinking")
        || b.contains("reasoning")
        || b.contains("thinking")
}

// ── Inline tags ──────────────────────────────────────────────────────────────

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
    fn local_servers_are_recognised_by_host() {
        assert!(is_local_server("http://localhost:1234/v1"));
        assert!(is_local_server("http://127.0.0.1:11434/v1"));
        assert!(is_local_server("http://192.168.1.20:8080/v1"));
        assert!(is_local_server("http://172.20.0.5:8000/v1"));
        assert!(is_local_server("http://[::1]:8000/v1"));
        assert!(is_local_server("http://box.local:8000"));
        assert!(!is_local_server("https://api.openai.com/v1"));
        assert!(!is_local_server("https://172.5.5.5/v1"));
    }

    #[test]
    fn a_refused_guess_walks_the_other_shapes() {
        let c = controls("mystery-9000", "https://gateway.example.com/v1", true, "high");
        let ask = c.ask.expect("a hosted guess can be re-expressed");
        assert_eq!(ask.style, Control::Effort);
        assert_eq!(next_style(Control::Effort), Some(Control::ReasoningObject));
        assert_eq!(next_style(Control::EnableThinking), None);
        let r = fields_for(Control::ReasoningObject, true, "high", ask.family);
        assert_eq!(r.extra.get("reasoning"), Some(&json!({ "effort": "high" })));
        let t = fields_for(Control::ThinkingObject, false, "high", ask.family);
        assert_eq!(t.extra.get("thinking"), Some(&json!({ "type": "disabled" })));
    }

    #[test]
    fn a_users_choice_is_sent_as_chosen_and_never_swapped() {
        let hint = Hint { control: Some(Control::ThinkingObject), catalog_reasoning: None };
        let c = controls_with("glm-4.6", "https://opencode.ai/zen/go/v1", true, "medium", hint);
        assert_eq!(c.extra.get("thinking"), Some(&json!({ "type": "enabled" })));
        assert_eq!(c.reasoning_effort, None);
        assert!(c.ask.is_none());
    }

    #[test]
    fn the_catalogue_settles_an_unrecognised_model() {
        let no = Hint { control: None, catalog_reasoning: Some(false) };
        assert_eq!(profile_with("mystery-9000", "https://x.example/v1", no).control, Control::None);
        let yes = Hint { control: None, catalog_reasoning: Some(true) };
        assert_eq!(profile_with("mystery-9000", "https://x.example/v1", yes).family, "reasoning model");
    }

    #[test]
    fn gpt4o_never_gets_a_reasoning_field() {
        let c = controls("gpt-4o", "https://api.openai.com/v1", true, "high");
        assert_eq!(c, Controls::default());
    }

    #[test]
    fn o_series_takes_effort_and_cannot_be_turned_off() {
        let on = controls("openai/o3-mini", "https://openrouter.ai/api/v1", true, "high");
        assert_eq!(on.reasoning_effort.as_deref(), Some("high"));
        let off = controls("o3-mini", "https://api.openai.com/v1", false, "high");
        assert_eq!(off.reasoning_effort, None);
    }

    #[test]
    fn gpt5_off_is_minimal() {
        let off = controls("gpt-5", "https://api.openai.com/v1", false, "medium");
        assert_eq!(off.reasoning_effort.as_deref(), Some("minimal"));
    }

    #[test]
    fn local_qwen_is_toggled_through_the_template() {
        let on = controls("qwen3-30b-a3b", "http://localhost:1234/v1", true, "medium");
        assert_eq!(on.chat_template_kwargs, Some(json!({ "enable_thinking": true })));
        assert_eq!(on.reasoning_effort, None);
        let off = controls("qwen3-30b-a3b", "http://localhost:1234/v1", false, "medium");
        assert_eq!(off.chat_template_kwargs, Some(json!({ "enable_thinking": false })));
    }

    #[test]
    fn hosted_qwen_uses_effort() {
        let on = controls("qwen/qwen3-235b", "https://openrouter.ai/api/v1", true, "low");
        assert_eq!(on.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(on.chat_template_kwargs, None);
    }

    #[test]
    fn gemma_is_inline_only() {
        let on = controls("gemma-3-27b-it", "http://localhost:11434/v1", true, "high");
        assert!(on.parse_inline);
        assert_eq!(on.reasoning_effort, None);
        assert_eq!(on.chat_template_kwargs, None);
        assert!(!controls("gemma-3-27b-it", "http://localhost:11434/v1", false, "high").parse_inline);
    }

    #[test]
    fn always_reasoning_models_are_left_alone() {
        assert_eq!(controls("deepseek-r1:14b", "http://localhost:11434/v1", true, "high"), Controls::default());
        assert_eq!(controls("qwq-32b", "http://localhost:1234/v1", false, "high"), Controls::default());
    }

    #[test]
    fn grok_snaps_medium_to_high() {
        let c = controls("grok-3-mini", "https://api.x.ai/v1", true, "medium");
        assert_eq!(c.reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn unknown_hosted_model_sends_nothing_when_off() {
        let off = controls("mystery-9000", "https://api.example.com/v1", false, "medium");
        assert_eq!(off, Controls::default());
        let on = controls("mystery-9000", "https://api.example.com/v1", true, "medium");
        assert_eq!(on.reasoning_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn rejections_are_attributed() {
        assert!(rejection_names_thinking(r#"{"error":{"message":"Unsupported parameter: 'reasoning_effort'"}}"#));
        assert!(!rejection_names_thinking(r#"{"error":{"message":"Unrecognized request argument supplied: stream_options"}}"#));
    }

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
