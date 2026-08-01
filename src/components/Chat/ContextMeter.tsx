import { useEffect, useMemo, useState } from "react";
import { Gauge, Users } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { formatTokens } from "@/lib/format";
import { chatContextEstimate } from "@/lib/tokens";
import type { Chat, SessionUsage } from "@/lib/types";

const EMPTY: never[] = [];

/** How often the team total is re-read while the session is generating. The
 *  numbers only move when an agent writes, so this is about keeping a running
 *  fan-out honest, not about smoothness. */
const TEAM_REFRESH_MS = 5000;

/**
 * The session a chat belongs to: the root of its sub-agent family plus every
 * descendant subchat. Walks *up* first so the answer is the same whether you're
 * looking at the leader or at one of its sub-agents.
 *
 * Only real subchats (`initiatedByZoneId` set) are followed — a branch shares
 * the `parentChatId` link but is its own conversation, not a team member.
 */
function sessionMemberIds(chats: Chat[], chatId: string): Set<string> {
  const byId = new Map(chats.map((c) => [c.id, c]));
  let root = chatId;
  for (let i = 0; i < 64; i++) {
    const c = byId.get(root);
    if (c?.parentChatId && c.initiatedByZoneId) root = c.parentChatId;
    else break;
  }
  const members = new Set([root]);
  // Each pass adds one more generation; a tree deeper than the depth limit
  // still terminates because a pass that adds nothing ends the loop.
  for (let pass = 0; pass < 64; pass++) {
    let grew = false;
    for (const c of chats) {
      if (!c.initiatedByZoneId || !c.parentChatId) continue;
      if (members.has(c.parentChatId) && !members.has(c.id)) {
        members.add(c.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return members;
}

/**
 * Chat header meter showing the current context size — an estimate of the
 * total tokens the model is carrying for this conversation, across everything:
 * user turns, uploaded file text, tool responses, and the model's own answers,
 * thinking, and tool calls. Hover/click for the input vs output split.
 *
 * When the chat has sub-agents it also reports the **session** total (0.9.12).
 * The local number answers "am I about to overflow this model's window"; it says
 * nothing about a leader that fanned six specialists across a codebase and is
 * carrying 20k itself while the team carries a million. That was invisible
 * everywhere the user actually looks, which is the one chat they manage.
 *
 * Estimated from character length (no exact tokenizer for arbitrary local
 * models), so it's a guide, not a billed count.
 */
export function ContextMeter({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  const messages = useApp((s) => s.messagesByChat[chatId] ?? EMPTY);
  const chats = useApp((s) => s.chats);
  const setActiveChat = useApp((s) => s.setActiveChat);
  const teamMeterEnabled = useApp((s) => s.appSettings.teamContextMeter !== false);
  const streaming = useApp((s) => Boolean(s.streamingByChat[chatId]));
  const est = useMemo(() => chatContextEstimate(messages), [messages]);

  // Nothing to aggregate in an ordinary chat, so it costs an ordinary chat
  // nothing: no query is issued unless this one is part of a team.
  const hasTeam = useMemo(
    () => sessionMemberIds(chats, chatId).size > 1,
    [chats, chatId],
  );
  const showTeam = teamMeterEnabled && hasTeam;

  const [usage, setUsage] = useState<SessionUsage | null>(null);
  useEffect(() => {
    if (!showTeam) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      api.sessionContextUsage(chatId)
        .then((u) => { if (!cancelled) setUsage(u); })
        .catch(() => { /* a chat deleted mid-poll is not worth a banner */ });
    };
    load();
    // Between turns the totals are static — the effect re-runs on the streaming
    // edge, which is the only thing that moves them.
    if (!streaming && !open) return () => { cancelled = true; };
    const id = setInterval(load, TEAM_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [showTeam, chatId, streaming, open]);

  if (messages.length === 0 && !usage) return null;

  const teamTotal = showTeam && usage ? usage.totalTokens : null;

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
        title={
          teamTotal != null
            ? "This chat's context, then the whole team's (estimated)"
            : "Current context size (estimated)"
        }
      >
        <Gauge size={12} />
        <span className="font-mono">{formatTokens(est.totalTokens)}</span>
        <span className="hidden sm:inline">ctx</span>
        {teamTotal != null && (
          <span className="ml-0.5 flex items-center gap-1 border-l border-[var(--color-border)] pl-1.5 text-[var(--color-accent)]">
            <Users size={11} />
            <span className="font-mono">{formatTokens(teamTotal)}</span>
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 min-w-[260px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-xs shadow-lg">
            <div className="mb-1 font-medium text-[var(--color-text)]">
              This chat (est.)
            </div>
            <MeterRow label="Input (you, files, tools)" value={est.inputTokens} />
            <MeterRow label="Output (answers, thinking, tools)" value={est.outputTokens} />
            <div className="mt-1 border-t border-[var(--color-border)] pt-1">
              <MeterRow label="Total" value={est.totalTokens} strong />
            </div>

            {usage && usage.agents.length > 1 && (
              <div className="mt-2 border-t border-[var(--color-border)] pt-2">
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <span className="font-medium text-[var(--color-text)]">Across the team</span>
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    {usage.agents.length} agents
                  </span>
                </div>
                <div className="-mx-1 max-h-44 overflow-y-auto px-1">
                  {usage.agents.map((a) => (
                    <button
                      key={a.chatId}
                      onClick={() => { setActiveChat(a.chatId); setOpen(false); }}
                      title={`${a.messages} message(s) — open this chat`}
                      className="flex w-full items-baseline justify-between gap-3 rounded py-0.5 text-left hover:bg-[var(--color-panel-hover)]"
                    >
                      <span
                        className="truncate text-[var(--color-text-muted)]"
                        style={{ paddingLeft: `${Math.min(a.depth, 4) * 10}px` }}
                      >
                        {a.depth > 0 && "↳ "}
                        {a.zoneName ?? a.title}
                        {a.isCurrent && (
                          <span className="text-[var(--color-accent)]"> · here</span>
                        )}
                      </span>
                      <span className="shrink-0 font-mono text-[var(--color-text)]">
                        {formatTokens(a.totalTokens)}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mt-1 border-t border-[var(--color-border)] pt-1">
                  <MeterRow label="Session input" value={usage.inputTokens} />
                  <MeterRow label="Session output" value={usage.outputTokens} />
                  <MeterRow label="Session total" value={usage.totalTokens} strong />
                </div>
              </div>
            )}

            <div className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              Estimated from text length — a guide, not an exact token count.
              {usage && usage.agents.length > 1 && (
                <> Each agent carries its own context; only this chat&apos;s counts
                against this window.</>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MeterRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--color-text-muted)]">{label}</span>
      <span
        className={`font-mono ${strong ? "text-[var(--color-text)] font-semibold" : "text-[var(--color-text)]"}`}
      >
        {formatTokens(value)}
      </span>
    </div>
  );
}
