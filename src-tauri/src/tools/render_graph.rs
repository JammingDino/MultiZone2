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
                description: PLOT_DESCRIPTION.into(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "functions": {
                            "type": "array",
                            "minItems": 1,
                            "description": "One entry per curve",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "type": {
                                        "type": "string",
                                        "enum": ["linear", "parametric", "polar", "implicit"],
                                        "description": "linear (default): y = fn(x). parametric: x(t), y(t). polar: r(theta). implicit: fn(x, y) = 0"
                                    },
                                    "fn": { "type": "string", "description": "linear: in x, e.g. 'x^2 - 3*x'. implicit: in x and y, e.g. 'x^2 + y^2 - 4'" },
                                    "x": { "type": "string", "description": "parametric: x in terms of t" },
                                    "y": { "type": "string", "description": "parametric: y in terms of t" },
                                    "r": { "type": "string", "description": "polar: r in terms of theta" },
                                    "range": {
                                        "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2,
                                        "description": "parametric/polar: the t or theta interval. Default [0, 2*pi]"
                                    },
                                    "label": { "type": "string", "description": "Legend text. Defaults to the expression" }
                                }
                            }
                        },
                        "x_range": {
                            "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2,
                            "description": "Visible x domain [min, max]. Default [-10, 10] for y = f(x); omit to fit other curves"
                        },
                        "y_range": {
                            "type": "array", "items": { "type": "number" }, "minItems": 2, "maxItems": 2,
                            "description": "Visible y domain [min, max]. Omit to fit the curves"
                        },
                        "x_label": { "type": "string" },
                        "y_label": { "type": "string" },
                        "caption": { "type": "string" }
                    },
                    "required": ["functions"]
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

const PLOT_DESCRIPTION: &str = concat!(
    "Plot mathematical functions inline in the chat: y = f(x), parametric, polar or implicit curves. ",
    "Use it whenever the user asks to graph, plot or visualise an equation; `render_chart` is for data.\n",
    "Write expressions in plain math: `x^2`, `2*x + 1`, `sin(x)`, `exp(-x^2)`, `log(x)` (natural), `sqrt`, `abs`, `pi`, `e`. ",
    "`**`, `Math.sin`, `np.exp`, `ln` and `2x` are accepted and normalised; anything else is refused with the reason. ",
    "Leave colour to the app. Omit y_range to fit the curves. Say in words what the plot shows as well.",
);

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

/// Validates, normalises and echoes (0.18.1). The drawing happens in the
/// frontend, but an expression it cannot parse used to reach it anyway and draw
/// an error box — while the model, holding a successful tool result, carried on
/// describing a plot nobody could see. Every expression is checked here, so a
/// mistake comes back as an error the model can fix, and the frontend is handed
/// the normalised form.
pub async fn plot(args: &Value) -> AppResult<String> {
    match plot_spec(args) {
        Ok(spec) => Ok(spec.to_string()),
        Err(e) => Ok(json!({ "error": format!("plot_function: {e}") }).to_string()),
    }
}

