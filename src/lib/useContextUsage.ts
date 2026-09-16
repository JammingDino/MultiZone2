import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { chatContextEstimate } from "@/lib/tokens";
import type { AgentUsage, Chat, SessionUsage } from "@/lib/types";

const EMPTY: never[] = [];

/** How often the figures are re-read while the chat is generating. They only
 *  move when a message is saved, so this is about keeping a long fan-out honest,
 *  not about smoothness. */
const REFRESH_MS = 5000;

/**
 * Everything the context readout knows, in one place (0.17.9).
 *
 * This was the body of the header meter's popover. The figures now live in the
 * workspace panel, drawn as bars, while the header keeps a one-line chip — so
 * the sums are computed once here and both read them.
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
 * All of that is **context**: how big the next request is. It is not what the
 * provider charges for — every step of every turn re-sends the whole context and
 * each step is billed for it — so spend is tracked separately (0.9.13): counted
 * on each request as it goes out, and taken from the provider's own usage block
 * wherever there is one. Context is estimated and labelled as such; spend is
 * measured.
 *
 * `live` keeps the backend figures refreshing while something is looking at
 * them (the panel is open); otherwise they refresh only while a turn runs.
 */
export function useContextUsage(chatId: string, live: boolean) {
  const messages = useApp((s) => s.messagesByChat[chatId] ?? EMPTY);
  const chats = useApp((s) => s.chats);
  const teamMeterEnabled = useApp((s) => s.appSettings.teamContextMeter !== false);
  const streaming = useApp((s) => Boolean(s.streamingByChat[chatId]));

  // Compaction is a property of the chat row, and it changes what the
  // conversation half is worth — so it is read here and handed to the
  // estimator rather than left for the reader to apply in their head.
  const chat = useApp((s) => s.chats.find((c) => c.id === chatId) ?? null);
  const summary = chat?.contextSummary ?? null;
  const summaryThrough = chat?.contextSummaryThrough ?? null;

  // The conversation half, live from what the store already holds — no round
  // trip, so it updates the moment a message lands rather than on the next poll.
  const est = useMemo(
    () => chatContextEstimate(messages, { contextSummary: summary, contextSummaryThrough: summaryThrough }),
    [messages, summary, summaryThrough],
  );

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
    if (!streaming && !live) return () => { cancelled = true; };
    const id = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [chatId, streaming, live]);

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

  // The session spend limit (0.14.3), which is a different thing from every
  // other number in this popover and the one most easily confused with them.
  // Context is how big the next request is; this is what the whole session has
  // *cost*, against a ceiling the user set, and it is the only figure here that
  // can stop a run. Always the session total — a limit that a leader could
  // stay under while its panel spent freely would not be a limit.
  // This session's own ceiling if it has set one, otherwise the global default
  // (0.14.4). `0` is a real answer — unmetered — so only `null` inherits.
  const globalLimit = useApp((s) => s.appSettings.maxSessionTokens);
  const ownLimit = useApp((s) => s.chats.find((c) => c.id === chatId)?.spendLimit ?? null);
  const spendLimit = ownLimit ?? globalLimit;
  const limitSpent = sessionSpent?.totalTokens ?? 0;
  const limitPct = spendLimit > 0 ? Math.min(1, limitSpent / spendLimit) : 0;
  const limitState =
    spendLimit <= 0 ? null : limitPct >= 1 ? "over" : limitPct >= 0.8 ? "near" : "under";

  const empty = messages.length === 0 && baseline === 0;

  // The model's ceiling, when the backend found one (0.17.9). Discovered from
  // the provider, the local server, the models.dev catalogue or the name —
  // see `llm::context_window` — and labelled with which, because a figure
  // from a catalogue is a claim about the model and one from the server is a
  // fact about this deployment.
  const contextWindow = current?.contextWindow ?? null;
  const windowFraction = contextWindow ? Math.min(1, chatTotal / contextWindow.tokens) : null;

  return {
    est,
    usage,
    current,
    baseline,
    chatTotal,
    chatSpent,
    sessionSpent,
    hasSpend,
    measuredLast,
    spendIsMeasured,
    showTeam,
    sessionTotal,
    buttonSpend,
    spendLimit,
    ownLimit,
    limitSpent,
    limitPct,
    limitState,
    empty,
    model: current?.model ?? null,
    contextWindow,
    windowFraction,
  };
}

export type ContextUsage = ReturnType<typeof useContextUsage>;

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
export function hitRate(spent: { inputTokens: number; cachedInputTokens: number }): string {
  if (spent.inputTokens <= 0) return "";
  return ` (${Math.round((spent.cachedInputTokens / spent.inputTokens) * 100)}%)`;
}

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

