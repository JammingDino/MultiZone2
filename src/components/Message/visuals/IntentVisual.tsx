import { Terminal, FileText, FolderTree, Search, Globe, Send, Users, Plug, Wrench } from "lucide-react";
import { familyOf } from "./families";
import { Shaped } from "./Shaped";

/**
 * What a tool call is *about to do*, drawn from its arguments alone (0.14.3).
 *
 * Every other visual in this folder is driven by a tool's **result**, which is
 * exactly what an approval prompt does not have yet. So the prompt said "the
 * model wants to run run command" and hid the one fact the decision turns on —
 * *which command* — behind a "Show arguments" link that unfolded raw JSON.
 * Approving a shell call without reading the command is not approval, it is
 * assent, and the UI was asking for assent.
 *
 * Same families as the step card, so the thing you approve looks like the thing
 * you will later inspect. Anything with no shaped intent falls back to the same
 * key/value rendering the step card's Input tab uses — never raw JSON, and never
 * nothing.
 */
export function IntentVisual({ name, args }: { name: string; args: any }): React.ReactElement {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");

  switch (familyOf(name)) {
    case "terminal": {
      // The command, as a command. This is the case the whole component exists
      // for: it is the difference between "run a tool" and "run `rm -rf /`".
      const cmd = str("command") || str("code") || str("input");
      if (!cmd) break;
      const cwd = str("cwd") || str("working_dir");
      return (
        <Frame icon={Terminal} title={label(name)} subtitle={cwd || undefined}>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[12px] leading-relaxed text-[var(--color-text)]">
            {cmd}
          </pre>
        </Frame>
      );
    }

    case "diff": {
      // A diff is rendered by the caller when the backend produced a preview;
      // this is the fallback for a create with no previous version to diff.
      const path = str("path");
      const content = str("content") || str("new_text");
      if (!path) break;
      return (
        <Frame icon={FileText} title={label(name)} subtitle={path}>
          {content && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {content.slice(0, 2000)}
              {content.length > 2000 && "\n…"}
            </pre>
          )}
        </Frame>
      );
    }

    case "file": {
      const path = str("path") || str("from");
      if (!path) break;
      const to = str("to");
      return (
        <Frame icon={FileText} title={label(name)} subtitle={to ? `${path} → ${to}` : path} />
      );
    }

    case "tree": {
      const path = str("path") || str("dir") || ".";
      return <Frame icon={FolderTree} title={label(name)} subtitle={`${path}${str("pattern") ? `  ${str("pattern")}` : ""}`} />;
    }

    case "match": {
      const q = str("query") || str("pattern") || str("text");
      return <Frame icon={Search} title={label(name)} subtitle={q || undefined} />;
    }

    case "web":
    case "page": {
      const q = str("query") || str("url");
      return <Frame icon={Globe} title={label(name)} subtitle={q || undefined} />;
    }

    case "http": {
      const method = (str("method") || "GET").toUpperCase();
      const url = str("url");
      if (!url) break;
      return (
        <Frame icon={Send} title={label(name)} subtitle={`${method} ${url}`}>
          {str("body") && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] px-2 py-1.5 font-mono text-[11px] text-[var(--color-text-muted)]">
              {str("body").slice(0, 1000)}
            </pre>
          )}
        </Frame>
      );
    }

    case "agent": {
      const zone = str("zone") || str("subchat_id");
      const task = str("task") || str("message");
      return (
        <Frame icon={Users} title={label(name)} subtitle={zone || undefined}>
          {task && <p className="text-xs leading-relaxed text-[var(--color-text)]">{task}</p>}
        </Frame>
      );
    }

    default:
      break;
  }

  // MCP tools carry a server-defined schema we know nothing about, so the
  // arguments themselves are the intent — shaped, not stringified.
  const isMcp = name.startsWith("mcp__");
  return (
    <Frame icon={isMcp ? Plug : Wrench} title={label(name)}>
      {Object.keys(a).length > 0 ? (
        <Shaped value={a} />
      ) : (
        <p className="text-xs text-[var(--color-text-muted)]">No arguments.</p>
      )}
    </Frame>
  );
}

/** A tool name as a person reads it. MCP names carry their own prefix. */
function label(name: string): string {
  if (name.startsWith("mcp__")) {
    const tool = name.split("__").slice(2).join("__");
    return `${tool || name} (MCP)`;
  }
  return name.replace(/_/g, " ");
}

function Frame({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5">
        <Icon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="text-xs font-medium">{title}</span>
        {subtitle && (
          <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-[var(--color-text-muted)]">
            {subtitle}
          </span>
        )}
      </div>
      {children && <div className="p-2">{children}</div>}
    </div>
  );
}

/**
 * The command a shell-ish call will run, or null for anything else — the hook
 * the approval prompt uses to offer "always allow this".
 */
export function shellCommandOf(name: string, args: any): string | null {
  if (familyOf(name) !== "terminal") return null;
  const a = (args ?? {}) as Record<string, unknown>;
  for (const key of ["command", "code", "input"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Prefixes worth offering as a rule, longest first: `npm run build` suggests
 * "npm run build", "npm run" and "npm".
 *
 * Three at most. A rule is a standing decision about every future command that
 * starts this way, and a list of eight candidates invites picking one without
 * reading it — which is the failure this whole prompt is trying to avoid.
 */
export function rulePrefixes(command: string): string[] {
  const words = command.split(/\s+/).filter(Boolean);
  // Flags are not a category of command: "git --version" as a rule would allow
  // exactly one invocation and read as though it allowed a family.
  const meaningful = words.filter((w) => !w.startsWith("-"));
  const out: string[] = [];
  for (let n = Math.min(3, meaningful.length); n >= 1; n--) {
    out.push(meaningful.slice(0, n).join(" "));
  }
  return [...new Set(out)];
}
