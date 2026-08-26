import { create } from "zustand";
import { DEFAULT_APP_SETTINGS, type AppSettings, type Chat, type Checkpoint, type RestoreReport, type RewindReport, type RewindStatus, type ChatTagEntry, type ChatTagLink, type ChatZone, type McpServerView, type Memory, type Message, type PendingMessage, type PendingMode, type Plan, type PlanStep, type Project, type Provider, type Skill, type SkillPack, type Tag, type Zone } from "@/lib/types";
import * as api from "@/lib/tauri";
// Dictation goes through its own seam: the microphone is on this device, and
// on a phone that means the WebView rather than the machine running the app.
import * as dictation from "@/lib/dictation";
import type { SettingsBundle } from "@/lib/settingsBundle";
import { clearAttention, notifyWaiting } from "@/lib/notify";
import { shade } from "@/lib/color";
import { normalizeApprovals } from "@/lib/approvals";

/**
 * Chats whose opening turn has already kicked off an auto-title, so the check
 * that runs on every streamed token fires exactly once. Not persisted — a chat
 * is only ever auto-titled on its first turn, which can't recur in a later
 * session.
 */
const autoTitledChats = new Set<string>();

// Sidebar open/closed persists across sessions under the same `ui.sidebarOpen`
// localStorage key the sidebar used before this moved into the store, so an
// existing install keeps its layout.
const SIDEBAR_KEY = "ui.sidebarOpen";
function readSidebarOpen(): boolean {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}
function writeSidebarOpen(open: boolean) {
  try { localStorage.setItem(SIDEBAR_KEY, String(open)); } catch { /* ignore */ }
}

export type StreamPhase =
  | "thinking"
  | "answering"
  | "tool_calling"
  | "tool_running";

export interface StreamingState {
  messageId: string;
  content: string;
  /** Live reasoning content streamed by the current assistant turn. */
  reasoning: string;
  phase: StreamPhase;
  /** Tool calls being constructed via deltas in the current assistant turn. */
  pendingTools: { index: number; name: string; args: string }[];
  /** The tool that is actively executing (between executing event and result). */
  runningTool: string | null;
  /** Wall-clock time when the assistant turn started (request kicked off). */
  startedAt: number;
  /** Wall-clock time when we received the first content/reasoning token, or
   * `null` while still waiting on the provider. Used as the timer's origin so
   * the visible duration reflects generation time and not network latency. */
  firstTokenAt: number | null;
}

/** Stats kept per-message-id for the toolbar under each assistant bubble. */
export interface MessageStats {
  /** Total wall-clock from first token to assistant_saved. */
  durationMs: number;
  /** Latency from request kickoff to the first streamed token. */
  timeToFirstTokenMs: number | null;
  contentChars: number;
  reasoningChars: number;
  /** Chars the model generated as tool-call arguments this turn. These are
   *  real output tokens — they cost generation time — so they count toward the
   *  turn's output total and tok/s. */
  toolCallChars: number;
  /** Cumulative time tools spent *executing* this turn. Excluded from tok/s so
   *  throughput reflects generation, not tool wall-clock. */
  toolMs: number;
  /** Cumulative time this turn sat waiting for a human to approve a tool call
   *  (0.14.3). Excluded from tok/s for the same reason as `toolMs`, and more
   *  starkly: a turn where someone took two minutes to press Approve reported
   *  1 tok/s from a provider that was running at fifty. */
  approvalMs: number;
  /** Cumulative time spent encoding input before output resumed, on every step
   *  after the first (0.14.4). Also excluded from tok/s — the model is reading,
   *  not writing, and on a long agentic turn this is most of the clock. */
  prefillMs: number;
}

/**
 * Running totals for the entire user turn (from the user's send up through
 * the last assistant_saved before `done`). Survives across iterations of the
 * agentic loop so the live token counter / timer in the status banner don't
 * reset between tool calls. Reset on `user_message_saved`, cleared on
 * `done` / `error` / `cancelled`.
 */
export interface TurnAggregate {
  /** Time the turn began (user's `send` event). */
  startedAt: number;
  /** Time of the first content or thinking token in the whole turn. */
  firstTokenAt: number | null;
  contentChars: number;
  reasoningChars: number;
  /** Cumulative chars in tool call arguments across all tool calls this turn. */
  toolCallChars: number;
  /** Cumulative wall-clock of *completed* tool executions this turn. */
  toolMs: number;
  /** Start time of the tool currently executing (null when none is running).
   *  Lets the live banner discount the in-progress tool's time from tok/s. */
  toolStartedAt: number | null;
  /** Cumulative time spent waiting for a human to answer an approval (0.14.3). */
  approvalMs: number;
  /** When the approval currently on screen was raised, or null. */
  approvalStartedAt: number | null;
  /**
   * Cumulative **prefill** — time the model spent encoding its input before
   * streaming anything back, on every step after the first (0.14.4).
   *
   * The first step's prefill is the time-to-first-token, which is already
   * outside the turn's clock because that clock starts at the first token. But
   * a multi-step turn prefills *again* after every tool result, re-encoding a
   * context that has just grown — and on a long agentic turn that is most of
   * the wall clock. Counting it as generation time is how a fast provider
   * reports a slow number.
   */
  prefillMs: number;
  /** When the current step began encoding, or null once its output started. */
  prefillStartedAt: number | null;
  /**
   * Recent output, for the *live* rate (0.14.3): `[timestamp, chars]` pairs,
   * pruned to the last few seconds.
   *
   * The turn average and the current rate are different questions. "How fast is
   * this provider going right now" is what someone watches a stream to learn —
   * and it is the number that tells them a local model has fallen off a cliff,
   * or that switching provider did anything. A whole-turn average cannot show
   * either: it is dragged down by every pause that already happened and moves
   * more slowly the longer the turn runs.
   */
  recentChars: [number, number][];
}

/** Window for the live rate. Long enough to survive the gaps between streamed
 *  chunks, short enough to follow a provider that changes speed. */
export const LIVE_RATE_WINDOW_MS = 5_000;

export function freshTurn(startedAt = Date.now()): TurnAggregate {
  return {
    startedAt,
    firstTokenAt: null,
    contentChars: 0,
    reasoningChars: 0,
    toolCallChars: 0,
    toolMs: 0,
    toolStartedAt: null,
    approvalMs: 0,
    approvalStartedAt: null,
    prefillMs: 0,
    prefillStartedAt: null,
    recentChars: [],
  };
}

/**
 * Folds one stream event into a turn's running totals. The primary turn and
 * every perspective zone run the same agentic loop and are accounted the same
 * way — they share this reducer so a zone's live banner and its saved stats
 * can't drift from the primary's, which is exactly what happened when the two
 * kept separate copies of this arithmetic.
 */
function applyTurnEvent(
  turn: TurnAggregate | undefined,
  event: import("@/lib/types").StreamEvent,
  now: number,
): TurnAggregate | undefined {
  if (!turn) return turn;
  switch (event.type) {
    case "assistant_start":
      // A new step of the agentic loop: the model is now re-encoding the whole
      // context, which is not generation. Only tracked once the turn has
      // produced something — the *first* step's encode is the time-to-first-
      // token, and the turn's clock has not started yet, so counting it here
      // would subtract it twice.
      return {
        ...turn,
        prefillStartedAt: turn.firstTokenAt === null ? null : now,
      };
    case "token":
      return {
        ...turn,
        firstTokenAt: turn.firstTokenAt ?? now,
        contentChars: turn.contentChars + event.delta.length,
        recentChars: pushSample(turn.recentChars, now, event.delta.length),
        ...closePrefill(turn, now),
      };
    case "thinking_token":
      return {
        ...turn,
        firstTokenAt: turn.firstTokenAt ?? now,
        reasoningChars: turn.reasoningChars + event.delta.length,
        recentChars: pushSample(turn.recentChars, now, event.delta.length),
        ...closePrefill(turn, now),
      };
    case "tool_call_args_delta":
      // Tool arguments are generated tokens too — they cost the model time, so
      // they count toward the turn's output and throughput, and their first
      // delta ends the encode just as a content token would.
      return {
        ...turn,
        toolCallChars: turn.toolCallChars + event.delta.length,
        recentChars: pushSample(turn.recentChars, now, event.delta.length),
        ...closePrefill(turn, now),
      };
    case "tool_call_executing":
      // Mark when execution began so its wall-clock can be excluded from tok/s
      // (the model isn't generating while a tool runs). Reaching here also means
      // any approval was answered — approved calls execute, denied ones never
      // emit this.
      return { ...turn, toolStartedAt: now, ...closeApproval(turn, now) };
    case "tool_approval_required":
      // The clock that made a 50 tok/s provider report 1.0 (0.14.3). Held
      // separately from tool time: "the tools were slow" and "nobody was at the
      // keyboard" are different facts about a turn, and only one of them is
      // about the machine.
      return { ...turn, approvalStartedAt: turn.approvalStartedAt ?? now };
    case "tool_call_result": {
      // A denial produces a result with no execution, so the approval clock is
      // closed here too rather than only on the approved path.
      const approval = closeApproval(turn, now);
      if (turn.toolStartedAt === null) return { ...turn, ...approval };
      return {
        ...turn,
        ...approval,
        toolMs: turn.toolMs + (now - turn.toolStartedAt),
        toolStartedAt: null,
      };
    }
    default:
      return turn;
  }
}

/** Append an output sample and drop everything outside the live window. */
function pushSample(
  samples: [number, number][],
  now: number,
  chars: number,
): [number, number][] {
  const cutoff = now - LIVE_RATE_WINDOW_MS;
  const kept = samples.filter(([at]) => at >= cutoff);
  kept.push([now, chars]);
  return kept;
}

/** Stop the approval clock, if one is running. */
function closeApproval(turn: TurnAggregate, now: number): Partial<TurnAggregate> {
  if (turn.approvalStartedAt === null) return {};
  return {
    approvalMs: turn.approvalMs + (now - turn.approvalStartedAt),
    approvalStartedAt: null,
  };
}

/** Stop the prefill clock: output has started arriving for this step. */
function closePrefill(turn: TurnAggregate, now: number): Partial<TurnAggregate> {
  if (turn.prefillStartedAt === null) return {};
  return {
    prefillMs: turn.prefillMs + (now - turn.prefillStartedAt),
    prefillStartedAt: null,
  };
}

/**
 * The per-message stats readout for a finished assistant message, computed from
 * the turn aggregate rather than the last loop iteration — otherwise a
 * multi-step turn reports only its final step's tokens and time.
 */
