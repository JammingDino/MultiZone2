//! Token accounting on the assembled request (0.9.13).
//!
//! What was wrong with counting from stored messages: it measured the visible
//! conversation and then had the baseline (system prompt, skills, memories, tool
//! schemas) bolted on beside it from a second code path. Two paths that both
//! *describe* a request rather than reading one, and anything that only exists
//! at send time — the wrap-up nudges, mid-turn steers, a compacted history, the
//! hidden parts, a zone switched mid-turn — was counted by neither.
//!
//! So the measurement moved to the last thing that happens before the request
//! goes out. [`measure_request`] takes the `ChatRequest` itself: whatever is in
//! it is counted, because it is the thing being sent. Nothing to keep in sync.
//!
//! It is still an estimate — there is no tokenizer for an arbitrary local model
//! — but two things sharpen it. Providers that support `include_usage` send back
//! their own exact counts, which are preferred whenever they arrive; and those
//! counts are fed to [`record_calibration`], which learns each model's real
//! chars-per-token so the estimate used for providers that *don't* report stops
//! being a prose rule of thumb applied to JSON.

use crate::error::AppResult;
use crate::llm::types::{ChatMessage, ChatRequest, ContentPart, MessageContent, Usage};
use sqlx::SqlitePool;

/// Fallback chars-per-token before a model has reported anything. The familiar
/// ~4 holds for English prose; these payloads are mostly JSON schemas, code and
/// file listings, which run denser, so a request measured with this default
/// tends to read slightly high rather than low. Calibration replaces it.
pub const DEFAULT_CHARS_PER_TOKEN: f64 = 4.0;

/// Per-message envelope: the role marker and delimiters a chat template wraps
/// around every message. Small, but a history of two hundred short tool results
/// is a few thousand tokens of pure envelope, which the old estimate dropped.
const PER_MESSAGE_TOKENS: i64 = 4;

/// Flat per-image cost. An image contributes no text to measure, and its data
/// URL is megabytes of base64 that the model never reads as text — counting
/// those characters would swamp everything else. Matches `IMAGE_TOKEN_ESTIMATE`
/// in the frontend.
const IMAGE_TOKENS: i64 = 1000;

/// Believable bounds for a learned chars-per-token ratio. A model that reports
/// nonsense (or a single freak sample) must not be able to drag the estimate
/// somewhere absurd, so the learned value is clamped rather than trusted.
const MIN_CHARS_PER_TOKEN: f64 = 1.5;
const MAX_CHARS_PER_TOKEN: f64 = 8.0;

/// What one outgoing request carries, split by where it came from.
///
/// `input_tokens` is the whole prompt — system, history and schemas together —
/// because that is what the provider bills as `prompt_tokens`. The parts are
/// reported alongside it so the meter can still say *why* a request is large.
#[derive(Debug, Clone, Default)]
pub struct RequestMeasure {
    /// Everything the model reads: the entire assembled prompt.
    pub input_tokens: i64,
    /// The system messages within it.
    pub system_tokens: i64,
    /// The conversation within it — user turns, assistant turns, tool results.
    pub history_tokens: i64,
    /// The tool schemas offered with it. Re-sent on every step, and for a
    /// well-equipped zone usually the largest single item.
    pub tools_tokens: i64,
    pub tool_count: i64,
    pub message_count: i64,
    /// Characters measured, before the chars-per-token division. Kept so a
    /// request whose provider reports real usage can calibrate the ratio.
    pub payload_chars: i64,
    /// Images are priced flat, so their cost is excluded from `payload_chars`
    /// and must not be fed back into calibration.
    pub image_tokens: i64,
}

/// Characters of text in one message, plus how many images it carries.
fn message_chars(m: &ChatMessage) -> (i64, i64) {
    let mut chars = 0i64;
    let mut images = 0i64;

    match &m.content {
        Some(MessageContent::Text(t)) => chars += t.chars().count() as i64,
        Some(MessageContent::Parts(parts)) => {
            for p in parts {
                match p {
                    ContentPart::Text { text } | ContentPart::HiddenText { text } => {
                        chars += text.chars().count() as i64;
                    }
                    ContentPart::ImageUrl { .. } | ContentPart::HiddenImage { .. } => images += 1,
                }
            }
        }
        None => {}
    }

    // A tool call the model made earlier is replayed to it as part of the
    // history, so on the way *out* it is prompt, not completion.
    for c in m.tool_calls.iter().flatten() {
        chars += c.function.name.chars().count() as i64;
        chars += c.function.arguments.chars().count() as i64;
    }
    if let Some(id) = &m.tool_call_id {
        chars += id.chars().count() as i64;
    }
    if let Some(name) = &m.name {
        chars += name.chars().count() as i64;
    }

    (chars, images)
}

