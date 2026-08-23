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
                name: "render_chart".into(),
                description: CHART_DESCRIPTION.into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["bar", "line", "area", "scatter", "pie"],
                            "description": "bar compares categories; line and area show a trend; scatter relates two numbers; pie shows parts of one whole"
                        },
                        "title": { "type": "string" },
                        "labels": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "The categories, in order — x-axis ticks, or pie slice names"
                        },
                        "series": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": { "type": "string", "description": "The quantity, for the legend" },
                                    "values": {
                                        "type": "array",
                                        "items": { "type": ["number", "null"] },
                                        "description": "One per label, same order. null is drawn as a gap, not a zero"
                                    },
                                    "points": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": { "x": { "type": "number" }, "y": { "type": "number" } },
                                            "required": ["x", "y"]
                                        },
                                        "description": "Scatter only, instead of values"
                                    },
                                    "color": { "type": "string", "description": "Hex. Omit unless asked" }
                                },
                                "required": ["name"]
                            },
                            "minItems": 1,
                            "description": "One per quantity; several share one set of labels"
                        },
                        "stacked": { "type": "boolean", "description": "Bar/area: stack into a total" },
                        "horizontal": { "type": "boolean", "description": "Bar: categories down the side" },
                        "x_label": { "type": "string" },
                        "y_label": { "type": "string" },
                        "unit": { "type": "string", "description": "Suffix on printed values, e.g. \"%\", \" ms\"" },
                        "caption": { "type": "string" }
                    },
                    "required": ["type", "series"]
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

/// Nothing here varies with the theme, deliberately: the chart's palette is
/// resolved by the renderer from the colours actually on screen, so the model
/// is told to leave colour alone rather than being handed a palette to reason
/// about. That is also what keeps a chart correct after the user switches mode
/// with the answer still on screen.
const CHART_DESCRIPTION: &str = concat!(
    "Draw a chart of data inline in the chat — bar, line, area, scatter or pie. ",
    "Use it whenever you have numbers worth showing: a query result, a table you just read, figures from a document. ",
    "Prefer it over writing SVG and over approximating a chart in a Mermaid diagram; ",
    "`plot_function` plots equations, this plots data.\n",
    "Give the numbers, not a drawing. The renderer takes its palette from the user's active theme, ",
    "and separates series by dash pattern, marker shape and fill texture as well as by colour, so leave `color` alone.\n",
    "Use `horizontal` when bar labels are long or numerous, `stacked` for parts of a total, ",
    "and a horizontal bar chart rather than a pie past about six slices. ",
    "Say in words what the chart shows as well as drawing it.",
);

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

/// Like `plot` and `draw`, this validates and echoes: the drawing happens in the
/// frontend, which is the only place that knows the theme and the width. What it
/// does do is refuse the two shapes that render as an empty frame, because a
/// model reads a blank chart as the tool being broken rather than as its own
/// arguments being wrong.
pub async fn chart(args: &Value) -> AppResult<String> {
    let series = args.get("series").and_then(|v| v.as_array());
    let Some(series) = series else {
        return Ok(json!({
            "error": "render_chart requires a `series` array, each entry with a `name` and either `values` or `points`"
        })
        .to_string());
    };
    if series.is_empty() {
        return Ok(json!({ "error": "render_chart requires at least one series" }).to_string());
    }

    let has_numbers = series.iter().any(|s| {
        let values = s.get("values").and_then(|v| v.as_array());
        let points = s.get("points").and_then(|v| v.as_array());
        values.is_some_and(|v| v.iter().any(|n| n.is_number()))
            || points.is_some_and(|p| !p.is_empty())
    });
    if !has_numbers {
        return Ok(json!({
            "error": "render_chart found no numbers: every series needs `values` (one number per label) or, for a scatter, `points`"
        })
        .to_string());
    }

    // A model that gives fewer labels than values gets numbered categories from
    // the renderer rather than a truncated chart, so the mismatch is worth
    // naming without being worth refusing.
    let label_count = args
        .get("labels")
        .and_then(|v| v.as_array())
        .map(|l| l.len())
        .unwrap_or(0);
    let longest = series
        .iter()
        .filter_map(|s| s.get("values").and_then(|v| v.as_array()).map(|v| v.len()))
        .max()
        .unwrap_or(0);
    let note = (label_count > 0 && label_count < longest).then(|| {
        format!(
            "{label_count} labels for {longest} values — the extra points were numbered"
        )
    });

    Ok(json!({
        "rendered": "render_chart",
        "type": args.get("type").and_then(|v| v.as_str()).unwrap_or("bar"),
        "title": args.get("title"),
        "labels": args.get("labels"),
        "series": args.get("series"),
        "stacked": args.get("stacked"),
        "horizontal": args.get("horizontal"),
        "x_label": args.get("x_label"),
        "y_label": args.get("y_label"),
        "unit": args.get("unit"),
        "caption": args.get("caption"),
        "note": note,
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