function statsFromTurn(
  turn: TurnAggregate | undefined,
  fallback: StreamingState,
  now: number,
): MessageStats {
  const turnStart = turn?.startedAt ?? fallback.startedAt;
  const firstTokenAt = turn?.firstTokenAt ?? fallback.firstTokenAt;
  // Duration measures generation time, not network wait. With no streamed
  // tokens at all, fall back to total time so this never shows 0.
  const start = firstTokenAt ?? turnStart;
  return {
    durationMs: now - start,
    timeToFirstTokenMs: firstTokenAt !== null ? firstTokenAt - turnStart : null,
    contentChars: turn ? turn.contentChars : fallback.content.length,
    reasoningChars: turn ? turn.reasoningChars : fallback.reasoning.length,
    toolCallChars: turn
      ? turn.toolCallChars
      : fallback.pendingTools.reduce((n, t) => n + t.args.length, 0),
    // Any tool still marked running shouldn't normally happen at save time,
    // but count it rather than under-reporting tool time.
    toolMs: (turn?.toolMs ?? 0) + (turn?.toolStartedAt != null ? now - turn.toolStartedAt : 0),
    approvalMs:
      (turn?.approvalMs ?? 0) +
      (turn?.approvalStartedAt != null ? now - turn.approvalStartedAt : 0),
    prefillMs:
      (turn?.prefillMs ?? 0) +
      (turn?.prefillStartedAt != null ? now - turn.prefillStartedAt : 0),
  };
}

export interface PendingApproval {
  index: number;
  name: string;
  arguments: string;
  /**
   * The change a file-writing tool proposes, as a diff (0.10.2) — so approval
   * is an informed act rather than a judgement on a wall of proposed content.
   * Null for every other tool, and for a proposal with nothing to show.
   */
  diff: import("@/lib/types").FileDiff | null;
  /** Perspective zone awaiting approval; undefined = the primary turn. */
  zoneId?: string;
}

/**
 * A turn that ended in failure rather than an answer (1.0).
 *
 * The backend has always emitted `error` for a failed provider call — bad key,
 * rate limit, unreachable host, model that doesn't exist — but the frontend used
 * to treat it purely as a signal to tear the stream down. Since no assistant
 * message is ever saved on that path, the whole turn then rendered as nothing at
 * all: the user's message sat there and the app looked like it had simply
 * stopped caring. Holding the message here lets the thread say what went wrong.
 */
export interface ChatError {
  message: string;
  at: number;
  /** Set when the failure was a perspective zone's rather than the primary's. */
  zoneId?: string;
  /**
   * `"runaway"` for a run loop detection stopped (0.14.1). Not a provider
   * failure: the turn is still alive and about to answer, and none of the
   * provider advice — check your key, try again — applies. The card reads
   * differently for it.
   */
  kind?: "runaway";
}

/** A settings bundle staged for import, raised from Settings, onboarding or a file drop. */
export interface PendingImport {
  bundle: SettingsBundle;
  /** File name or short description of where it came from, for the dialog. */
  source: string;
}

interface AppStore {
  // collections
  providers: Provider[];
  /** True once the first providers fetch has completed (gates onboarding). */
  providersLoaded: boolean;
  zones: Zone[];
  chats: Chat[];
  projects: Project[];
  tags: Tag[];
  /** Global skill catalog — managed in Settings → Skills. */
  skills: Skill[];
  /** Saved parameterised runs (0.15.4). */
  savedRuns: import("@/lib/types").SavedRun[];
  refreshSavedRuns: () => Promise<void>;
  /** Folder-backed skills found on disk, offered alongside `skills`. */
  skillPacks: SkillPack[];
  /** Registered MCP servers (+ their tools and live status) — Settings → MCP. */
  mcpServers: McpServerView[];
  /** All memory entries across scopes — backs the settings viewer. */
  memories: Memory[];
  tagsByChat: Record<string, ChatTagEntry[]>;
  /** Every chat's tags in one flat list — drives sidebar chips + tag filtering. */
  chatTagLinks: ChatTagLink[];
  /** Perspective zones per chat: chatId → ChatZone[] */
  chatZonesByChat: Record<string, ChatZone[]>;

  // current selection
  activeChatId: string | null;
  messagesByChat: Record<string, Message[]>;
  streamingByChat: Record<string, StreamingState>;
  /** Active perspective streams: chatId → { zoneId → StreamingState } */
  perspectiveStreamsByChat: Record<string, Record<string, StreamingState>>;
  /** Running stats for the current user turn (survives multi-step loops). */
  turnByChat: Record<string, TurnAggregate>;
  /** The same running stats for each perspective zone: chatId → { zoneId → totals }.
   *  Kept per zone so every participant's banner reports its own generation,
   *  not the primary's and not a single loop iteration's. */
  perspectiveTurnByChat: Record<string, Record<string, TurnAggregate>>;
  /** Chat IDs whose title is currently being regenerated. */
  regeneratingTitles: Set<string>;
  /** Pending tool approvals per chat: chatId → one entry per participant (primary
   * + perspective zones) currently awaiting approval. */
  pendingApprovalByChat: Record<string, PendingApproval[]>;
  /** Smart routing state per chat. null = idle, "routing" = LLM call in progress, done = zone was resolved. */
  routingByChat: Record<string, { status: "routing" } | { status: "done"; zoneId: string; zoneName: string } | null>;
  /**
   * Failures from the last turn, per chat — one entry for the primary plus one
   * per perspective zone that failed. Cleared when the next turn starts, so the
   * thread shows the current state rather than an archive of past outages.
   */
  errorsByChat: Record<string, ChatError[]>;
  dismissChatErrors: (chatId: string) => void;

  /**
   * Chats stopped by the session spend limit (0.14.3), keyed by chat.
   *
   * Separate from `errorsByChat` because it is not a failure and not
   * dismissable: the run is stopped and stays stopped until the limit is raised
   * or removed. Cleared when that happens, or when the chat is retried.
   */
  spendLimitByChat: Record<string, { spent: number; cap: number; midTurn: boolean; at: number }>;
  /** Raise (or remove, with 0) the session limit and resume the stopped chat. */
  raiseSpendLimit: (chatId: string, newCap: number) => Promise<void>;

  /**
   * Messages the user sent while a turn was still running, per chat, waiting to
   * reach the model (0.9.12). The backend owns the real queue — this mirrors it
   * so the composer can show what's waiting and let the user take it back.
   * Entries clear on the `steer_delivered` / `pending_cleared` events.
   */
  pendingByChat: Record<string, PendingMessage[]>;
  /** Queue a message for a chat that is mid-turn. Returns false when the turn
   *  had already finished, meaning the caller should just send it normally. */
  queuePendingMessage: (chatId: string, text: string, mode: PendingMode) => Promise<boolean>;
  cancelPendingMessage: (chatId: string, id: string) => Promise<void>;

  /** A settings bundle waiting on the user's confirmation. Null = no import in flight. */
  pendingImport: PendingImport | null;
  /** Stage a parsed bundle for confirmation (Settings, onboarding, or a dropped file). */
  stageImport: (pending: PendingImport) => void;
  clearImport: () => void;
  /** Per-message generation stats, keyed by message id. */
  statsByMessage: Record<string, MessageStats>;
  /** Turns that changed files, per chat — what "revert this turn" acts on (0.10.1).
   *  Refreshed when a chat opens and when a turn finishes, because whether a
   *  path has diverged is a fact about the disk now, not when it was written. */
  checkpointsByChat: Record<string, Checkpoint[]>;
  loadCheckpoints: (chatId: string) => Promise<void>;
  /** Put a checkpoint's paths back. Returns what actually happened to each. */
  revertCheckpoint: (
    chatId: string,
    checkpointId: string,
    paths?: string[],
    force?: boolean,
  ) => Promise<RestoreReport>;
  /** Whether each chat has a rewind that can be walked forward again (1.1).
   *  Refreshed alongside `checkpointsByChat`, which is the same question about
   *  the same store asked in the other direction. */
  rewindByChat: Record<string, RewindStatus>;
  /** Put the tree back to how it stood at a message, reversibly. */
  rewindToMessage: (
    chatId: string,
    messageId: string,
    force?: boolean,
  ) => Promise<RewindReport>;
  /** Undo the most recent rewind in this chat. Null when there was none. */
  rewindForward: (chatId: string, force?: boolean) => Promise<RestoreReport | null>;
  /** Current visual theme. Persisted via the backend settings table. */
  theme: ThemePrefs;
  /** Whether `theme` reflects what is stored rather than the defaults. Writes
   *  are whole-object, so one before the read lands is an erase. */
  themeLoaded: boolean;
  setTheme: (theme: Partial<ThemePrefs>) => Promise<void>;
  loadThemeFromBackend: () => Promise<void>;

  appSettings: AppSettings;
  /** True once app settings have been read from the backend (gates seeding). */
  appSettingsLoaded: boolean;
  loadAppSettings: () => Promise<void>;
  setAppSettings: (partial: Partial<AppSettings>) => Promise<void>;

  // Voice / dictation (0.8.0) — transient recording state, not persisted.
  voiceSessionId: string | null;
  voiceRecording: boolean;
  voiceError: string | null;
  voiceInputDevices: import("@/lib/types").VoiceInputDevice[];
  startDictation: () => Promise<void>;
  stopDictation: () => Promise<string>;
  cancelDictation: () => Promise<void>;
  refreshVoiceInputDevices: () => Promise<void>;

  // Hands-free conversation mode (0.8.2): the chat whose STT↔TTS loop is active,
  // or null. Transient — not persisted.
  conversationChatId: string | null;
  setConversationChatId: (id: string | null) => void;

  // ui
  settingsOpen: boolean;
  zonesPanelOpen: boolean;
  zoneLibraryOpen: boolean;
  /**
   * Where "Configure Zones" was opened from, so it can offer a way back.
   * `"settings"` when it was reached through Settings → Zones — the library
   * then shows a back button that reopens Settings instead of dropping the user
   * on the chat. Null when it was opened from the sidebar, which has nothing to
   * go back to.
   */
  zoneLibraryReturnTo: "settings" | null;
  /**
   * Ask Configure Zones to open straight into the editor rather than onto the
   * library grid: `zoneId` is the zone to edit, or null to start a new one.
   *
   * There is no separate zone-editor modal any more (0.12.4). Editing a zone
   * from the chat's zone picker used to open one shell and editing the same
   * zone from Configure Zones another, so the same form arrived at two
   * different sizes with its sidebar in two different places. One panel, one
   * form: `openZoneEditor` now routes every entry point through here.
   */
  zoneLibraryInitialEdit: { zoneId: string | null } | null;
  /**
   * The Settings tab to land on the next time Settings opens (the id of a tab
   * in SettingsModal), or null for its own default. Set when something outside
   * Settings sends the user there — the zone library's back button, so it
   * returns to the Zones entry it was launched from rather than to Providers.
   */
  settingsInitialTab: string | null;
  /**
   * The chat whose session replay is on screen, or null.
   *
   * Kept in the store rather than in the chat panel because replay is offered
   * from two places now (#13) — the chat's own menu and the sidebar's
   * right-click menu — and the sidebar can ask for a chat that isn't the open
   * one.
   */
  replayChatId: string | null;
  defaultZoneId: string | null;
  shortcutsHelpOpen: boolean;
  /** Whether the sidebar is expanded. Persisted across sessions (ui.sidebarOpen). */
  sidebarOpen: boolean;
  /** Bumped to ask whichever composer is mounted (InputBar / HomeScreen) to focus. */
  focusComposerNonce: number;

