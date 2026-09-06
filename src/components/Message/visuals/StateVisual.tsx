import { Brain, BookOpen, Settings2, ArrowRight, Clock, Layers, Check, AlertCircle } from "lucide-react";
import { Shaped } from "./Shaped";

/**
 * Families 11, 12 and 13 — memory, skills, and things that changed (0.13.3).
 *
 * These share a shape: a small fact, or a before and an after. They are grouped
 * in one file for that reason rather than for convenience — a card per tool
 * would have been thirteen near-identical components.
 *
 * `get_current_datetime` deliberately renders as a line with no card at all.
 * Not everything deserves a box, and a bordered panel around "it is Tuesday"
 * makes the transcript worse.
 */

export function MemoryVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  if (name === "read_memory") {
    const memories = arr(result.memories);
    if (memories.length === 0) {
      return <Line icon={Brain}>Nothing remembered for this scope yet.</Line>;
    }
    return (
      <Frame icon={Brain} title="Recalled" count={`${memories.length}`}>
        {memories.map((m: any, i) => (
          <div key={i} className="border-b border-[var(--color-border)]/40 px-2 py-1.5 last:border-0">
            <Scope scope={str(m.scope)} />
            <div className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text)]">
              {str(m.content)}
            </div>
          </div>
        ))}
      </Frame>
    );
  }

  if (name === "delete_memory") {
    const deleted = result.deleted;
    return (
      <Frame icon={Brain} title="Forgotten" count={typeof deleted === "number" ? String(deleted) : ""}>
        <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)] line-through">
          {str(args?.content) || str(args?.id) || "entry removed"}
        </div>
      </Frame>
    );
  }

  // save_memory
  const content = str(args?.content) || str(result.content);
  if (!content) return <Shaped value={result} />;
  return (
    <Frame icon={Brain} title="Remembered" count={str(args?.scope) || str(result.scope)}>
      <div className="px-2 py-1.5">
        <div className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text)]">
          {content}
        </div>
        {result.trimmed_oldest === true && (
          <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            The oldest entry in this scope was dropped to make room.
          </div>
        )}
      </div>
    </Frame>
  );
}

export function SkillVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  const title = str(result.name) || str(args?.name) || str(result.id) || str(args?.id);
  const files = arr(result.files).length ? arr(result.files) : arr(result.available_files);
  const content = str(result.content) || str(result.instructions);

  // `load_skill` with no arguments is a catalogue rather than one skill.
  const available = arr(result.available_skills);
  if (available.length > 0) {
    return (
      <Frame icon={BookOpen} title="Skills available" count={String(available.length)}>
        {available.map((s: any, i) => (
          <div key={i} className="border-b border-[var(--color-border)]/40 px-2 py-1.5 last:border-0">
            <div className="text-[11px] text-[var(--color-text)]">{str(s.name) || str(s.id)}</div>
            {str(s.description) && (
              <div className="text-[10px] text-[var(--color-text-muted)]">{str(s.description)}</div>
            )}
          </div>
        ))}
      </Frame>
    );
  }

  if (!title && !content) return <Shaped value={result} />;

  return (
    <Frame
      icon={BookOpen}
      title={title || "skill"}
      count={name === "create_skill" ? "new" : name === "update_skill" ? "updated" : "loaded"}
    >
      {str(result.description) && (
        <div className="border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          {str(result.description)}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
          {files.map((f: any, i) => (
            <span
              key={i}
              className="rounded bg-[var(--color-panel)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]"
            >
              {typeof f === "string" ? f : str(f.file) || str(f.name)}
            </span>
          ))}
        </div>
      )}
      {content && (
        <div className="max-h-[220px] overflow-auto px-2 py-1.5">
          <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {content}
          </pre>
        </div>
      )}
    </Frame>
  );
}

