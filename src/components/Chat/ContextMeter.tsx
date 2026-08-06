import { useEffect, useMemo, useState } from "react";
import { Gauge, Receipt, Users } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { formatTokens } from "@/lib/format";
import { chatContextEstimate } from "@/lib/tokens";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import type { AgentUsage, Chat, SessionUsage } from "@/lib/types";

const EMPTY: never[] = [];

/** How often the figures are re-read while the chat is generating. They only
 *  move when a message is saved, so this is about keeping a long fan-out honest,
 *  not about smoothness. */
const REFRESH_MS = 5000;

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
  // Each pass adds one more generation; a pass that adds nothing ends the loop.
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
 * Chat header meter showing what the model is actually carrying.
 *
 * Two halves, because they behave differently. The **conversation** is what has
 * been said — it grows as you talk, and it is what the frontend can estimate
 * instantly from the messages it already has. The **baseline** is what every
 * single request pays before a word of it: the zone's system prompt, the skills
 * catalog, injected memories, project and tag context, and the tool schemas —
 * which for a well-equipped zone are the largest item of the lot and are re-sent
 * on every step, not once per turn. Only the backend can measure that, because
 * only the turn builder knows what it assembles, so the same functions that
 * build a request are the ones measured here (0.9.12).
 *
 * When the chat has sub-agents it also reports the whole session's total — a
 * leader carrying 20k while six specialists carry a million between them used to
 * look identical to a quiet chat, in the one pane the user actually watches.
 *
 * All of that is **context**: how big the next request is, and whether it still
 * fits. It is not what the provider charges for, and the meter used to imply it
 * was — a session reading 1.1m turned up on a DeepSeek invoice at 32m, because
 * every step of every turn re-sends the whole context and each step is billed
 * for it. So spend is tracked separately now (0.9.13): counted on each request
 * as it goes out, and taken from the provider's own usage block wherever there
 * is one. Context is estimated and labelled as such; spend is measured.
 *
 * Everything here is scoped to the conversation in front of you — this chat and
 * its team. The install's lifetime total is a real figure but not one about
 * *this* chat, and sitting under a live meter it read as though it were, so it
 * lives in Settings → Data instead (0.9.14).
 */