  // actions
  refreshProviders: () => Promise<void>;
  refreshZones: () => Promise<void>;
  refreshChats: () => Promise<void>;
  setActiveChat: (id: string | null) => Promise<void>;
  /**
   * A message the thread should scroll to and flash once it is rendered
   * (0.15.0). Set by cross-chat search; cleared by `MessageThread` as soon as
   * it has landed, so re-entering the chat later does not jump again.
   */
  pendingJumpMessageId: string | null;
  /** Open `chatId` and scroll to `messageId` once its thread has loaded. */
  jumpToMessage: (chatId: string, messageId: string) => Promise<void>;
  clearPendingJump: () => void;
  /**
   * Fork a chat at a message into a new chat and switch to it.
   *
   * `restoreFiles` rewinds the working tree to the same point (0.10.1), so the
   * branch starts from the tree the copied history describes rather than from
   * whatever three later turns left behind. Returns the restore reports so
   * conflicts — a file edited outside the app — can be shown rather than
   * swallowed.
   */
  branchFromMessage: (
    chatId: string,
    messageId: string,
    solo?: boolean,
    zoneId?: string | null,
    restoreFiles?: boolean,
    scope?: import("@/lib/types").ForkScope,
    standalone?: boolean,
  ) => Promise<import("@/lib/types").RestoreReport[]>;
  /** Hand-edit an assistant message's text in place (persists + flags edited). */
  editMessage: (chatId: string, messageId: string, text: string) => Promise<void>;
  loadMessages: (chatId: string) => Promise<void>;
  applyStreamEvent: (chatId: string, event: import("@/lib/types").StreamEvent, perspectiveZoneId?: string) => void;
  setChatTitle: (chatId: string, title: string) => void;
  setChatZone: (chatId: string, zoneId: string | null) => Promise<void>;
  setChatSmart: (chatId: string, smart: boolean) => Promise<void>;
  /** Plan mode (0.12.0) — the user's hand on the same switch the model has. */
  setChatPlanMode: (chatId: string, on: boolean) => Promise<void>;
  /**
   * The plan waiting on the user, per chat. Loaded when a chat opens and
   * refreshed when a turn files one, so a plan proposed yesterday is still
   * there to approve today rather than living only in the live stream.
   */
  pendingPlanByChat: Record<string, Plan | null>;
  loadPendingPlan: (chatId: string) => Promise<void>;
  /**
   * Every plan in a chat and in the subchats below it (0.12.1) — the live task
   * state the checklist renders from, and, in a Multizone run, the leader's
   * plan and its sub-agents' in one list.
   */
  planTreeByChat: Record<string, Plan[]>;
  loadPlanTree: (chatId: string) => Promise<void>;
  setPlanSteps: (chatId: string, planId: string, steps: PlanStep[]) => Promise<void>;
  requestPlanStop: (chatId: string, planId: string) => Promise<void>;
  approvePlan: (chatId: string, planId: string, steps: PlanStep[] | null, edited: boolean) => Promise<void>;
  rejectPlan: (chatId: string, planId: string) => Promise<void>;
  /** Re-title a chat. `wholeConversation` (a user-forced regenerate) titles the
   *  chat as it now stands rather than from its opening message alone. */
  regenerateTitle: (chatId: string, wholeConversation?: boolean) => Promise<void>;
  /**
   * `hunks` approves only part of a previewed file change (0.10.2): the call
   * still runs, against exactly the content the user agreed to.
   */
  respondApproval: (
    chatId: string,
    zoneId: string | undefined,
    approved: boolean,
    hunks?: number[],
  ) => Promise<void>;

  openSettings: () => void;
  closeSettings: () => void;
  /** Show the session replay for `chatId`. */
  openReplay: (chatId: string) => void;
  closeReplay: () => void;
  /** Open Configure Zones on the editor for `id` (null = a new zone). */
  openZoneEditor: (id: string | null, returnTo?: "settings") => void;
  openZonesPanel: () => void;
  closeZonesPanel: () => void;
  openZoneLibrary: (returnTo?: "settings") => void;
  closeZoneLibrary: () => void;
  /** Leave the zone library and reopen whatever opened it (Settings). */
  returnFromZoneLibrary: () => void;
  setDefaultZone: (id: string | null) => Promise<void>;
  loadDefaultZone: () => Promise<void>;
  openShortcutsHelp: () => void;
  closeShortcutsHelp: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  /** Signal the active composer to take keyboard focus. */
  focusComposer: () => void;
  /**
   * Text to drop into the chat composer, with a nonce so the same text can be
   * staged twice (0.15.4). Staged rather than sent: a saved run is kept because
   * it worked once, and seeing the filled-in prompt is how you tell it still does.
   */
  composerDraft: { text: string; nonce: number; mode: "replace" | "append" };
  /**
   * `append` adds to whatever is already typed instead of replacing it —
   * referencing a chart or a table (0.16.1) is something you do *while*
   * writing the question about it, so replacing the question would be exactly
   * the wrong move.
   */
  setComposerDraft: (text: string, mode?: "replace" | "append") => void;
  /** Command palette (0.15.1) — one keystroke to anything with a name. */
  commandPaletteOpen: boolean;
  /**
   * Bumped to put the cursor in the sidebar's message-search box. A nonce
   * rather than a boolean for the same reason `focusComposerNonce` is one:
   * asking twice in a row has to work.
   */
  focusChatSearchNonce: number;
  focusChatSearch: () => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;

  projectsPanelOpen: boolean;
  projectsPanelInitId: string | null;
  openProjectsPanel: (projectId?: string) => void;
  closeProjectsPanel: () => void;

  /** Project pre-selected for the next new chat, consumed by HomeScreen. */
  newChatProjectId: string | null;
  /** Bumped every time a new-chat action is triggered; HomeScreen watches this to reset its state. */
  newChatTimestamp: number;
  triggerNewChat: (projectId?: string | null) => void;

  /** Persists the HomeScreen composer text across navigations. */
  homeScreenDraft: string;
  setHomeScreenDraft: (text: string) => void;
  refreshProjects: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshSkillPacks: () => Promise<void>;
  refreshMcpServers: () => Promise<void>;
  refreshMemories: () => Promise<void>;
  refreshChatTagLinks: () => Promise<void>;
  loadChatTags: (chatId: string) => Promise<void>;
  setChatProject: (chatId: string, projectId: string | null) => Promise<void>;
  toggleProjectContext: (chatId: string, enabled: boolean) => Promise<void>;
  toggleKnowledge: (chatId: string, enabled: boolean) => Promise<void>;
  addChatTag: (chatId: string, tagId: string) => Promise<void>;
  removeChatTag: (chatId: string, tagId: string) => Promise<void>;
  toggleChatTagContext: (chatId: string, tagId: string, enabled: boolean) => Promise<void>;

  loadChatZones: (chatId: string) => Promise<void>;
  addPerspectiveZone: (chatId: string, zoneId: string) => Promise<void>;
  removePerspectiveZone: (chatId: string, zoneId: string) => Promise<void>;
  setChatPerspectiveMode: (
    chatId: string,
    mode: "sequential" | "parallel" | null,
  ) => Promise<void>;
}

/** Remove the pending approval for one participant (matched by zoneId; the
 * primary's is the one with no zoneId) from a chat's approval list. */
function dropApproval(
  list: PendingApproval[] | undefined,
  zoneId: string | undefined,
): PendingApproval[] {
  return (list ?? []).filter((a) => a.zoneId !== zoneId);
}

type PendingTool = { index: number; name: string; args: string };

/**
 * Open (or re-label) the pending tool block for a stream index. A start can
 * arrive before the function name is known — providers differ — so a later
 * start fills the name in; an empty name never overwrites a known one.
 */
function upsertToolStart(pending: PendingTool[], index: number, name: string): PendingTool[] {
  if (pending.some((t) => t.index === index)) {
    return pending.map((t) => (t.index === index && name ? { ...t, name } : t));
  }
  return [...pending, { index, name, args: "" }];
}

/**
 * Append streamed argument text to a pending tool block, creating the block if
 * no start was seen for this index. Dropping unmatched deltas used to make the
 * whole argument build-up invisible whenever a provider's opening delta didn't
 * carry a name — the tool call then appeared out of nowhere, fully formed.
 */
function appendToolArgs(pending: PendingTool[], index: number, delta: string): PendingTool[] {
  if (!pending.some((t) => t.index === index)) {
    return [...pending, { index, name: "", args: delta }];
  }
  return pending.map((t) => (t.index === index ? { ...t, args: t.args + delta } : t));
}

function freshStreaming(messageId: string): StreamingState {
  return {
    messageId,
    content: "",
    reasoning: "",
    phase: "thinking",
    pendingTools: [],
    runningTool: null,
    startedAt: Date.now(),
    firstTokenAt: null,
  };
}

export type BackgroundEffect =
  | "none" | "particles" | "orbs" | "aurora" | "grid" | "stars" | "shooting"
  | "waves" | "fireflies" | "boids"
  | "matrix" | "topography" | "puzzle" | "mountains" | "fish";

/**
 * How a translucent surface treats what is behind it:
 *  - `frosted` — blurred and desaturated, the classic frosted pane.
 *  - `clear`   — no blur, so the background effect stays legible through it.
 *  - `tinted`  — frosted, with the accent colour bled into the glass.
 */
export type GlassStyle = "frosted" | "clear" | "tinted";

export interface ThemePrefs {
  mode: "dark" | "light";
  accent: string;
  backgroundEffect: BackgroundEffect;
  effectSpeed: number;
  effectDensity: number;
  effectOpacity: number;
  effectColor: string;
  /**
   * Degrees of hue spread around the effect colour (0 = every element exactly
   * the chosen colour). Elements are fanned across ±this range by index, so a
   * flock or a contour stack reads as a palette rather than one flat tone.
   */
  effectHue?: number;
  bloomEnabled: boolean;
  bloomIntensity: number;
  shadowsEnabled: boolean;
  /**
   * Glass / transparency (0.9.15). Off by default — a translucent UI is a taste,
   * and it only makes sense over something worth seeing, so it pairs with the
   * background effect. `glassStyle` picks how the light behaves; `glassStrength`
   * is how far through it you can see.
   */
  glassEnabled?: boolean;
  glassStyle?: GlassStyle;
  glassStrength?: number;
  /**
   * Per-mode overrides of the base palette (0.9.4). Kept separate for dark and
   * light so a blue background chosen for dark doesn't follow you into light,
   * where it would be unreadable. Any key left out falls back to the stylesheet.
   */
  colorsDark?: Partial<Record<ThemeColorKey, string>>;
  colorsLight?: Partial<Record<ThemeColorKey, string>>;
  /**
   * A stylesheet the user (or a model, over the API) appends to the app's own
   * (0.11.3). Six palette colours and a set of toggles cannot express "make the
   * sidebar narrower" or "square off every corner", and the alternative to a
   * text box is an ever-growing settings panel chasing requests one at a time.
   *
   * It is injected last, so it wins on equal specificity, and it is kept behind
   * `customCssEnabled` so a rule that hides something important can be switched
   * off without first finding it in the text.
   */
  customCss?: string;
  customCssEnabled?: boolean;
}

