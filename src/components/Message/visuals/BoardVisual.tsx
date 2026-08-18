import { Lock, LockOpen, StickyNote, Users, TriangleAlert } from "lucide-react";
import { Shaped } from "./Shaped";

/**
 * Family 10 — the team board (0.13.2).
 *
 * The teamwork layer is the thing nothing else surveyed has, and until now it
 * was entirely invisible: a claim was a JSON array of paths, and a *refused*
 * write — the moment the whole mechanism exists for — was an error string
 * nobody could act on. Here a conflict names who holds the file, what they said
 * they were doing, and how long they have had it.
 *
 * Agents are tinted by name so the same agent is the same colour across claims
 * and notes, which is what makes a board readable at a glance rather than
 * something to be read line by line.
 */

const KIND_TONE: Record<string, string> = {
  decision: "text-violet-400",
  blocked: "text-[var(--color-danger)]",
  done: "text-emerald-400",
  claim: "text-[var(--color-text-muted)]",
  release: "text-[var(--color-text-muted)]",
  note: "text-[var(--color-text-muted)]",
};

export function BoardVisual({
  name,
  args,
  result,
}: {
  name: string;
  args: any;
  result: Record<string, unknown>;
}) {
  if (name === "post_note") {
    const kind = str(args?.kind) || "note";
    return (
      <Frame icon={StickyNote} title="Posted to the board" count={kind}>
        <div className="px-2 py-1.5">
          <div className={`text-[11px] leading-relaxed ${KIND_TONE[kind] ?? ""}`}>
            {str(args?.text)}
          </div>
          <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
            {str(result.note)}
          </div>
        </div>
      </Frame>
    );
  }

  if (name === "claim_files" || name === "release_files") {
    const claimed = list(result[name === "claim_files" ? "claimed" : "released"]);
    const conflicts = Array.isArray(result.conflicts) ? (result.conflicts as any[]) : [];
    const intent = str(args?.intent) || str(args?.summary);

    return (
      <Frame
        icon={name === "claim_files" ? Lock : LockOpen}
        title={name === "claim_files" ? "Claimed" : "Released"}
        count={`${claimed.length} file${claimed.length === 1 ? "" : "s"}`}
      >
        {intent && (
          <div className="border-b border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
            {intent}
          </div>
        )}
        <div className="flex flex-wrap gap-1 px-2 py-1.5">
          {claimed.map((p) => (
            <Chip key={p} path={p} released={name === "release_files"} />
          ))}
          {claimed.length === 0 && (
            <span className="text-[11px] text-[var(--color-text-muted)]">Nothing.</span>
          )}
        </div>
        {conflicts.length > 0 && (
          <div className="border-t border-[var(--color-border)]">
            {conflicts.map((c, i) => (
              <div key={i} className="flex items-start gap-1.5 px-2 py-1.5 text-[11px]">
                <TriangleAlert size={11} className="mt-0.5 shrink-0 text-amber-400" />
                <div className="min-w-0">
                  <div className="truncate font-mono text-[var(--color-text)]" title={str(c.path)}>
                    {str(c.path)}
                  </div>
                  <div className="text-[10px] text-[var(--color-text-muted)]">
                    held by <Agent name={str(c.held_by)} />
                    {typeof c.held_for_minutes === "number"
                      ? ` for ${c.held_for_minutes} min`
                      : ""}
                    {str(c.their_intent) ? ` — ${str(c.their_intent)}` : ""}
                  </div>
                </div>
              </div>
            ))}
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

  // team_status — the whole board.
  const agents = Array.isArray(result.agents) ? (result.agents as any[]) : [];
  const claims = Array.isArray(result.claims) ? (result.claims as any[]) : [];
  const board = Array.isArray(result.board) ? (result.board as any[]) : [];
  if (!agents.length && !claims.length && !board.length) {
    return <Shaped value={result} />;
  }

  return (
    <Frame
      icon={Users}
      title="Team"
      count={`${agents.length} agent${agents.length === 1 ? "" : "s"} · ${claims.length} claim${
        claims.length === 1 ? "" : "s"
      }`}
    >
      {agents.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-[var(--color-border)] px-2 py-1.5">
          {agents.map((a, i) => (
            <span
              key={i}
              className="rounded px-1.5 py-0.5 text-[10px]"
              style={tint(str(a.agent))}
              title={str(a.role)}
            >
              {str(a.agent)}
              {str(a.role) === "lead" ? " · lead" : ""}
            </span>
          ))}
        </div>
      )}

      {claims.length > 0 && (
        <div className="border-b border-[var(--color-border)] px-2 py-1.5">
          <Label>Claims</Label>
          {claims.map((c, i) => (
            <div key={i} className="flex items-baseline gap-2 py-0.5 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-mono text-[var(--color-text)]" title={str(c.path)}>
                {str(c.path)}
              </span>
              <Agent name={str(c.held_by)} />
              <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                {typeof c.held_for_minutes === "number" ? `${c.held_for_minutes}m` : ""}
                {c.taken === "implicitly, by writing it" ? " · implicit" : ""}
              </span>
            </div>
          ))}
        </div>
      )}

      {board.length > 0 && (
        <div className="max-h-[220px] overflow-auto px-2 py-1.5">
          <Label>Board</Label>
          {board.map((n, i) => (
            <div key={i} className="py-0.5 text-[11px]">
              <span className="mr-1.5 text-[10px] text-[var(--color-text-muted)]">
                {typeof n.minutes_ago === "number" ? `${n.minutes_ago}m` : ""}
              </span>
              <Agent name={str(n.from)} />{" "}
              <span className={KIND_TONE[str(n.kind)] ?? "text-[var(--color-text)]"}>
                {str(n.text)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

/**
 * A write refused because another agent holds the file (0.13.2).
 *
 * This is the moment the whole teamwork layer exists for, and it was reaching
 * the reader as a red string. The backend marks it `error_kind: "claimed"` and
 * states the holder, their intent and how long they have had it inside the
 * message — so it is rendered in the board's own language rather than as a
 * generic failure.
 */
export function ClaimRefusal({ message, next }: { message: string; next?: string }) {
  return (
    <Frame icon={Lock} title="Write refused — file is claimed" count="teamwork">
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        <TriangleAlert size={11} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 text-[11px] leading-relaxed text-[var(--color-text)]">{message}</div>
      </div>
      {next && (
        <div className="border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
          {next}
        </div>
      )}
    </Frame>
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
        <span className="text-[var(--color-text)]">{title}</span>
        <span className="ml-auto text-[10px] text-[var(--color-text-muted)]">{count}</span>
      </div>
      <div className="max-h-[320px] overflow-auto">{children}</div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function Chip({ path, released }: { path: string; released?: boolean }) {
  return (
    <span
      className={`max-w-full truncate rounded px-1.5 py-0.5 font-mono text-[10px] ${
        released
          ? "bg-[var(--color-panel)] text-[var(--color-text-muted)] line-through"
          : "bg-[var(--color-accent)]/10 text-[var(--color-text)]"
      }`}
      title={path}
    >
      {path}
    </span>
  );
}

/** The same agent is the same colour everywhere on the board. */
function Agent({ name }: { name: string }) {
  if (!name) return null;
  return (
    <span className="rounded px-1 py-0.5 text-[10px]" style={tint(name)}>
      {name}
    </span>
  );
}

function tint(name: string): React.CSSProperties {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return {
    background: `hsl(${hue} 70% 50% / 0.15)`,
    color: `hsl(${hue} 70% 65%)`,
  };
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
