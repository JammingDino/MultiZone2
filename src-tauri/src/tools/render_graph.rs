use crate::error::AppResult;
use crate::llm::types::{Tool, ToolFunction};
use crate::tools::ToolContext;
use serde_json::{json, Value};

pub fn definitions(ctx: &ToolContext) -> Vec<Tool> {
    vec![
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "plot_function".into(),
                description:
                    "Render a mathematical function plot inline in the chat. Use this whenever the user asks you to graph, plot, or visualize an equation or function. Always specify explicit x_range and y_range; use sensible defaults like [-10, 10] when the user does not specify a domain."
                        .into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "title": {
                            "type": "string",
                            "description": "Optional plot title"
                        },
                        "x_range": {
                            "type": "array",
                            "items": { "type": "number" },
                            "minItems": 2,
                            "maxItems": 2,
                            "description": "Visible x-axis domain as [min, max], e.g. [-10, 10]"
                        },
                        "y_range": {
                            "type": "array",
                            "items": { "type": "number" },
                            "minItems": 2,
                            "maxItems": 2,
                            "description": "Visible y-axis domain as [min, max], e.g. [-5, 5]"
                        },
                        "functions": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "fn": {
                                        "type": "string",
                                        "description": "Function expression in x, e.g. 'x^2', 'sin(x)', '2*x + 3'"
                                    },
                                    "color": {
                                        "type": "string",
                                        "description": "Optional hex color like '#4f9cf9'"
                                    }
                                },
                                "required": ["fn"]
                            },
                            "minItems": 1,
                            "description": "One entry per function/curve to plot"
                        },
                        "x_label": { "type": "string" },
                        "y_label": { "type": "string" },
                        "caption": { "type": "string" }
                    },
                    "required": ["x_range", "y_range", "functions"]
                }),
            },
        },
        Tool {
            tool_type: "function".into(),
            function: ToolFunction {
                name: "draw_diagram".into(),
                description: build_draw_diagram_description(ctx),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "source": {
                            "type": "string",
                            "description": "Raw Mermaid source code, e.g. 'graph TD\\n  A --> B'"
                        },
                        "caption": { "type": "string" }
                    },
                    "required": ["source"]
                }),
            },
        },
    ]
}

fn build_draw_diagram_description(ctx: &ToolContext) -> String {
    let t = &ctx.theme;
    format!(
        "Render a Mermaid diagram inline in the chat. Use this for flowcharts, sequence diagrams, ER diagrams, state diagrams, class diagrams, mindmaps, gantt charts, etc. The source must be valid Mermaid syntax.\n\n\
         **Active theme — pick readable colors:** the chat UI is currently in **{mode} mode**. \
         The diagram is rendered on background `{bg}` with foreground text `{text}` (the panel surface is `{panel}`, accent is `{accent}`). \
         If you set any `style` or `classDef` color overrides, choose values that have strong contrast against this background. In particular:\n\
         - In dark mode, do NOT use dark text (`#000`, `#111`, `#222`, near-black) on default node fills — it disappears against the background. Use light text (`#f5f5f5`, `#e4e6eb`) or omit `color:` and let the theme handle it.\n\
         - In light mode, do NOT use very pale text (`#fff`, `#eee`) on default node fills for the same reason. Use dark text or omit `color:`.\n\
         - It is generally safest to omit explicit colors and let Mermaid inherit the theme. Only set colors if the user asked for them or if you genuinely need to distinguish categories of nodes.\n\
         - If you do colorize, pick fills and text together as a contrasting pair, not in isolation.",
        mode = t.mode,
        bg = t.background,
        text = t.text,
        panel = t.panel,
        accent = t.accent,
    )
}

pub async fn plot(args: &Value) -> AppResult<String> {
    if args.get("x_range").is_none()
        || args.get("y_range").is_none()
        || args.get("functions").is_none()
    {
        return Ok(json!({
            "error": "plot_function requires x_range, y_range, and functions"
        })
        .to_string());
    }
    Ok(json!({
        "rendered": "plot_function",
        "title": args.get("title"),
        "x_range": args.get("x_range"),
        "y_range": args.get("y_range"),
        "x_label": args.get("x_label"),
        "y_label": args.get("y_label"),
        "functions": args.get("functions"),
        "caption": args.get("caption"),
    })
    .to_string())
}

pub async fn draw(args: &Value) -> AppResult<String> {
    let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("");
    if source.is_empty() {
        return Ok(json!({ "error": "draw_diagram requires a source string" }).to_string());
    }
    Ok(json!({
        "rendered": "draw_diagram",
        "source": source,
        "caption": args.get("caption"),
    })
    .to_string())
}