/**
 * How much custom CSS is allowed. Not a security boundary — the sheet is the
 * user's own and already runs in their window — but a stylesheet this long is a
 * mistake (a paste of the wrong buffer, a model in a loop), and re-parsing it on
 * every theme write is the kind of thing that makes an app feel broken.
 */
export const MAX_CUSTOM_CSS = 100_000;

/** The palette entries a user may override, and the CSS variable each drives. */
export const THEME_COLOR_KEYS = {
  bg: "--color-bg",
  panel: "--color-panel",
  panelHover: "--color-panel-hover",
  border: "--color-border",
  text: "--color-text",
  textMuted: "--color-text-muted",
} as const;

export type ThemeColorKey = keyof typeof THEME_COLOR_KEYS;

const DEFAULT_THEME: ThemePrefs = {
  mode: "dark",
  accent: "#4f9cf9",
  backgroundEffect: "none",
  effectSpeed: 1.0,
  effectDensity: 60,
  effectOpacity: 0.5,
  effectColor: "accent",
  effectHue: 20,
  bloomEnabled: false,
  bloomIntensity: 0.5,
  shadowsEnabled: true,
  glassEnabled: false,
  glassStyle: "frosted",
  glassStrength: 0.5,
  customCss: "",
  customCssEnabled: false,
};

const LEGACY_FONT_SIZE: Record<string, number> = { normal: 14, large: 16, xl: 18 };

/** The webfont `<link>`, found by id rather than held in a variable — `index.html`
 *  may have created it before this module ever ran (see `saveBootSnapshot`). */
const FONT_LINK_ID = "mz-font-link";

function fontLinkEl(): HTMLLinkElement | null {
  return document.getElementById(FONT_LINK_ID) as HTMLLinkElement | null;
}

/**
 * Where the pre-paint restore in `index.html` reads from, and the version tag
 * that lets a future change to the format invalidate every stored copy at once.
 */
const BOOT_SNAPSHOT_KEY = "mz.boot.v1";

/**
 * Cache the appearance decisions currently stamped on `<html>` so the next launch
 * can put them back before it paints.
 *
 * Deliberately dumb: it copies the element's own `style` and `class` rather than
 * the preferences behind them, so it cannot fall out of step with the two
 * functions that write them, and adding a new theme toggle needs nothing here.
 * The user's custom stylesheet is *not* carried — it has to be the last sheet in
 * the document to win, and at boot the app's own stylesheet has not been injected
 * yet, so restoring it early would quietly change which rules apply.
 */
function saveBootSnapshot() {
  try {
    localStorage.setItem(
      BOOT_SNAPSHOT_KEY,
      JSON.stringify({
        cls: document.documentElement.className,
        style: document.documentElement.getAttribute("style") ?? "",
        fontHref: fontLinkEl()?.href ?? "",
      }),
    );
  } catch {
    // Storage full or unavailable. The only cost is the launch flash we used to
    // have unconditionally, so there is nothing to report.
  }
}

/**
 * Layer partial settings over the defaults, nested objects included.
 *
 * A plain spread only fills in *missing top-level keys*, which is wrong for the
 * one field that has structure: a saved `approvals` from before `editAllow`
 * existed replaced the default whole and left those lists `undefined`, so the
 * Chat tab crashed on the first list editor that joined one. Every merge of
 * saved settings goes through here so a field added to `ApprovalPolicy` can
 * never do that again.
 */
/**
 * Layer partial settings over the defaults, later parts winning.
 *
 * `undefined` never wins (0.17.4). `Object.assign` copies an explicit
 * `undefined` over a real value — `{...saved, apiEnabled: undefined}` is *not*
 * `{...saved}` — so any caller writing `{ x: cond ? true : undefined }` to mean
 * "set it, or leave it alone" was silently erasing `x`.
 *
 * That is exactly what happened: turning remote access off wrote
 * `apiEnabled: undefined` and `apiToken: undefined`, which persisted as false
 * and empty, and the API server then refused to start on the next launch with
 * nothing on screen to explain why. Found by reading `/api/health` on a running
 * app and seeing `enabled: false` reported by a bound socket.
 *
 * Dropping undefined here rather than at each call site makes the intuitive
 * reading the true one everywhere, and there is no setting whose meaning is
 * "explicitly undefined".
 */
function mergeAppSettings(...parts: Partial<AppSettings>[]): AppSettings {
  const defined = parts.map((part) =>
    Object.fromEntries(Object.entries(part ?? {}).filter(([, v]) => v !== undefined)),
  );
  const merged = Object.assign({ ...DEFAULT_APP_SETTINGS }, ...defined) as AppSettings;
  merged.approvals = normalizeApprovals(merged.approvals);
  return merged;
}

