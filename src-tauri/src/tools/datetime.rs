use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use serde_json::{json, Value};

pub fn definition() -> Tool {
    Tool {
        tool_type: "function".into(),
        function: ToolFunction {
            name: "get_current_datetime".into(),
            description: "Returns the current local date, time, and timezone offset.".into(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
    }
}

pub async fn run(_args: &Value) -> AppResult<String> {
    let now = chrono::Local::now();
    Ok(json!({
        "iso": now.to_rfc3339(),
        "date": now.format("%Y-%m-%d").to_string(),
        "time": now.format("%H:%M:%S").to_string(),
        "timezone": now.format("%:z").to_string(),
    })
    .to_string())
}