export function ChangeVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  if (name === "get_current_datetime") {
    return <Line icon={Clock}>{str(result.datetime) || str(result.iso) || summarise(result)}</Line>;
  }

  if (name === "compact_context") {
    const compacted = result.messages_compacted;
    return (
      <Frame
        icon={Layers}
        title="Context compacted"
        count={typeof compacted === "number" ? `${compacted} messages` : ""}
      >
        {str(result.summary) && (
          <div className="max-h-[220px] overflow-auto px-2 py-1.5 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
            {str(result.summary)}
          </div>
        )}
        {str(result.note) && (
          <div className="border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
            {str(result.note)}
          </div>
        )}
      </Frame>
    );
  }

  if (name === "change_zone") {
    const to = str(result.switched_to) || str(result.zone) || str(args?.zone_id);
    return (
      <Line icon={Settings2}>
        Zone <Chip>{to}</Chip>
        {str(result.model) && (
          <span className="text-[10px] text-[var(--color-text-muted)]"> · {str(result.model)}</span>
        )}
      </Line>
    );
  }

  if (name === "list_zones") {
    const zones = arr(result.zones);
    if (zones.length === 0) return <Shaped value={result} />;
    return (
      <div className="flex flex-wrap gap-1">
        {zones.map((z: any, i) => (
          <Chip key={i}>{str(z.name) || str(z)}</Chip>
        ))}
      </div>
    );
  }

  if (name === "tag_chat") {
    const tag = result.tag && typeof result.tag === "object" ? (result.tag as any) : null;
    const label = str(tag?.name) || str(args?.name);
    const verb = result.newly_assigned === true ? "Tagged" : "Already tagged";
    return (
      <Line icon={Settings2}>
        {verb} <Chip color={str(tag?.color)}>{label}</Chip>
        {result.created_new_tag === true && (
          <span className="text-[10px] text-[var(--color-text-muted)]"> · new tag</span>
        )}
      </Line>
    );
  }

  // app_read / app_control — what the app said back.
  //
  // This used to render as "path → 200", which answers "did it work" only for
  // people who know their status codes, and shows nothing of what was actually
  // read. So: a plain worked / didn't-work flag, and the response itself.
  if (name === "app_read" || name === "app_control") {
    return <AppResultCard name={name} args={args} result={result} />;
  }

  // enter_plan_mode and anything else in this family — a setting and where it landed.
  const path = str(args?.path);
  const value = result.body ?? result.status ?? null;
  if (!path && value === null) return <Shaped value={result} />;
  return (
    <Line icon={Settings2}>
      <span className="font-mono">{path || name}</span>
      {value !== null && (
        <>
          <ArrowRight size={10} className="opacity-60" />
          <span className="min-w-0 truncate">
            {typeof value === "object" ? summarise(value) : String(value)}
          </span>
        </>
      )}
    </Line>
  );
}

/**
 * The app's own API, answered in words (0.17.8).
 *
 * `app_read` returns `{ status, ok, result }`; the card leads with whether it
 * worked, names the route it asked, and previews the body — the three things
 * you would otherwise have had to decode from a number and a JSON blob. An
 * `error` field (a refusal, or a route that never ran) is a failure too, even
 * though it carries no status at all.
 */
function AppResultCard({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  const error = str(result.error);
  const status = typeof result.status === "number" ? result.status : null;
  const ok = error ? false : result.ok === true || (status !== null && status >= 200 && status < 300);
  const path = str(args?.path) || name;
  const method = name === "app_read" ? "GET" : (str(args?.method) || "POST").toUpperCase();
  const body = result.result ?? null;
  const note = str(result.note);

  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
        <span
          className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
            ok
              ? "bg-emerald-500/10 text-emerald-400"
              : "bg-[var(--color-danger)]/10 text-[var(--color-danger)]"
          }`}
        >
          {ok ? <Check size={10} /> : <AlertCircle size={10} />}
          {ok ? "Success" : "Error"}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-[var(--color-text-muted)]">{method}</span>
        <span className="min-w-0 truncate font-mono text-[var(--color-text)]" title={path}>
          {path}
        </span>
        {status !== null && (
          <span
            className="ml-auto shrink-0 text-[10px] tabular-nums text-[var(--color-text-muted)]"
            title="HTTP status code"
          >
            {status}
          </span>
        )}
      </div>

      {error ? (
        <div className="px-2 py-1.5 text-[11px] text-[var(--color-danger)]">{error}</div>
      ) : body != null ? (
        <div className="max-h-[280px] overflow-auto px-2 py-1.5">
          <Shaped value={body} />
        </div>
      ) : (
        <div className="px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
          {ok ? "Done — the app returned nothing to show." : "No response body."}
        </div>
      )}

      {note && (
        <div className="border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          {note}
        </div>
      )}
    </div>
  );
}

function Frame({
  icon: Icon,
  title,
  count,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-2 py-1.5 text-[11px]">
        <Icon size={12} className="shrink-0 text-[var(--color-text-muted)]" />
        <span className="min-w-0 truncate text-[var(--color-text)]">{title}</span>
        {count && (
          <span className="ml-auto shrink-0 text-[10px] text-[var(--color-text-muted)]">{count}</span>
        )}
      </div>
      <div className="max-h-[320px] overflow-auto">{children}</div>
    </div>
  );
}

/** No border, no panel — some results are one sentence and should look it. */
function Line({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-text)]">
      <Icon size={11} className="shrink-0 text-[var(--color-text-muted)]" />
      {children}
    </div>
  );
}

function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px]"
      style={
        color
          ? { background: `${color}22`, color }
          : { background: "var(--color-panel)", color: "var(--color-text)" }
      }
    >
      {children}
    </span>
  );
}

function Scope({ scope }: { scope: string }) {
  if (!scope) return null;
  return (
    <span className="rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-accent)]">
      {scope}
    </span>
  );
}

function summarise(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    return keys.length ? keys.slice(0, 4).join(", ") : "(empty)";
  }
  return String(v);
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