function applyAppSettingsToDom(settings: AppSettings) {
  const fs = typeof settings.fontSize === "number" ? settings.fontSize : 14;
  document.documentElement.style.setProperty("--font-size-message", `${fs}px`);

  // Interface size rides the root font size, which is what every rem-based
  // Tailwind size in the app resolves against. Linked mode keeps the same ratio
  // the defaults have (16px UI to 14px messages) rather than making them equal.
  const linked = !!settings.fontSizeLinked;
  const ui = linked
    ? Math.round((fs / 14) * 16)
    : typeof settings.uiFontSize === "number"
      ? settings.uiFontSize
      : 16;
  document.documentElement.style.fontSize = `${ui}px`;

  const family = settings.fontFamily?.trim();
  if (family) {
    document.documentElement.style.setProperty("--font-family", `"${family}", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`);
  } else {
    document.documentElement.style.removeProperty("--font-family");
  }

  // The face the app is actually about to render in — the user's choice, or Inter,
  // which the default stack asks for first and no desktop OS ships. Fetching it
  // here rather than only when the user picks something means it is on its way
  // during launch, behind the splash.
  //
  // It was previously fetched *only* for a custom family, so the app ran on the
  // stack's next fallback (Segoe UI on Windows) until something else happened to
  // pull Inter down — and one thing did: opening Settings → Appearance, whose
  // dropdown loads every preset face for its previews, Inter among them. Every
  // piece of text in the app then re-rendered in a different typeface, on a panel
  // where the user had changed nothing.
  const webfont = family || "Inter";
  const encoded = encodeURIComponent(webfont);
  const href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@400;500;600;700&display=swap`;
  let link = fontLinkEl();
  if (!link || link.href !== href) {
    link?.remove();
    link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  saveBootSnapshot();
}

function applyThemeToDom(theme: ThemePrefs) {
  const html = document.documentElement;
  html.classList.toggle("light", theme.mode === "light");
  html.classList.toggle("dark", theme.mode === "dark");
  html.style.colorScheme = theme.mode; // makes native form controls (select, input) match the theme
  html.style.setProperty("--color-accent", theme.accent);
  // Away from the page: lighter on a dark theme, darker on a light one — the
  // direction the two shipped defaults already went. This used to be set to the
  // accent itself, which left every filled button inert under the pointer.
  html.style.setProperty(
    "--color-accent-hover",
    shade(theme.accent, theme.mode === "light" ? -0.14 : 0.14),
  );
  html.classList.toggle("bloom", !!theme.bloomEnabled);
  html.classList.toggle("shadows", !!theme.shadowsEnabled);
  html.style.setProperty("--bloom-intensity", String(theme.bloomIntensity ?? 0.5));

  // Glass: one class for "on", one for which style, and a strength variable the
  // stylesheet derives blur and opacity from.
  const glass = !!theme.glassEnabled;
  html.classList.toggle("glass", glass);
  for (const s of ["frosted", "clear", "tinted"] as const) {
    html.classList.toggle(`glass-${s}`, glass && (theme.glassStyle ?? "frosted") === s);
  }
  html.style.setProperty("--glass-strength", String(theme.glassStrength ?? 0.5));

  // Palette overrides for the mode being shown. Every key is cleared first, so
  // switching modes (or resetting a colour) drops back to the stylesheet value
  // instead of leaving the other mode's inline override in place.
  const overrides = (theme.mode === "light" ? theme.colorsLight : theme.colorsDark) ?? {};
  for (const [key, cssVar] of Object.entries(THEME_COLOR_KEYS)) {
    const value = overrides[key as ThemeColorKey];
    if (value) html.style.setProperty(cssVar, value);
    else html.style.removeProperty(cssVar);
  }
  // The strong border shade is derived rather than exposed — one fewer control
  // for something no one wants to tune independently.
  if (overrides.border) html.style.setProperty("--color-border-strong", overrides.border);
  else html.style.removeProperty("--color-border-strong");

  applyCustomCss(theme);
  saveBootSnapshot();
}

const CUSTOM_CSS_ELEMENT_ID = "multizone-custom-css";

/**
 * Keep the user's stylesheet in one `<style>` element at the end of `<head>`.
 *
 * Last in the document is the point: the app's own rules and Tailwind's
 * utilities are already there, so an equally specific rule written here is the
 * one that applies, and the user does not have to discover `!important` to
 * change a colour. The element is created on first use and its text swapped
 * afterwards — replacing the node would make the browser re-resolve every style
 * in the app on each keystroke in the editor.
 */
function applyCustomCss(theme: ThemePrefs) {
  const css = theme.customCssEnabled ? (theme.customCss ?? "").slice(0, MAX_CUSTOM_CSS) : "";
  let el = document.getElementById(CUSTOM_CSS_ELEMENT_ID) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("style");
    el.id = CUSTOM_CSS_ELEMENT_ID;
    document.head.appendChild(el);
  } else if (el !== document.head.lastElementChild) {
    // A font link injected after it would otherwise sit downstream of the user's
    // rules; move it back to the end.
    document.head.appendChild(el);
  }
  if (el.textContent !== css) el.textContent = css;
}

export const useApp = create<AppStore>((set, get) => ({
  providers: [],
  providersLoaded: false,
  zones: [],
  chats: [],
  projects: [],
  tags: [],
  skills: [],
  savedRuns: [],
  skillPacks: [],
  mcpServers: [],
  memories: [],
  tagsByChat: {},
  chatTagLinks: [],
  chatZonesByChat: {},

  activeChatId: null,
  messagesByChat: {},
  streamingByChat: {},
  perspectiveStreamsByChat: {},
  turnByChat: {},
  perspectiveTurnByChat: {},
  regeneratingTitles: new Set(),
  pendingApprovalByChat: {},
  routingByChat: {},
  errorsByChat: {},
  spendLimitByChat: {},
  pendingImport: null,
  statsByMessage: {},
  checkpointsByChat: {},
  rewindByChat: {},
  theme: DEFAULT_THEME,
  themeLoaded: false,
  appSettings: DEFAULT_APP_SETTINGS,
  appSettingsLoaded: false,

  pendingByChat: {},

  voiceSessionId: null,
  voiceRecording: false,
  voiceError: null,
  voiceInputDevices: [],
  conversationChatId: null,

  settingsOpen: false,
  zonesPanelOpen: false,
  zoneLibraryOpen: false,
  zoneLibraryReturnTo: null,
  zoneLibraryInitialEdit: null,
  settingsInitialTab: null,
  replayChatId: null,
  defaultZoneId: null,
  shortcutsHelpOpen: false,
  sidebarOpen: readSidebarOpen(),
  focusComposerNonce: 0,
  projectsPanelOpen: false,
  projectsPanelInitId: null,
  newChatProjectId: null,
  newChatTimestamp: 0,
  homeScreenDraft: "",

  dismissChatErrors(chatId) {
    set((s) => {
      if (!s.errorsByChat[chatId]) return {};
      const errorsByChat = { ...s.errorsByChat };
      delete errorsByChat[chatId];
      return { errorsByChat };
    });
  },

  stageImport(pending) {
    set({ pendingImport: pending });
  },
  clearImport() {
    set({ pendingImport: null });
  },

  async refreshProviders() {
    const providers = await api.listProviders();
    set({ providers, providersLoaded: true });
  },
  async refreshZones() {
    const zones = await api.listZones();
    set({ zones });

    // One-time cleanup: the retired `web_search` tool kept its provider and key
    // in each zone's `tool_config`. Nothing reads that block any more (the tool
    // is gone; `smart_search` is keyless), so strip it rather than leave an API
    // key sitting in a config the user can no longer see or edit.
    const zonesWithWs = zones.filter((z) => {
      try { return JSON.parse(z.toolConfig)?.web_search != null; } catch { return false; }
    });
    if (zonesWithWs.length === 0) return;

    for (const z of zonesWithWs) {
      try {
        const tc = JSON.parse(z.toolConfig) as Record<string, unknown>;
        delete tc.web_search;
        await api.upsertZone({ ...z, toolConfig: JSON.stringify(tc) });
      } catch { /* skip */ }
    }

    // Reload after cleanup so the store reflects cleaned zones.
    set({ zones: await api.listZones() });
  },
  async refreshChats() {
    const chats = await api.listChats();
    set({ chats });
  },
  pendingJumpMessageId: null,
  async jumpToMessage(chatId, messageId) {
    // Order matters: the flag is set before the switch so a thread that is
    // already mounted for this chat sees it on the same render that the
    // messages arrive, rather than a frame later.
    set({ pendingJumpMessageId: messageId });
    await get().setActiveChat(chatId);
  },
  clearPendingJump() {
    set({ pendingJumpMessageId: null });
  },
  async setActiveChat(id) {
    set({ activeChatId: id });
    if (id) {
      // Always refresh from the DB on entry so the view reflects persisted
      // state (e.g. primary + perspective answers) even if the in-memory cache
      // drifted while streaming in the background. Skip the reload only while a
      // stream is actively writing into this chat, so we don't clobber the
      // in-flight turn that hasn't been saved yet.
      const streamingHere =
        !!get().streamingByChat[id] ||
        Object.keys(get().perspectiveStreamsByChat[id] ?? {}).length > 0;
      if (!streamingHere) await get().loadMessages(id);
      else if (!get().messagesByChat[id]) await get().loadMessages(id);
      if (!get().tagsByChat[id]) await get().loadChatTags(id);
      await get().loadChatZones(id);
    }
  },
  async branchFromMessage(
    chatId,
    messageId,
    solo = false,
    zoneId = null,
    restoreFiles = false,
    scope = "visible",
    standalone = false,
  ) {
    // Rewind first, on the source chat: the checkpoints belong to it, and a
    // branch that failed to be created should not leave a half-restored tree.
    const reports = restoreFiles ? await api.restoreToMessage(chatId, messageId) : [];
    const branch = await api.branchChat(chatId, messageId, solo, zoneId, scope, standalone);
    await get().refreshChats();
    await get().setActiveChat(branch.id);
    // The source chat's revert offers have changed shape — a rewound turn now
    // reads as restored — so its list is no longer what the UI is holding.
    if (restoreFiles) get().loadCheckpoints(chatId).catch(console.error);
    return reports;
  },
  async editMessage(chatId, messageId, text) {
    await api.updateMessage(chatId, messageId, text);
    await get().loadMessages(chatId);
    get().refreshChats().catch(console.error);
  },
  async loadMessages(chatId) {
    const messages = await api.getMessages(chatId);
    set((s) => ({ messagesByChat: { ...s.messagesByChat, [chatId]: messages } }));
    // Opening a chat is also when its revertible turns are read.
    get().loadCheckpoints(chatId).catch(console.error);
  },

  async loadCheckpoints(chatId) {
    const [checkpoints, rewind] = await Promise.all([
      api.listCheckpoints(chatId),
      api.rewindStatus(chatId),
    ]);
    set((s) => ({
      checkpointsByChat: { ...s.checkpointsByChat, [chatId]: checkpoints },
      rewindByChat: { ...s.rewindByChat, [chatId]: rewind },
    }));
  },

  async rewindToMessage(chatId, messageId, force) {
    const report = await api.rewindToMessage(chatId, messageId, force);
    // Re-read rather than patch: the rewind changed what is on disk, which is
    // what decides whether the remaining turns still read as revertible.
    await get().loadCheckpoints(chatId);
    return report;
  },

  async rewindForward(chatId, force) {
    const report = await api.rewindForward(chatId, force);
    await get().loadCheckpoints(chatId);
    return report;
  },

  async revertCheckpoint(chatId, checkpointId, paths, force) {
    const report = await api.restoreCheckpoint(checkpointId, paths, force);
    // Re-read rather than patch: a restore changes what is on disk, which is
    // what decides whether the remaining paths still read as revertible.
    await get().loadCheckpoints(chatId);
    return report;
  },
  applyStreamEvent(chatId, event, perspectiveZoneId) {
    // Tell the user when a run has stopped and is waiting for *them* (0.14.3).
    // Done before the reducers and outside them, because a notification is a
    // side effect and the reducers below must stay pure — and because both of
    // these are the same event whether the primary or a perspective raised it.
    if (get().appSettings.notifyWhenWaiting) {
      if (event.type === "tool_approval_required") {
        const chat = get().chats.find((c) => c.id === chatId);
        void notifyWaiting(
          "Waiting for your approval",
          `${event.name.replace(/_/g, " ")} in ${chat?.title || "a chat"}`,
        );
      } else if (event.type === "tool_call_result" && event.name === "ask_user") {
        const chat = get().chats.find((c) => c.id === chatId);
        void notifyWaiting("A question for you", chat?.title || "A chat is waiting on an answer");
      }
    }

    // Route perspective events to the separate perspective streams map. A
    // perspective runs the same agentic loop as the primary, so it emits the
    // full set of token/tool/approval events — handled here mirroring the
    // primary branch but scoped to this zone's stream.
    if (perspectiveZoneId) {
      set((s) => {
        const now = Date.now();
        const chatPersp = { ...(s.perspectiveStreamsByChat[chatId] ?? {}) };
        const perspectiveStreamsByChat = { ...s.perspectiveStreamsByChat };
        const chatTurns = { ...(s.perspectiveTurnByChat[chatId] ?? {}) };
        const perspectiveTurnByChat = { ...s.perspectiveTurnByChat };
        const messagesByChat = { ...s.messagesByChat };
        const statsByMessage = { ...s.statsByMessage };
        const pendingApprovalByChat = { ...s.pendingApprovalByChat };
        const errorsByChat = { ...s.errorsByChat };
        const spendLimitByChat = { ...s.spendLimitByChat };
        const msgs = messagesByChat[chatId] ?? [];
        const current = chatPersp[perspectiveZoneId];

        // A perspective never sees `user_message_saved` (that's the primary's
        // event), so its turn opens at the first event of its stream and is
        // cleared when the stream ends.
        const terminal =
          event.type === "done" || event.type === "cancelled" || event.type === "error";
        if (!chatTurns[perspectiveZoneId] && !terminal) {
          chatTurns[perspectiveZoneId] = freshTurn(now);
        }
        // Totals span the whole turn, so they're folded in before the
        // per-iteration switch and survive `assistant_saved` clearing the
        // stream — a perspective's timer and token count must not restart on
        // every step of its agentic loop.
        {
          const next = applyTurnEvent(chatTurns[perspectiveZoneId], event, now);
          if (next) chatTurns[perspectiveZoneId] = next;
        }

        switch (event.type) {
          case "assistant_start":
            chatPersp[perspectiveZoneId] = freshStreaming(event.messageId);
            break;
          case "token":
            if (current) {
              chatPersp[perspectiveZoneId] = {
                ...current,
                phase: "answering",
                content: current.content + event.delta,
                firstTokenAt: current.firstTokenAt ?? now,
              };
            }
            break;
          case "thinking_token":
            if (current) {
              chatPersp[perspectiveZoneId] = {
                ...current,
                phase: "thinking",
                reasoning: current.reasoning + event.delta,
                firstTokenAt: current.firstTokenAt ?? now,
              };
            }
            break;
          case "tool_call_start":
            if (current) {
              chatPersp[perspectiveZoneId] = {
                ...current,
                phase: "tool_calling",
                pendingTools: upsertToolStart(current.pendingTools, event.index, event.name),
              };
            }
            break;
          case "tool_call_args_delta":
            if (current) {
              chatPersp[perspectiveZoneId] = {
                ...current,
                phase: "tool_calling",
                pendingTools: appendToolArgs(current.pendingTools, event.index, event.delta),
              };
            }
            break;
          case "tool_approval_required":
            pendingApprovalByChat[chatId] = [
              ...dropApproval(pendingApprovalByChat[chatId], perspectiveZoneId),
              { index: event.index, name: event.name, arguments: event.arguments, diff: event.diff, zoneId: perspectiveZoneId },
            ];
            break;
          case "tool_call_executing":
            if (current) {
              chatPersp[perspectiveZoneId] = { ...current, phase: "tool_running", runningTool: event.name };
            }
            pendingApprovalByChat[chatId] = dropApproval(pendingApprovalByChat[chatId], perspectiveZoneId);
            break;
          case "tool_call_result":
            if (current) {
              chatPersp[perspectiveZoneId] = { ...current, runningTool: null };
            }
            pendingApprovalByChat[chatId] = dropApproval(pendingApprovalByChat[chatId], perspectiveZoneId);
            break;
          case "tool_message_saved":
            messagesByChat[chatId] = [...msgs, event.message];
            break;
          case "assistant_saved":
            messagesByChat[chatId] = [...msgs, event.message];
            // Record generation stats for this perspective response so its block
            // shows the same timing/token readout as the primary answer — read
            // off this zone's turn aggregate, not the last loop iteration.
            if (current) {
              statsByMessage[event.message.id] = statsFromTurn(
                chatTurns[perspectiveZoneId],
                current,
                now,
              );
            }
            delete chatPersp[perspectiveZoneId];
            break;
          case "error":
            // Record before tearing down: this zone produced no message, so the
            // error text is the only thing left to show for its half of the turn.
            errorsByChat[chatId] = [
              ...(errorsByChat[chatId] ?? []).filter((e) => e.zoneId !== perspectiveZoneId),
              { message: event.message, at: now, zoneId: perspectiveZoneId },
            ];
            delete chatPersp[perspectiveZoneId];
            delete chatTurns[perspectiveZoneId];
            pendingApprovalByChat[chatId] = dropApproval(pendingApprovalByChat[chatId], perspectiveZoneId);
            break;
          case "runaway":
            // Named, because in a Multizone run one lane looping while the
            // others work is exactly the case where "which zone?" is the
            // question. The lane stays alive to write its wrap-up.
            errorsByChat[chatId] = [
              ...(errorsByChat[chatId] ?? []),
              { message: event.label, at: now, zoneId: perspectiveZoneId, kind: "runaway" },
            ];
            break;
          case "spend_limit":
            // The limit is the session's, so whichever lane reaches it first
            // stops the whole thing — the notice belongs to the chat, not to
            // this zone's column, and every other lane is about to stop too.
            spendLimitByChat[chatId] = {
              spent: event.spent,
              cap: event.cap,
              midTurn: event.midTurn,
              at: now,
            };
            break;
          case "done":
          case "cancelled":
            delete chatPersp[perspectiveZoneId];
            delete chatTurns[perspectiveZoneId];
            pendingApprovalByChat[chatId] = dropApproval(pendingApprovalByChat[chatId], perspectiveZoneId);
            break;
        }

        perspectiveStreamsByChat[chatId] = chatPersp;
        perspectiveTurnByChat[chatId] = chatTurns;
        return {
          perspectiveStreamsByChat,
          perspectiveTurnByChat,
          messagesByChat,
          statsByMessage,
          pendingApprovalByChat,
          errorsByChat,
          spendLimitByChat,
        };
      });
      return;
    }

    set((s) => {
      const now = Date.now();
      const msgs = s.messagesByChat[chatId] ?? [];
      const streaming = { ...s.streamingByChat };
      const messagesByChat = { ...s.messagesByChat };
      const statsByMessage = { ...s.statsByMessage };
      const turnByChat = { ...s.turnByChat };
      const perspectiveTurnByChat = { ...s.perspectiveTurnByChat };
      const pendingApprovalByChat = { ...s.pendingApprovalByChat };
      const routingByChat = { ...s.routingByChat };
      const errorsByChat = { ...s.errorsByChat };
      const pendingByChat = { ...s.pendingByChat };
      const spendLimitByChat = { ...s.spendLimitByChat };
      const current = streaming[chatId];

      /** Drop queued-message chips the backend says are no longer pending. */
      const dropPending = (ids: string[]) => {
        const rest = (pendingByChat[chatId] ?? []).filter((p) => !ids.includes(p.id));
        if (rest.length === 0) delete pendingByChat[chatId];
        else pendingByChat[chatId] = rest;
      };

      // Turn totals span every iteration of the agentic loop — same reducer the
      // perspective branch uses, so the two can't drift apart.
      {
        const next = applyTurnEvent(turnByChat[chatId], event, now);
        if (next) turnByChat[chatId] = next;
      }

      switch (event.type) {
        case "routing_started":
          routingByChat[chatId] = { status: "routing" };
          break;

        case "routing_done":
          routingByChat[chatId] = { status: "done", zoneId: event.zoneId, zoneName: event.zoneName };
          break;

        case "user_message_saved":
          messagesByChat[chatId] = [...msgs, event.message];
          // Clear any previous routing indicator — new turn is starting.
          routingByChat[chatId] = null;
          // The user just kicked off a new turn — reset turn-level totals so
          // the live banner starts at zero, not from the previous turn. The
          // perspective zones' totals go with it: they're cleared when each
          // stream ends, but a stream that died without a final event would
          // otherwise carry its numbers into this turn.
          turnByChat[chatId] = freshTurn(now);
          delete perspectiveTurnByChat[chatId];
          // Last turn's failures belong to last turn.
          delete errorsByChat[chatId];
          break;

        case "assistant_start":
          streaming[chatId] = freshStreaming(event.messageId);
          // Fall-back: if a regenerate flow kicked off without a preceding
          // user_message_saved event, seed the turn aggregate here so the
          // banner still has something to display.
          if (!turnByChat[chatId]) turnByChat[chatId] = freshTurn(now);
          break;

        case "token":
          if (current) {
            streaming[chatId] = {
              ...current,
              phase: "answering",
              content: current.content + event.delta,
              firstTokenAt: current.firstTokenAt ?? now,
            };
          }
          break;

        case "thinking_token":
          if (current) {
            streaming[chatId] = {
              ...current,
              phase: "thinking",
              reasoning: current.reasoning + event.delta,
              firstTokenAt: current.firstTokenAt ?? now,
            };
          }
          break;

        case "tool_call_start":
          if (current) {
            streaming[chatId] = {
              ...current,
              phase: "tool_calling",
              pendingTools: upsertToolStart(current.pendingTools, event.index, event.name),
            };
          }
          break;

        case "tool_call_args_delta":
          if (current) {
            streaming[chatId] = {
              ...current,
              phase: "tool_calling",
              pendingTools: appendToolArgs(current.pendingTools, event.index, event.delta),
            };
          }
          break;

        case "tool_approval_required":
          pendingApprovalByChat[chatId] = [
            ...dropApproval(pendingApprovalByChat[chatId], undefined),
            { index: event.index, name: event.name, arguments: event.arguments, diff: event.diff },
          ];
          break;

        case "tool_call_executing":
          if (current) {
            streaming[chatId] = {
              ...current,
              phase: "tool_running",
              runningTool: event.name,
            };
          }
          // Clear the primary's approval banner — the tool is now executing.
          pendingApprovalByChat[chatId] = dropApproval(pendingApprovalByChat[chatId], undefined);
          break;

        case "tool_call_result":
          if (current) {
            streaming[chatId] = { ...current, runningTool: null };
          }
          // Also clear any lingering approval state (e.g. denied tool).
          pendingApprovalByChat[chatId] = dropApproval(pendingApprovalByChat[chatId], undefined);
          break;

        case "tool_message_saved":
          messagesByChat[chatId] = [...msgs, event.message];
          break;

        // A message the user queued mid-turn reached the model. It joins the
        // thread like any other user message, but deliberately does *not* reset
        // the turn aggregate the way `user_message_saved` does — the turn it
        // landed in is still the one being timed.
        case "steer_delivered":
          messagesByChat[chatId] = [...msgs, event.message];
          dropPending([event.id]);
          break;

        case "pending_cleared":
          dropPending(event.ids);
          break;

        case "assistant_saved":
          messagesByChat[chatId] = [...msgs, event.message];
          // Stats come from the turn aggregate (which spans every iteration of
          // the agentic loop), not just this last assistant message —
          // otherwise a multi-step turn only counts the final step.
          if (current) {
            statsByMessage[event.message.id] = statsFromTurn(turnByChat[chatId], current, now);
          }
          delete streaming[chatId];
          break;

        case "error":
          // The turn failed before an assistant message was ever saved, so
          // without this the whole exchange would render as empty space.
          errorsByChat[chatId] = [
            ...(errorsByChat[chatId] ?? []).filter((e) => e.zoneId !== undefined),
            { message: event.message, at: now },
          ];
          delete streaming[chatId];
          delete turnByChat[chatId];
          routingByChat[chatId] = null;
          pendingApprovalByChat[chatId] = dropApproval(pendingApprovalByChat[chatId], undefined);
          break;

        case "runaway":
          // Deliberately does *not* tear the stream down: the backend gives the
          // model one more tool-free step to explain itself, and that answer is
          // the useful part. This only puts the reason on screen while the
          // repeated calls are still visible above it.
          errorsByChat[chatId] = [
            ...(errorsByChat[chatId] ?? []),
            { message: event.label, at: now, kind: "runaway" },
          ];
          break;

        case "spend_limit":
          // Not an error and not a completion — a decision waiting on the user.
          // Held per chat rather than pushed into `errorsByChat` because it has
          // actions attached and must not be dismissable into oblivion: the run
          // really is stopped until someone answers it.
          spendLimitByChat[chatId] = {
            spent: event.spent,
            cap: event.cap,
            midTurn: event.midTurn,
            at: now,
          };
          break;

        case "done":
        case "cancelled":
          delete streaming[chatId];
          delete turnByChat[chatId];
          // Only clear the primary's approval; perspective zones may still be
          // mid-stream with their own pending approvals.
          pendingApprovalByChat[chatId] = dropApproval(pendingApprovalByChat[chatId], undefined);
          break;
      }
      return {
        messagesByChat,
        streamingByChat: streaming,
        statsByMessage,
        turnByChat,
        perspectiveTurnByChat,
        pendingApprovalByChat,
        routingByChat,
        errorsByChat,
        pendingByChat,
        spendLimitByChat,
      };
    });

    // A finished turn may have changed files. Re-read what is revertible
    // rather than inferring it: whether a path has diverged is a fact about
    // the disk, and the tool results alone don't say.
    if (event.type === "done") {
      get().loadCheckpoints(chatId).catch(console.error);
    }

    // ── Auto-titling the chat's opening turn ──────────────────────────────
    //
    // Only the chat's very first turn: one user message, nothing answered yet.
    // A branched chat starts with history, so this correctly skips it.
    const isOpeningTurn = () => {
      const msgs = get().messagesByChat[chatId] ?? [];
      return (
        msgs.filter((m) => m.role === "user").length === 1 &&
        msgs.filter((m) => m.role === "assistant" && !m.zoneId).length === 0
      );
    };

    // Deriving the title from the user's own text costs no provider call, so it
    // can land the moment the message is saved.
    if (event.type === "user_message_saved" && !get().appSettings.autoTitle) {
      const msgs = get().messagesByChat[chatId] ?? [];
      const firstUserMsg = msgs.find((m) => m.role === "user");
      if (isOpeningTurn() && firstUserMsg) {
        try {
          const parts = JSON.parse(firstUserMsg.content) as { type: string; text?: string }[];
          const text = parts
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text!)
            .join(" ")
            .trim();
          // A chat opened with only a screenshot has no text here, and this
          // used to rename it to the empty string — a sidebar row with an icon
          // and nothing beside it. Name the attachment instead.
          const images = parts.filter(
            (p) => p.type === "image_url" || p.type === "hidden_image",
          ).length;
          const title = text
            ? text.length > 80
              ? text.slice(0, 77) + "…"
              : text
            : images === 1
              ? "Image"
              : images > 1
                ? `${images} Images`
                : "";
          // Never rename to nothing: leaving "New Chat" is worse than a good
          // title and better than a blank row.
          if (title) {
            api.renameChat(chatId, title).catch(console.error);
            get().setChatTitle(chatId, title);
            get().refreshChats().catch(console.error);
          }
        } catch { /* ignore parse errors */ }
      }
    }

    // The generated title is a second call to the same endpoint, so *when* it
    // goes out decides which request the provider serves first. It used to fire
    // on `user_message_saved` — which the backend emits before it has dispatched
    // the completion — so against a provider that serves one request at a time
    // (Ollama, LM Studio, llama.cpp) the title took the slot and the answer
    // queued behind it: a title appeared, then a wait for the reply actually
    // asked for.
    //
    // Waiting for the answer's first streamed content proves that request is
    // already being served. The title still goes out concurrently and usually
    // lands while the answer is still streaming — it just can no longer overtake
    // it.
    const generating =
      event.type === "token" ||
      event.type === "thinking_token" ||
      event.type === "tool_call_start";
    if (
      generating &&
      get().appSettings.autoTitle &&
      !autoTitledChats.has(chatId) &&
      !get().regeneratingTitles.has(chatId) &&
      isOpeningTurn()
    ) {
      // Claim it before awaiting: every token of the opening turn passes through
      // here, and `regeneratingTitles` isn't set until the call starts.
      autoTitledChats.add(chatId);
      get().regenerateTitle(chatId).catch((e) => {
        autoTitledChats.delete(chatId);
        console.error(e);
      });
    }
  },
  setChatTitle(chatId, title) {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, title } : c)),
    }));
  },
  async setChatZone(chatId, zoneId) {
    await api.setChatZone(chatId, zoneId);
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, zoneId, smartRouting: false } : c,
      ),
    }));
  },
  pendingPlanByChat: {},
  planTreeByChat: {},
  async loadPlanTree(chatId) {
    try {
      const plans = await api.planTree(chatId);
      set((s) => ({ planTreeByChat: { ...s.planTreeByChat, [chatId]: plans } }));
    } catch (e) {
      console.warn("failed to load the plan tree", e);
    }
  },
  async setPlanSteps(chatId, planId, steps) {
    const updated = await api.updatePlanSteps(planId, steps);
    set((s) => ({
      planTreeByChat: {
        ...s.planTreeByChat,
        [chatId]: (s.planTreeByChat[chatId] ?? []).map((p) => (p.id === planId ? updated : p)),
      },
    }));
  },
  async requestPlanStop(chatId, planId) {
    await api.requestPlanStop(planId);
    set((s) => ({
      planTreeByChat: {
        ...s.planTreeByChat,
        [chatId]: (s.planTreeByChat[chatId] ?? []).map((p) =>
          p.id === planId ? { ...p, stopRequested: true } : p,
        ),
      },
    }));
  },
  // No UI caller since 0.12.1: entering plan mode is the model's move
  // (`enter_plan_mode`) and leaving it is approving or rejecting the plan. Kept
  // as the frontend half of the command behind `POST /api/chats/:id/plan-mode`,
  // so a script or a model driving the app can still set the mode directly.
  async setChatPlanMode(chatId, on) {
    await api.setChatPlanMode(chatId, on);
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, planMode: on } : c)),
    }));
  },
  async loadPendingPlan(chatId) {
    try {
      const plan = await api.pendingPlan(chatId);
      set((s) => ({ pendingPlanByChat: { ...s.pendingPlanByChat, [chatId]: plan } }));
    } catch (e) {
      console.warn("failed to load the pending plan", e);
    }
  },
  async approvePlan(chatId, planId, steps, edited) {
    await api.approvePlan(planId, steps, edited);
    // Approving is what clears plan mode (the backend does it in the same
    // transaction); mirror it here so the composer stops saying "planning"
    // before the chat list next refreshes.
    set((s) => ({
      pendingPlanByChat: { ...s.pendingPlanByChat, [chatId]: null },
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, planMode: false } : c)),
    }));
  },
  async rejectPlan(chatId, planId) {
    await api.rejectPlan(planId);
    set((s) => ({
      pendingPlanByChat: { ...s.pendingPlanByChat, [chatId]: null },
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, planMode: true } : c)),
    }));
  },
  async setChatSmart(chatId, smart) {
    await api.setChatSmart(chatId, smart);
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId
          ? { ...c, smartRouting: smart, zoneId: smart ? null : c.zoneId }
          : c,
      ),
    }));
  },
  async regenerateTitle(chatId, wholeConversation = false) {
    set((s) => {
      const next = new Set(s.regeneratingTitles);
      next.add(chatId);
      return { regeneratingTitles: next };
    });
    try {
      const title = await api.generateTitle(chatId, wholeConversation);
      get().setChatTitle(chatId, title);
    } finally {
      set((s) => {
        const next = new Set(s.regeneratingTitles);
        next.delete(chatId);
        return { regeneratingTitles: next };
      });
    }
  },
  async raiseSpendLimit(chatId, newCap) {
    // This chat's session, not everyone's (0.14.4). Lifting a ceiling to let
    // *this* piece of work finish is a statement about this piece of work; the
    // global setting stays the default for chats that have not said otherwise.
    await api.setChatSpendLimit(chatId, Math.max(0, Math.round(newCap)));
    await get().refreshChats();
    set((s) => {
      const spendLimitByChat = { ...s.spendLimitByChat };
      delete spendLimitByChat[chatId];
      return { spendLimitByChat };
    });
    // Resume where it stopped. The user's message is already in the transcript
    // with nothing answering it — a stopped turn never wrote one — so this
    // continues the run rather than re-asking, which is what "raise it and carry
    // on" has to mean if the limit is to be usable rather than merely correct.
    await api.regenerateResponse(chatId);
  },

  async respondApproval(chatId, zoneId, approved, hunks) {
    set((s) => ({
      pendingApprovalByChat: {
        ...s.pendingApprovalByChat,
        [chatId]: dropApproval(s.pendingApprovalByChat[chatId], zoneId),
      },
    }));
    // Answered, so stop the window asking for attention — but only once nothing
    // else is waiting, or clearing one approval would un-flag a panel with six
    // more outstanding.
    if (!Object.values(get().pendingApprovalByChat).some((l) => l?.length)) {
      void clearAttention();
    }
    await api.respondToolApproval(chatId, zoneId ?? null, approved, hunks);
  },
  async setTheme(partial) {
    // Same rule as `setAppSettings`: a theme write is a whole-object write, so
    // doing one before the saved theme has been read replaces it with defaults.
    if (!get().themeLoaded) {
      throw new Error("the saved theme has not been read yet, so nothing was changed");
    }
    const next = { ...get().theme, ...partial };
    set({ theme: next });
    applyThemeToDom(next);
    try {
      await api.setSetting("theme", JSON.stringify(next));
    } catch (e) {
      console.warn("failed to persist theme", e);
    }
  },
  async loadThemeFromBackend() {
    try {
      const raw = await api.getSetting("theme");
      if (raw) {
        const parsed = JSON.parse(raw) as ThemePrefs;
        const merged = { ...DEFAULT_THEME, ...parsed };
        set({ theme: merged, themeLoaded: true });
        applyThemeToDom(merged);
        return;
      }
      // No row yet — the defaults on screen are the truth, and writing them is
      // safe from here on.
      set({ themeLoaded: true });
    } catch (e) {
      // Left *unloaded* on purpose: a read that failed says nothing about what
      // is stored, and `setTheme` refuses rather than overwriting it blind.
      console.warn("failed to load theme", e);
    }
    applyThemeToDom(DEFAULT_THEME);
  },
  async loadAppSettings() {
    try {
      const raw = await api.getSetting("app_settings");
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings> & { fontSize?: any };
        const merged = mergeAppSettings(parsed);
        // Migrate legacy string fontSize values
        if (typeof merged.fontSize === "string") {
          merged.fontSize = LEGACY_FONT_SIZE[merged.fontSize as string] ?? 14;
        }
        // The web-search provider settings (`webSearchProvider` / `Endpoint` /
        // `ApiKey`) were dropped at 1.0 along with the single-provider
        // `web_search` tool. Stored copies are harmless — the spread above only
        // keeps keys that exist in DEFAULT_APP_SETTINGS-shaped reads — so no
        // migration is needed beyond letting them fall out of use.
        set({ appSettings: merged });
        applyAppSettingsToDom(merged);
      } else {
        // Nothing saved yet. The defaults still have to be written to the DOM:
        // a stale boot snapshot from a previous install (or a reset) would
        // otherwise keep sizing the interface until the first settings write.
        applyAppSettingsToDom(DEFAULT_APP_SETTINGS);
      }
      set({ appSettingsLoaded: true });
    } catch (e) {
      // Left unloaded on purpose (0.17.5). `appSettingsLoaded` is read as "it
      // is safe to write" — by the seeding passes in App as well as by
      // `setAppSettings` — and a read that failed says nothing about what is
      // stored. Marking it loaded after a failure is how defaults get written
      // over a real settings row.
      console.warn("failed to load app settings", e);
    }
  },
  async setAppSettings(partial) {
    // Merge against what is actually on disk, not against in-memory state.
    // Before loadAppSettings() resolves, `appSettings` is still DEFAULT_APP_SETTINGS,
    // so an early partial write (e.g. the web_search migration in refreshZones) used
    // to persist those defaults over every saved field — silently wiping maps like
    // `visionOverrides`, which made vision-capable models fall back to the name
    // heuristic until the user toggled the override off and on again.
    let saved: Partial<AppSettings> = {};
    try {
      const raw = await api.getSetting("app_settings");
      if (raw) saved = JSON.parse(raw) as Partial<AppSettings>;
    } catch (e) {
      // A failed re-read used to fall back to in-memory state unconditionally,
      // which is only safe once the load has actually happened. Before that,
      // in-memory state *is* DEFAULT_APP_SETTINGS, and writing it back is not a
      // no-op — it is an erase. That is how a phone whose settings read was
      // failing (0.17.5, an envelope the transport did not unwrap) wiped
      // dictation, appearance and every smaller preference off the desktop.
      //
      // So: refuse. There is nothing safe to merge against, and a preference
      // that did not save is a far smaller problem than a preference file
      // replaced by its defaults.
      if (!get().appSettingsLoaded) {
        throw new Error(
          "settings could not be read back, so nothing was changed — " +
            (e instanceof Error ? e.message : String(e)),
        );
      }
      console.warn("failed to re-read app settings before write", e);
      saved = get().appSettings;
    }
    // Only layer in-memory state on top once it genuinely reflects the load;
    // pre-load it is just DEFAULT_APP_SETTINGS and would re-clobber `saved`.
    const inMemory = get().appSettingsLoaded ? get().appSettings : {};
    const next = mergeAppSettings(saved, inMemory, partial);
    set({ appSettings: next });
    applyAppSettingsToDom(next);
    try {
      await api.setSetting("app_settings", JSON.stringify(next));
    } catch (e) {
      console.warn("failed to persist app settings", e);
    }
  },

  async queuePendingMessage(chatId, text, mode) {
    const id = crypto.randomUUID();
    // The id is minted here and passed down so the chip this adds and the
    // `steer_delivered` / `pending_cleared` event that removes it agree on which
    // message they mean.
    const { running } = await api.queueChatMessage(chatId, id, text, mode);
    if (!running) return false;
    set((s) => ({
      pendingByChat: {
        ...s.pendingByChat,
        [chatId]: [...(s.pendingByChat[chatId] ?? []), { id, text, mode }],
      },
    }));
    return true;
  },
  async cancelPendingMessage(chatId, id) {
    await api.cancelPendingMessage(chatId, id).catch(console.error);
    set((s) => {
      const rest = (s.pendingByChat[chatId] ?? []).filter((p) => p.id !== id);
      const next = { ...s.pendingByChat };
      if (rest.length === 0) delete next[chatId];
      else next[chatId] = rest;
      return { pendingByChat: next };
    });
  },

  async startDictation() {
    set({ voiceError: null });
    try {
      const deviceName = get().appSettings.sttInputDevice;
      const sessionId = await dictation.start(deviceName);
      set({ voiceSessionId: sessionId, voiceRecording: true });
    } catch (e) {
      set({ voiceError: String(e) });
      throw e;
    }
  },
  async stopDictation() {
    const sessionId = get().voiceSessionId;
    set({ voiceSessionId: null, voiceRecording: false });
    if (!sessionId) return "";
    try {
      return await dictation.stop(sessionId);
    } catch (e) {
      set({ voiceError: String(e) });
      throw e;
    }
  },
  async cancelDictation() {
    const sessionId = get().voiceSessionId;
    set({ voiceSessionId: null, voiceRecording: false });
    if (!sessionId) return;
    try {
      await dictation.cancel(sessionId);
    } catch (e) {
      console.warn("failed to cancel dictation", e);
    }
  },
  setConversationChatId(id) {
    set({ conversationChatId: id });
  },
  async refreshVoiceInputDevices() {
    try {
      const voiceInputDevices = await api.listVoiceInputDevices();
      set({ voiceInputDevices });
    } catch (e) {
      console.warn("failed to list voice input devices", e);
    }
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openReplay: (chatId) => set({ replayChatId: chatId }),
  closeReplay: () => set({ replayChatId: null }),
  // Editing a zone is the library panel opened on its editor, not a panel of
  // its own — see `zoneLibraryInitialEdit` for why there is only one now.
  openZoneEditor: (id, returnTo) =>
    set({
      zoneLibraryOpen: true,
      zoneLibraryReturnTo: returnTo ?? null,
      zoneLibraryInitialEdit: { zoneId: id },
      settingsOpen: returnTo === "settings" ? false : get().settingsOpen,
    }),
  openZonesPanel: () => set({ zonesPanelOpen: true }),
  closeZonesPanel: () => set({ zonesPanelOpen: false }),
  // Opening the library from Settings closes Settings rather than stacking a
  // second modal over it: two overlays deep, Escape becomes ambiguous and the
  // backdrop click closes the wrong one. The breadcrumb is kept in
  // `zoneLibraryReturnTo` instead, and the library's back button walks it.
  openZoneLibrary: (returnTo) =>
    set({
      zoneLibraryOpen: true,
      zoneLibraryReturnTo: returnTo ?? null,
      zoneLibraryInitialEdit: null,
      settingsOpen: returnTo === "settings" ? false : get().settingsOpen,
    }),
  closeZoneLibrary: () =>
    set({ zoneLibraryOpen: false, zoneLibraryReturnTo: null, zoneLibraryInitialEdit: null }),
  returnFromZoneLibrary: () => {
    const back = get().zoneLibraryReturnTo;
    set({
      zoneLibraryOpen: false,
      zoneLibraryReturnTo: null,
      zoneLibraryInitialEdit: null,
      settingsOpen: back === "settings",
      settingsInitialTab: back === "settings" ? "zones" : get().settingsInitialTab,
    });
  },
  openShortcutsHelp: () => set({ shortcutsHelpOpen: true }),
  closeShortcutsHelp: () => set({ shortcutsHelpOpen: false }),
  setSidebarOpen: (open) => {
    writeSidebarOpen(open);
    set({ sidebarOpen: open });
  },
  toggleSidebar: () => {
    const next = !get().sidebarOpen;
    writeSidebarOpen(next);
    set({ sidebarOpen: next });
  },
  focusComposer: () => set((s) => ({ focusComposerNonce: s.focusComposerNonce + 1 })),
  composerDraft: { text: "", nonce: 0, mode: "replace" },
  setComposerDraft: (text, mode = "replace") =>
    set((s) => ({ composerDraft: { text, mode, nonce: s.composerDraft.nonce + 1 } })),
  async refreshSavedRuns() {
    set({ savedRuns: await api.listSavedRuns() });
  },
  commandPaletteOpen: false,
  focusChatSearchNonce: 0,
  focusChatSearch: () => set((st) => ({ sidebarOpen: true, focusChatSearchNonce: st.focusChatSearchNonce + 1 })),
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  async setDefaultZone(id) {
    set({ defaultZoneId: id });
    try {
      await api.setSetting("default_zone_id", id ?? "");
    } catch (e) {
      console.warn("failed to persist default zone", e);
    }
  },
  async loadDefaultZone() {
    try {
      const raw = await api.getSetting("default_zone_id");
      if (raw) set({ defaultZoneId: raw });
    } catch (e) {
      console.warn("failed to load default zone", e);
    }
  },

  openProjectsPanel: (projectId?: string) => set({ projectsPanelOpen: true, projectsPanelInitId: projectId ?? null }),
  closeProjectsPanel: () => set({ projectsPanelOpen: false, projectsPanelInitId: null }),
  triggerNewChat: (projectId) => set((s) => ({
    newChatProjectId: projectId ?? null,
    newChatTimestamp: s.newChatTimestamp + 1,
  })),
  setHomeScreenDraft: (text) => set({ homeScreenDraft: text }),

  async refreshProjects() {
    const projects = await api.listProjects();
    set({ projects });
  },
  async refreshTags() {
    const tags = await api.listTags();
    set({ tags });
    get().refreshChatTagLinks().catch(console.error);
  },
  async refreshSkills() {
    const skills = await api.listSkills();
    set({ skills });
  },
  async refreshSkillPacks() {
    try {
      set({ skillPacks: await api.listSkillPacks() });
    } catch (e) {
      // A missing or unreadable root is not an error worth blocking Settings on.
      console.warn("failed to scan skill folders", e);
      set({ skillPacks: [] });
    }
  },
  async refreshMcpServers() {
    const mcpServers = await api.listMcpServers();
    set({ mcpServers });
  },
  async refreshMemories() {
    const memories = await api.listMemories();
    set({ memories });
  },
  async refreshChatTagLinks() {
    const chatTagLinks = await api.getAllChatTags();
    set({ chatTagLinks });
  },
  async loadChatTags(chatId) {
    const entries = await api.getChatTags(chatId);
    set((s) => ({ tagsByChat: { ...s.tagsByChat, [chatId]: entries } }));
  },
  async setChatProject(chatId, projectId) {
    await api.setChatProject(chatId, projectId);
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, projectId } : c)),
    }));
  },
  async toggleProjectContext(chatId, enabled) {
    await api.setChatProjectContext(chatId, enabled);
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, projectContextEnabled: enabled } : c,
      ),
    }));
  },
  async toggleKnowledge(chatId, enabled) {
    await api.setChatKnowledge(chatId, enabled);
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, knowledgeEnabled: enabled } : c,
      ),
    }));
  },
  async addChatTag(chatId, tagId) {
    await api.addChatTag(chatId, tagId);
    await get().loadChatTags(chatId);
    get().refreshChatTagLinks().catch(console.error);
  },
  async removeChatTag(chatId, tagId) {
    await api.removeChatTag(chatId, tagId);
    set((s) => ({
      tagsByChat: {
        ...s.tagsByChat,
        [chatId]: (s.tagsByChat[chatId] ?? []).filter((t) => t.tagId !== tagId),
      },
      chatTagLinks: s.chatTagLinks.filter((l) => !(l.chatId === chatId && l.tagId === tagId)),
    }));
  },
  async toggleChatTagContext(chatId, tagId, enabled) {
    await api.setChatTagContext(chatId, tagId, enabled);
    set((s) => ({
      tagsByChat: {
        ...s.tagsByChat,
        [chatId]: (s.tagsByChat[chatId] ?? []).map((t) =>
          t.tagId === tagId ? { ...t, contextEnabled: enabled } : t,
        ),
      },
    }));
  },

  async loadChatZones(chatId) {
    const zones = await api.getChatZones(chatId);
    set((s) => ({ chatZonesByChat: { ...s.chatZonesByChat, [chatId]: zones } }));
  },
  async addPerspectiveZone(chatId, zoneId) {
    await api.addPerspectiveZone(chatId, zoneId);
    await get().loadChatZones(chatId);
  },
  async removePerspectiveZone(chatId, zoneId) {
    await api.removePerspectiveZone(chatId, zoneId);
    set((s) => ({
      chatZonesByChat: {
        ...s.chatZonesByChat,
        [chatId]: (s.chatZonesByChat[chatId] ?? []).filter((z) => z.zoneId !== zoneId),
      },
    }));
  },
  async setChatPerspectiveMode(chatId, mode) {
    await api.setChatPerspectiveMode(chatId, mode);
    set((s) => ({
      chats: s.chats.map((c) =>
        c.id === chatId ? { ...c, perspectiveMode: mode } : c,
      ),
    }));
  },
}));

/**
 * The DOM follows the store, always.
 *
 * Both writers of these two slices already stamp their change on `<html>`
 * themselves, so this is a backstop rather than the mechanism — but it is the
 * reason the appearance can no longer be *out* of step with the settings: the
 * interface font size used to arrive late, and looked to the user like it took
 * opening Settings → Appearance to be honoured at all. Any path that reaches the
 * state (a load, a write from the HTTP API, an imported bundle) now repaints,
 * whether or not it remembered to. Outside React, so a colour dragged across its
 * slider does not re-render the app on every frame.
 */
useApp.subscribe((state, prev) => {
  if (state.appSettings !== prev.appSettings) applyAppSettingsToDom(state.appSettings);
  if (state.theme !== prev.theme) applyThemeToDom(state.theme);
});