/// Measure a fully-assembled request. Call it immediately before sending: the
/// point of this function is that it reads the real thing rather than rebuilding
/// a description of it.
pub fn measure_request(req: &ChatRequest, chars_per_token: f64) -> RequestMeasure {
    let cpt = chars_per_token.clamp(MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN);
    let to_tokens = |chars: i64| -> i64 {
        if chars <= 0 {
            return 0;
        }
        std::cmp::max(1, (chars as f64 / cpt).round() as i64)
    };

    let mut system_chars = 0i64;
    let mut history_chars = 0i64;
    let mut images = 0i64;

    for m in &req.messages {
        let (chars, imgs) = message_chars(m);
        images += imgs;
        if m.role == "system" || m.role == "developer" {
            system_chars += chars;
        } else {
            history_chars += chars;
        }
    }

    // The schemas go on the wire as JSON, so their JSON is what to measure —
    // punctuation, nesting and all. Nothing else in the request is measured
    // this way because nothing else is sent verbatim as JSON.
    let (tools_chars, tool_count) = match &req.tools {
        Some(tools) if !tools.is_empty() => (
            serde_json::to_string(tools).map_or(0, |s| s.chars().count() as i64),
            tools.len() as i64,
        ),
        _ => (0, 0),
    };

    let message_count = req.messages.len() as i64;
    let envelope = message_count * PER_MESSAGE_TOKENS;
    let image_tokens = images * IMAGE_TOKENS;

    let system_tokens = to_tokens(system_chars);
    let history_tokens = to_tokens(history_chars) + image_tokens;
    let tools_tokens = to_tokens(tools_chars);

    RequestMeasure {
        input_tokens: system_tokens + history_tokens + tools_tokens + envelope,
        system_tokens,
        history_tokens,
        tools_tokens,
        tool_count,
        message_count,
        payload_chars: system_chars + history_chars + tools_chars,
        image_tokens,
    }
}

/// The chars-per-token ratio learned for `model`, or the default if it has never
/// reported real usage.
pub async fn chars_per_token(db: &SqlitePool, model: &str) -> f64 {
    let row: Option<(i64, i64)> = sqlx::query_as(
        "SELECT payload_chars, prompt_tokens FROM model_token_calibration WHERE model = ?1",
    )
    .bind(model)
    .fetch_optional(db)
    .await
    .unwrap_or(None);

    match row {
        Some((chars, tokens)) if chars > 0 && tokens > 0 => {
            (chars as f64 / tokens as f64).clamp(MIN_CHARS_PER_TOKEN, MAX_CHARS_PER_TOKEN)
        }
        _ => DEFAULT_CHARS_PER_TOKEN,
    }
}

/// Teach a model's ratio from one request the provider counted for us.
///
/// Only the flat-priced image cost is subtracted before comparing; everything
/// else in `payload_chars` is text the tokenizer actually saw. Best-effort, like
/// every other statistic here — a failed write costs accuracy on the next
/// estimate and nothing else.
pub async fn record_calibration(db: &SqlitePool, model: &str, measure: &RequestMeasure, usage: &Usage) {
    // A request that was mostly image has almost no text to learn from, and
    // dividing by what's left would teach the model a wild ratio.
    let text_tokens = usage.prompt_tokens - measure.image_tokens;
    if measure.payload_chars <= 0 || text_tokens <= 0 {
        return;
    }

    let res = sqlx::query(
        "INSERT INTO model_token_calibration (model, payload_chars, prompt_tokens, samples, updated_at)
         VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(model) DO UPDATE SET
           payload_chars = payload_chars + ?2,
           prompt_tokens = prompt_tokens + ?3,
           samples       = samples + 1,
           updated_at    = ?4",
    )
    .bind(model)
    .bind(measure.payload_chars)
    .bind(text_tokens)
    .bind(chrono::Utc::now().timestamp())
    .execute(db)
    .await;

    if let Err(e) = res {
        tracing::debug!("token calibration: failed to record for {model}: {e}");
    }
}