fn plot_spec(args: &Value) -> Result<Value, String> {
    let fns = args
        .get("functions")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .ok_or("`functions` must be a non-empty array")?;
    let mut out = Vec::new();
    for (i, f) in fns.iter().enumerate() {
        // A bare string is a linear function — the shape models reach for first.
        let f = match f {
            Value::String(s) => json!({ "fn": s }),
            other => other.clone(),
        };
        let kind = f.get("type").and_then(|v| v.as_str()).unwrap_or("linear");
        let field = |name: &str| -> Result<String, String> {
            let raw = f
                .get(name)
                .and_then(|v| v.as_str())
                .ok_or(format!("functions[{i}] ({kind}) needs `{name}`"))?;
            let vars: &[&str] = match kind {
                "parametric" => &["t"],
                "polar" => &["theta"],
                "implicit" => &["x", "y"],
                _ => &["x"],
            };
            normalize_expr(raw, vars).map_err(|e| format!("functions[{i}] `{raw}`: {e}"))
        };
        let mut entry = json!({ "type": kind });
        match kind {
            "linear" | "implicit" => entry["fn"] = json!(field("fn")?),
            "parametric" => {
                entry["x"] = json!(field("x")?);
                entry["y"] = json!(field("y")?);
            }
            "polar" => entry["r"] = json!(field("r")?),
            other => return Err(format!("functions[{i}]: unknown type `{other}`")),
        }
        for key in ["range", "label", "color"] {
            if let Some(v) = f.get(key) {
                entry[key] = v.clone();
            }
        }
        out.push(entry);
    }
    let range = |key: &str| -> Result<Option<Value>, String> {
        match args.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(v) => {
                let pair = v.as_array().filter(|a| a.len() == 2).and_then(|a| Some((a[0].as_f64()?, a[1].as_f64()?)));
                match pair {
                    Some((lo, hi)) if lo < hi => Ok(Some(json!([lo, hi]))),
                    _ => Err(format!("`{key}` must be [min, max] with min < max")),
                }
            }
        }
    };
    Ok(json!({
        "rendered": "plot_function",
        "title": args.get("title"),
        "x_range": range("x_range")?,
        "y_range": range("y_range")?,
        "x_label": args.get("x_label"),
        "y_label": args.get("y_label"),
        "functions": out,
        "caption": args.get("caption"),
    }))
}

/// Names function-plot's evaluators understand — `Math` plus a few helpers.
const PLOT_FUNCS: &[&str] = &[
    "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
    "exp", "log", "log10", "log2", "sqrt", "cbrt", "abs", "sign", "floor", "ceil", "round",
    "min", "max", "pow", "nthRoot",
];

/// Rewrite the forms models write into the plotter's grammar, and refuse
/// anything it would choke on. Tokenises rather than pattern-replaces, so `e`
/// in `exp` or `1e-3` is never mistaken for Euler's number.
pub(crate) fn normalize_expr(raw: &str, vars: &[&str]) -> Result<String, String> {
    let mut src = raw.trim().replace("**", "^").replace('\u{03c0}', "pi").replace('\u{2212}', "-");
    // `y = x^2`, `f(x) = …`, `r = …`: keep the right-hand side. Implicit
    // equations keep both sides as `lhs - (rhs)`.
    if let Some(eq) = src.find('=') {
        let (lhs, rhs) = (src[..eq].trim().to_string(), src[eq + 1..].trim().to_string());
        src = if vars.contains(&"y") { format!("({lhs}) - ({rhs})") } else { rhs };
    }
    for prefix in ["Math.", "math.", "np.", "numpy."] {
        src = src.replace(prefix, "");
    }
    if src.is_empty() {
        return Err("empty expression".into());
    }

    #[derive(PartialEq, Clone, Copy)]
    enum K { Num, Name, Open, Close, Op, Comma }
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut prev: Option<K> = None;
    let mut depth = 0i32;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let (kind, text) = if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                i += 1;
            }
            // Scientific notation belongs to the number.
            if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                let j = if chars.get(i + 1).is_some_and(|c| *c == '-' || *c == '+') { i + 2 } else { i + 1 };
                if chars.get(j).is_some_and(|d| d.is_ascii_digit()) {
                    i = j;
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                }
            }
            (K::Num, chars[start..i].iter().collect::<String>())
        } else if c.is_ascii_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            let name: String = chars[start..i].iter().collect();
            let mapped = match name.as_str() {
                "pi" | "PI" | "Pi" => "PI".to_string(),
                "e" | "E" => "E".to_string(),
                "ln" => "log".to_string(),
                "arcsin" => "asin".to_string(),
                "arccos" => "acos".to_string(),
                "arctan" => "atan".to_string(),
                "sqr" => "sqrt".to_string(),
                n if vars.contains(&n) || PLOT_FUNCS.contains(&n) => n.to_string(),
                n => {
                    return Err(format!(
                        "unknown name `{n}` — use {} and functions like sin, exp, log, sqrt, abs",
                        vars.iter().map(|v| format!("`{v}`")).collect::<Vec<_>>().join(" and ")
                    ))
                }
            };
            (K::Name, mapped)
        } else {
            i += 1;
            match c {
                '(' | '[' => { depth += 1; (K::Open, "(".to_string()) }
                ')' | ']' => {
                    depth -= 1;
                    if depth < 0 { return Err("unbalanced parentheses".into()); }
                    (K::Close, ")".to_string())
                }
                '+' | '-' | '*' | '/' | '^' | '%' | '!' => (K::Op, c.to_string()),
                ',' => (K::Comma, ",".to_string()),
                other => return Err(format!("unexpected `{other}`")),
            }
        };
        // Implicit multiplication: `2x`, `2(x+1)`, `(x)(x)`, `x sin(x)`. A name
        // directly before `(` is a call, so that case is left alone.
        let implicit = match (prev, kind) {
            (Some(K::Num), K::Name | K::Open) => true,
            (Some(K::Close), K::Num | K::Name | K::Open) => true,
            (Some(K::Name), K::Num | K::Name) => true,
            _ => false,
        };
        if implicit {
            out.push('*');
        }
        out.push_str(&text);
        prev = Some(kind);
    }
    if depth != 0 {
        return Err("unbalanced parentheses".into());
    }
    if matches!(prev, Some(K::Op | K::Open | K::Comma)) && !out.ends_with('!') {
        return Err("expression ends early".into());
    }
    Ok(out)
}