export function ContextMeter({ chatId }: { chatId: string }) {
  const [open, setOpen] = useState(false);
  useDismissOnEscape(open, () => setOpen(false));
  const messages = useApp((s) => s.messagesByChat[chatId] ?? EMPTY);
  const chats = useApp((s) => s.chats);
  const setActiveChat = useApp((s) => s.setActiveChat);
  const teamMeterEnabled = useApp((s) => s.appSettings.teamContextMeter !== false);
  const streaming = useApp((s) => Boolean(s.streamingByChat[chatId]));

  // The conversation half, live from what the store already holds — no round
  // trip, so it updates the moment a message lands rather than on the next poll.
  const est = useMemo(() => chatContextEstimate(messages), [messages]);

  const [usage, setUsage] = useState<SessionUsage | null>(null);
  // Only a change of chat invalidates what we're holding. Clearing it whenever
  // the fetch effect re-runs would blank the popover's figures each time it was
  // opened, which is the moment they're being read.
  useEffect(() => { setUsage(null); }, [chatId]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.sessionContextUsage(chatId)
        .then((u) => { if (!cancelled) setUsage(u); })
        .catch(() => { /* a chat deleted mid-poll is not worth a banner */ });
    };
    load();
    // Between turns the baseline is static and the conversation half is already
    // live locally, so there is nothing to poll for.
    if (!streaming && !open) return () => { cancelled = true; };
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [chatId, streaming, open]);

  const current: AgentUsage | null = usage?.agents.find((a) => a.isCurrent) ?? null;
  const baseline = current?.overheadTokens ?? 0;
  const chatTotal = est.totalTokens + baseline;

  // Spend, shown whenever anything has been sent — team or not. A single chat
  // that ran a forty-step turn is exactly the case where the context reading and
  // the invoice diverge, and it has no team row to explain the gap away.
  const chatSpent = current?.spent ?? null;
  const sessionSpent = usage?.spent ?? null;
  const hasSpend = !!chatSpent && chatSpent.requests > 0;
  // `lastInputTokens` is the one context figure in the popover that isn't
  // reconstructed from stored messages — it was measured on the request as it
  // went out, which is what makes it worth showing next to our estimate.
  const measuredLast = chatSpent?.lastInputTokens ?? 0;
  // Only "measured" if every request came back with real counts; a mix would
  // otherwise be presented as if the provider had vouched for all of it.
  const spendIsMeasured =
    !!chatSpent && chatSpent.requests > 0 && chatSpent.reportedRequests >= chatSpent.requests;

  const hasTeam = useMemo(
    () => sessionMemberIds(chats, chatId).size > 1,
    [chats, chatId],
  );
  const showTeam = teamMeterEnabled && hasTeam && !!usage && usage.agents.length > 1;
  // The backend counted this chat's messages a moment ago; the local estimate is
  // current. Swapping one for the other keeps the session total consistent with
  // the per-chat number shown right above it.
  const sessionTotal = showTeam && usage
    ? usage.totalTokens - (current?.messageTokens ?? 0) + est.totalTokens
    : null;

  // The spend chip tracks whichever scope the context chip beside it is showing,
  // so the two numbers on the button are always about the same set of chats. A
  // chat that has sent nothing yet has no bill to show, only a context.
  const scopedSpend = showTeam ? sessionSpent : chatSpent;
  const buttonSpend = scopedSpend && scopedSpend.requests > 0 ? scopedSpend : null;

  if (messages.length === 0 && baseline === 0) return null;

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
        title={[
          sessionTotal != null
            ? "Context: this chat's, then the whole team's (estimated)"
            : "Context this chat carries — conversation plus its per-turn baseline (estimated)",
          buttonSpend &&
            `Spent: ${formatTokens(buttonSpend.totalTokens)} over ${buttonSpend.requests} request(s). Every step of a turn re-sends the whole context and is billed for it, so this runs far ahead of the context figure.`,
        ]
          .filter(Boolean)
          .join("\n\n")}
      >
        <Gauge size={12} />
        <span className="font-mono">{formatTokens(chatTotal)}</span>
        <span className="hidden sm:inline">ctx</span>
        {sessionTotal != null && (
          <span className="ml-0.5 flex items-center gap-1 border-l border-[var(--color-border)] pl-1.5 text-[var(--color-accent)]">
            <Users size={11} />
            <span className="font-mono">{formatTokens(sessionTotal)}</span>
          </span>
        )}
        {buttonSpend && (
          <span className="ml-0.5 flex items-center gap-1 border-l border-[var(--color-border)] pl-1.5">
            <Receipt size={11} />
            <span className="font-mono">{formatTokens(buttonSpend.totalTokens)}</span>
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 min-w-[290px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-xs shadow-lg">
            <div className="mb-1 font-medium text-[var(--color-text)]">This chat (est.)</div>

            <MeterRow label="Baseline, every request" value={baseline} />
            {current?.overheadParts.map((p) => (
              <MeterRow key={p.label} label={p.label} value={p.tokens} sub />
            ))}
            {current && current.toolsTokens > 0 && (
              <MeterRow
                label={`Tool schemas (${current.toolCount})`}
                value={current.toolsTokens}
                sub
              />
            )}

            <div className="mt-1.5">
              <MeterRow label="Conversation" value={est.totalTokens} />
              <MeterRow label="Input (you, files, tools)" value={est.inputTokens} sub />
              <MeterRow label="Output (answers, thinking)" value={est.outputTokens} sub />
            </div>

            <div className="mt-1 border-t border-[var(--color-border)] pt-1">
              <MeterRow label="Total" value={chatTotal} strong />
              {measuredLast > 0 && (
                <MeterRow label="Last request, measured" value={measuredLast} sub />
              )}
            </div>

            {hasSpend && chatSpent && (
              <div className="mt-2 border-t border-[var(--color-border)] pt-2">
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <span className="font-medium text-[var(--color-text)]">
                    Spent {spendIsMeasured ? "" : "(part est.)"}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-muted)]">
                    {chatSpent.requests} request{chatSpent.requests === 1 ? "" : "s"}
                  </span>
                </div>
                <MeterRow label="Input, all requests" value={chatSpent.inputTokens} />
                {chatSpent.cachedInputTokens > 0 && (
                  <MeterRow
                    label={`of which cached${hitRate(chatSpent)}`}
                    value={chatSpent.cachedInputTokens}
                    sub
                  />
                )}
                <MeterRow label="Output" value={chatSpent.outputTokens} />
                <div className="mt-1 border-t border-[var(--color-border)] pt-1">
                  <MeterRow label="Billed total" value={chatSpent.totalTokens} strong />
                </div>
              </div>
            )}

            {showTeam && usage && (
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
                      title={`${a.messages} message(s), ${formatTokens(a.overheadTokens)} baseline — open this chat`}
                      className="flex w-full items-baseline justify-between gap-3 rounded py-0.5 text-left hover:bg-[var(--color-panel-hover)]"
                    >
                      <span
                        className="truncate text-[var(--color-text-muted)]"
                        style={{ paddingLeft: `${Math.min(a.depth, 4) * 10}px` }}
                      >
                        {a.depth > 0 && "↳ "}
                        {a.zoneName ?? a.title}
                        {a.isCurrent && <span className="text-[var(--color-accent)]"> · here</span>}
                      </span>
                      <span className="shrink-0 font-mono text-[var(--color-text)]">
                        {formatTokens(
                          a.isCurrent ? chatTotal : a.totalTokens,
                        )}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="mt-1 border-t border-[var(--color-border)] pt-1">
                  <MeterRow label="Baselines" value={usage.overheadTokens} />
                  <MeterRow label="Conversations" value={usage.inputTokens + usage.outputTokens} />
                  <MeterRow label="Session context" value={sessionTotal ?? 0} strong />
                  {sessionSpent && sessionSpent.requests > 0 && (
                    <>
                      <MeterRow label="Session spend" value={sessionSpent.totalTokens} strong />
                      <MeterRow
                        label={`over ${sessionSpent.requests} requests${hitRate(sessionSpent)}`}
                        value={sessionSpent.cachedInputTokens}
                        sub
                        suffix=" cached"
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            <div className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
              Context is the size of the next request, estimated from text length.
              {showTeam && " Each agent carries its own."}
              {hasSpend && chatSpent && (
                <>
                  {" "}
                  Spend is every request added up — each step of a turn re-sends
                  the whole context — so it runs far ahead.
                  {!spendIsMeasured && " This provider reports no counts, so it's estimated too."}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Cached input as a share of all input, e.g. " (94%)".
 *
 * The absolute figure alone doesn't say whether it's any good — 400k cached
 * reads as a lot until you notice it was 4M sent. The share is the number that
 * tells you the prompt prefix is holding steady across turns, and it's the one
 * worth watching after changing anything that goes into the system prompt.
 * Empty string when there's no input to divide by, so the label just reads
 * normally.
 */
function hitRate(spent: { inputTokens: number; cachedInputTokens: number }): string {
  if (spent.inputTokens <= 0) return "";
  return ` (${Math.round((spent.cachedInputTokens / spent.inputTokens) * 100)}%)`;
}

function MeterRow({
  label,
  value,
  strong,
  sub,
  suffix,
}: {
  label: string;
  value: number;
  strong?: boolean;
  /** An indented component of the row above it. */
  sub?: boolean;
  /** Qualifies the figure where the label alone can't, e.g. " cached". */
  suffix?: string;
}) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${sub ? "pl-3" : ""}`}>
      <span className={sub ? "text-[10px] text-[var(--color-text-muted)]" : "text-[var(--color-text-muted)]"}>
        {label}
      </span>
      <span
        className={`font-mono ${sub ? "text-[10px] text-[var(--color-text-muted)]" : "text-[var(--color-text)]"} ${
          strong ? "font-semibold" : ""
        }`}
      >
        {formatTokens(value)}
        {suffix}
      </span>
    </div>
  );
}