/// Add one request to a chat's running totals.
///
/// `usage` is the provider's own block when it sent one. When it didn't, the
/// local estimate stands in and `reported_requests` is left alone, so the
/// meter can say how much of a total is measured rather than guessed.
///
/// Best-effort: a turn is never failed over a counter.
pub async fn record_request(
    db: &SqlitePool,
    chat_id: &str,
    model: &str,
    measure: &RequestMeasure,
    usage: Option<&Usage>,
) {
    let reported = usage.filter(|u| !u.is_empty());
    let (input, output, cached) = match reported {
        Some(u) => (u.prompt_tokens, u.completion_tokens, u.cached_prompt_tokens()),
        None => (measure.input_tokens, 0, 0),
    };

    // The estimate against the provider's own count, per request, with the
    // breakdown that explains the size. When someone reports the meter reading
    // wrong, this is the log line that says whether the estimator drifted or
    // whether they are comparing a context to an invoice.
    tracing::debug!(
        chat = chat_id,
        model,
        estimated = measure.input_tokens,
        reported = input,
        cached,
        system = measure.system_tokens,
        history = measure.history_tokens,
        tools = measure.tools_tokens,
        tool_count = measure.tool_count,
        messages = measure.message_count,
        "request token usage",
    );

    if let Some(u) = reported {
        record_calibration(db, model, measure, u).await;
    }

    let now = chrono::Utc::now().timestamp();
    let res = sqlx::query(
        "INSERT INTO chat_usage (chat_id, requests, reported_requests, input_tokens,
                                 cached_input_tokens, output_tokens, last_input_tokens,
                                 last_request_at, updated_at)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?3, ?6, ?6)
         ON CONFLICT(chat_id) DO UPDATE SET
           requests            = requests + 1,
           reported_requests   = reported_requests + ?2,
           input_tokens        = input_tokens + ?3,
           cached_input_tokens = cached_input_tokens + ?4,
           output_tokens       = output_tokens + ?5,
           last_input_tokens   = ?3,
           last_request_at     = ?6,
           updated_at          = ?6",
    )
    .bind(chat_id)
    .bind(i64::from(reported.is_some()))
    .bind(input)
    .bind(cached)
    .bind(output)
    .bind(now)
    .execute(db)
    .await;

    if let Err(e) = res {
        tracing::debug!("chat usage: failed to record a request for {chat_id}: {e}");
    }
}

/// Everything recorded for one chat. Absent rows read as zero — a chat that has
/// never sent a request has sent nothing, which is not a missing value.
#[derive(Debug, Clone, Default)]
pub struct RecordedUsage {
    pub requests: i64,
    pub reported_requests: i64,
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub last_input_tokens: i64,
}