#[cfg(test)]
mod plot_tests {
    use super::*;

    #[test]
    fn model_forms_are_normalised() {
        let x = &["x"];
        assert_eq!(normalize_expr("x**2", x).unwrap(), "x^2");
        assert_eq!(normalize_expr("Math.sin(x) + np.exp(x)", x).unwrap(), "sin(x)+exp(x)");
        assert_eq!(normalize_expr("2x + 3", x).unwrap(), "2*x+3");
        assert_eq!(normalize_expr("ln(x)", x).unwrap(), "log(x)");
        assert_eq!(normalize_expr("e^(-x^2)", x).unwrap(), "E^(-x^2)");
        assert_eq!(normalize_expr("y = 2*pi*x", x).unwrap(), "2*PI*x");
        assert_eq!(normalize_expr("1e-3*x", x).unwrap(), "1e-3*x");
        assert_eq!(normalize_expr("exp(x)", x).unwrap(), "exp(x)");
        assert_eq!(normalize_expr("(x+1)(x-1)", x).unwrap(), "(x+1)*(x-1)");
    }

    #[test]
    fn implicit_equations_keep_both_sides() {
        assert_eq!(normalize_expr("x^2 + y^2 = 4", &["x", "y"]).unwrap(), "(x^2+y^2)-(4)");
        assert_eq!(normalize_expr("y = x^2", &["x", "y"]).unwrap(), "(y)-(x^2)");
    }

    #[test]
    fn mistakes_are_refused_with_a_reason() {
        assert!(normalize_expr("sin(z)", &["x"]).unwrap_err().contains("`z`"));
        assert!(normalize_expr("sin(x", &["x"]).unwrap_err().contains("parentheses"));
        assert!(normalize_expr("x +", &["x"]).is_err());
        assert!(normalize_expr("x; alert(1)", &["x"]).is_err());
    }

    #[test]
    fn a_spec_without_y_range_is_accepted_and_fitted_later() {
        let v = plot_spec(&json!({ "functions": ["x**3"] })).unwrap();
        assert_eq!(v["functions"][0]["fn"], "x^3");
        assert!(v["x_range"].is_null());
        assert!(v["y_range"].is_null());
    }

    #[test]
    fn a_bad_range_is_named() {
        assert!(plot_spec(&json!({ "functions": ["x"], "x_range": [5, 1] })).unwrap_err().contains("x_range"));
    }
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