pub async fn recorded_usage(db: &SqlitePool, chat_id: &str) -> AppResult<RecordedUsage> {
    let row: Option<(i64, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT requests, reported_requests, input_tokens, cached_input_tokens,
                output_tokens, last_input_tokens
           FROM chat_usage WHERE chat_id = ?1",
    )
    .bind(chat_id)
    .fetch_optional(db)
    .await?;

    Ok(row.map_or_else(RecordedUsage::default, |r| RecordedUsage {
        requests: r.0,
        reported_requests: r.1,
        input_tokens: r.2,
        cached_input_tokens: r.3,
        output_tokens: r.4,
        last_input_tokens: r.5,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::{
        FunctionCall, ImageUrl, PromptTokensDetails, Tool, ToolCall, ToolFunction,
    };
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;

    fn msg(role: &str, text: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: Some(MessageContent::Text(text.into())),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }

    fn request(messages: Vec<ChatMessage>, tools: Option<Vec<Tool>>) -> ChatRequest {
        ChatRequest {
            model: "test-model".into(),
            messages,
            temperature: None,
            max_tokens: None,
            top_p: None,
            tools,
            tool_choice: None,
            reasoning_effort: None,
            chat_template_kwargs: None,
            stream_options: None,
            stream: true,
        }
    }

    fn tool(name: &str) -> Tool {
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: name.into(),
                description: "does a thing, at some length, as tool descriptions do".into(),
                parameters: json!({
                    "type": "object",
                    "properties": { "path": { "type": "string", "description": "where" } },
                    "required": ["path"],
                }),
            },
        }
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::MIGRATOR.run(&pool).await.unwrap();
        pool
    }

    /// The whole point of measuring the request rather than the stored messages:
    /// the system prompt and the tool schemas are *in* it, so they are counted
    /// without a second code path being asked to describe them.
    #[test]
    fn counts_the_system_prompt_and_the_schemas_that_are_in_the_request() {
        let req = request(
            vec![
                msg("system", &"You are a careful engineer. ".repeat(40)),
                msg("user", "fix the parser"),
            ],
            Some(vec![tool("read_file"), tool("write_file")]),
        );
        let m = measure_request(&req, DEFAULT_CHARS_PER_TOKEN);

        assert!(m.system_tokens > 200, "{m:?}");
        assert!(m.history_tokens > 0, "{m:?}");
        assert!(m.tools_tokens > 0, "{m:?}");
        assert_eq!(m.tool_count, 2);
        assert_eq!(m.message_count, 2);
        assert_eq!(
            m.input_tokens,
            m.system_tokens + m.history_tokens + m.tools_tokens + 2 * PER_MESSAGE_TOKENS,
            "the parts must add up to the total they break down",
        );
    }

    /// Withholding the tools on a turn's final step really does make that
    /// request smaller — the measure has to follow the request, not the zone.
    #[test]
    fn a_request_without_tools_is_cheaper_than_the_same_one_with_them() {
        let messages = vec![msg("system", "be brief"), msg("user", "hello")];
        let with = measure_request(&request(messages.clone(), Some(vec![tool("a")])), 4.0);
        let without = measure_request(&request(messages, None), 4.0);
        assert!(with.input_tokens > without.input_tokens);
        assert_eq!(without.tools_tokens, 0);
        assert_eq!(without.tool_count, 0);
    }

    /// A tool call replayed in the history is prompt on the way out, and a tool
    /// result is too. Both were being counted, but only the second one as input.
    #[test]
    fn replayed_tool_calls_and_results_are_prompt() {
        let mut assistant = msg("assistant", "");
        assistant.tool_calls = Some(vec![ToolCall {
            id: "call_1".into(),
            call_type: "function".into(),
            function: FunctionCall {
                name: "read_file".into(),
                arguments: json!({ "path": "src/main.rs" }).to_string(),
            },
        }]);
        let mut result = msg("tool", &"fn main() {}\n".repeat(20));
        result.tool_call_id = Some("call_1".into());

        let m = measure_request(&request(vec![assistant, result], None), 4.0);
        assert!(m.history_tokens > 60, "{m:?}");
        assert_eq!(m.system_tokens, 0);
    }

    /// An image's data URL is base64, not text. Counting its characters would
    /// swamp the entire measurement, so it is priced flat and kept out of the
    /// character total that calibration learns from.
    #[test]
    fn images_are_priced_flat_and_excluded_from_calibration_chars() {
        let mut m = msg("user", "what is this?");
        m.content = Some(MessageContent::Parts(vec![
            ContentPart::Text { text: "what is this?".into() },
            ContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: format!("data:image/png;base64,{}", "A".repeat(500_000)),
                    detail: None,
                },
            },
        ]));

        let measure = measure_request(&request(vec![m], None), 4.0);
        assert_eq!(measure.image_tokens, IMAGE_TOKENS);
        assert!(
            measure.payload_chars < 100,
            "base64 must not reach the character total: {measure:?}",
        );
        assert!(measure.input_tokens > IMAGE_TOKENS);
    }

    /// Hidden parts are sent to the model even though the UI never shows them,
    /// so they cost exactly what visible text costs.
    #[test]
    fn hidden_parts_cost_what_visible_text_costs() {
        let mut hidden = msg("user", "");
        hidden.content = Some(MessageContent::Parts(vec![ContentPart::HiddenText {
            text: "x".repeat(400),
        }]));
        let mut visible = msg("user", "");
        visible.content = Some(MessageContent::Parts(vec![ContentPart::Text {
            text: "x".repeat(400),
        }]));

        assert_eq!(
            measure_request(&request(vec![hidden], None), 4.0).input_tokens,
            measure_request(&request(vec![visible], None), 4.0).input_tokens,
        );
    }

    #[tokio::test]
    async fn calibration_learns_a_models_real_ratio_and_stays_in_bounds() {
        let db = pool().await;
        assert_eq!(chars_per_token(&db, "unseen").await, DEFAULT_CHARS_PER_TOKEN);

        // A model that packs 3 chars into a token — denser than the prose rule,
        // which is what JSON schemas and code actually do.
        let measure = RequestMeasure { payload_chars: 3000, ..Default::default() };
        let usage = Usage { prompt_tokens: 1000, ..Default::default() };
        record_calibration(&db, "dense", &measure, &usage).await;
        assert!((chars_per_token(&db, "dense").await - 3.0).abs() < 0.01);

        // Absurd reports are clamped, not believed.
        let wild = Usage { prompt_tokens: 1, ..Default::default() };
        record_calibration(&db, "wild", &RequestMeasure { payload_chars: 100_000, ..Default::default() }, &wild).await;
        assert_eq!(chars_per_token(&db, "wild").await, MAX_CHARS_PER_TOKEN);
    }

    /// The regression this whole change exists for. The meter reported the size
    /// of the context — a snapshot — while the provider billed every request
    /// that carried it. Ten steps over one 50k context is 500k billed, and the
    /// two numbers have to be recorded separately to ever say so.
    #[tokio::test]
    async fn cumulative_totals_grow_per_request_while_the_last_one_does_not() {
        let db = pool().await;
        let measure = RequestMeasure { input_tokens: 50_000, payload_chars: 200_000, ..Default::default() };
        let usage = Usage {
            prompt_tokens: 50_000,
            completion_tokens: 300,
            prompt_cache_hit_tokens: Some(48_000),
            ..Default::default()
        };

        for _ in 0..10 {
            record_request(&db, "c1", "m", &measure, Some(&usage)).await;
        }

        let rec = recorded_usage(&db, "c1").await.unwrap();
        assert_eq!(rec.requests, 10);
        assert_eq!(rec.reported_requests, 10);
        assert_eq!(rec.input_tokens, 500_000, "billed input is cumulative");
        assert_eq!(rec.cached_input_tokens, 480_000);
        assert_eq!(rec.output_tokens, 3_000);
        assert_eq!(rec.last_input_tokens, 50_000, "the context itself did not grow");
    }

    /// A provider that reports nothing still has to produce a total, from the
    /// estimate — and must be distinguishable from one that reported.
    #[tokio::test]
    async fn unreported_requests_fall_back_to_the_estimate() {
        let db = pool().await;
        let measure = RequestMeasure { input_tokens: 1234, payload_chars: 5000, ..Default::default() };

        record_request(&db, "c1", "local", &measure, None).await;
        // A usage block of all zeros says nothing; it must not be preferred.
        record_request(&db, "c1", "local", &measure, Some(&Usage::default())).await;

        let rec = recorded_usage(&db, "c1").await.unwrap();
        assert_eq!(rec.requests, 2);
        assert_eq!(rec.reported_requests, 0, "neither request carried real counts");
        assert_eq!(rec.input_tokens, 2468);
        // Nothing was learned, so the estimate keeps the default ratio.
        assert_eq!(chars_per_token(&db, "local").await, DEFAULT_CHARS_PER_TOKEN);
    }

    #[test]
    fn cache_figures_are_read_in_either_dialect() {
        let deepseek = Usage {
            prompt_tokens: 1000,
            prompt_cache_hit_tokens: Some(900),
            ..Default::default()
        };
        assert_eq!(deepseek.cached_prompt_tokens(), 900);

        let openai = Usage {
            prompt_tokens: 1000,
            prompt_tokens_details: Some(PromptTokensDetails { cached_tokens: Some(768) }),
            ..Default::default()
        };
        assert_eq!(openai.cached_prompt_tokens(), 768);

        // A provider that reports neither reads as a cold prompt, never as free.
        assert_eq!(Usage { prompt_tokens: 1000, ..Default::default() }.cached_prompt_tokens(), 0);
    }
}
