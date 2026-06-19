import { create } from "zustand";
import { DEFAULT_APP_SETTINGS, type AppSettings, type Chat, type ChatTagEntry, type ChatZone, type Message, type Project, type Provider, type Tag, type Zone } from "@/lib/types";
import * as api from "@/lib/tauri";

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
}

export interface PendingApproval {
  index: number;
  name: string;
  arguments: string;
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
  tagsByChat: Record<string, ChatTagEntry[]>;
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
  /** Chat IDs whose title is currently being regenerated. */
  regeneratingTitles: Set<string>;
  /** Pending tool approval per chat: chatId → approval info, or absent when none pending. */
  pendingApprovalByChat: Record<string, PendingApproval>;
  /** Smart routing state per chat. null = idle, "routing" = LLM call in progress, done = zone was resolved. */
  routingByChat: Record<string, { status: "routing" } | { status: "done"; zoneId: string; zoneName: string } | null>;
  /** Per-message generation stats, keyed by message id. */
  statsByMessage: Record<string, MessageStats>;
  /** Current visual theme. Persisted via the backend settings table. */
  theme: ThemePrefs;
  setTheme: (theme: Partial<ThemePrefs>) => Promise<void>;
  loadThemeFromBackend: () => Promise<void>;

  appSettings: AppSettings;
  /** True once app settings have been read from the backend (gates seeding). */
  appSettingsLoaded: boolean;
  loadAppSettings: () => Promise<void>;
  setAppSettings: (partial: Partial<AppSettings>) => Promise<void>;

  // ui
  settingsOpen: boolean;
  zoneEditorOpen: boolean;
  editingZoneId: string | null;
  zonesPanelOpen: boolean;
  defaultZoneId: string | null;

  // actions
  refreshProviders: () => Promise<void>;
  refreshZones: () => Promise<void>;
  refreshChats: () => Promise<void>;
  setActiveChat: (id: string | null) => Promise<void>;
  loadMessages: (chatId: string) => Promise<void>;
  applyStreamEvent: (chatId: string, event: import("@/lib/types").StreamEvent, perspectiveZoneId?: string) => void;
  setChatTitle: (chatId: string, title: string) => void;
  setChatZone: (chatId: string, zoneId: string | null) => Promise<void>;
  setChatSmart: (chatId: string, smart: boolean) => Promise<void>;
  regenerateTitle: (chatId: string) => Promise<void>;
  respondApproval: (chatId: string, approved: boolean) => Promise<void>;

  openSettings: () => void;
  closeSettings: () => void;
  openZoneEditor: (id: string | null) => void;
  closeZoneEditor: () => void;
  openZonesPanel: () => void;
  closeZonesPanel: () => void;
  setDefaultZone: (id: string | null) => Promise<void>;
  loadDefaultZone: () => Promise<void>;

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
  loadChatTags: (chatId: string) => Promise<void>;
  setChatProject: (chatId: string, projectId: string | null) => Promise<void>;
  toggleProjectContext: (chatId: string, enabled: boolean) => Promise<void>;
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

export type BackgroundEffect = "none" | "particles" | "orbs" | "aurora" | "grid" | "stars" | "shooting" | "waves" | "fireflies" | "boids";

export interface ThemePrefs {
  mode: "dark" | "light";
  accent: string;
  backgroundEffect: BackgroundEffect;
  effectSpeed: number;
  effectDensity: number;
  effectOpacity: number;
  effectColor: string;
  bloomEnabled: boolean;
  bloomIntensity: number;
  shadowsEnabled: boolean;
}

const DEFAULT_THEME: ThemePrefs = {
  mode: "dark",
  accent: "#4f9cf9",
  backgroundEffect: "none",
  effectSpeed: 1.0,
  effectDensity: 60,
  effectOpacity: 0.5,
  effectColor: "accent",
  bloomEnabled: false,
  bloomIntensity: 0.5,
  shadowsEnabled: true,
};

const LEGACY_FONT_SIZE: Record<string, number> = { normal: 14, large: 16, xl: 18 };

let fontLinkEl: HTMLLinkElement | null = null;

function applyAppSettingsToDom(settings: AppSettings) {
  const fs = typeof settings.fontSize === "number" ? settings.fontSize : 14;
  document.documentElement.style.setProperty("--font-size-message", `${fs}px`);

  const family = settings.fontFamily?.trim();
  if (family) {
    document.documentElement.style.setProperty("--font-family", `"${family}", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`);
    // Inject Google Fonts link if not already present for this family
    const encoded = encodeURIComponent(family);
    const href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@400;500;600;700&display=swap`;
    if (!fontLinkEl || fontLinkEl.href !== href) {
      fontLinkEl?.remove();
      fontLinkEl = document.createElement("link");
      fontLinkEl.rel = "stylesheet";
      fontLinkEl.href = href;
      document.head.appendChild(fontLinkEl);
    }
  } else {
    document.documentElement.style.removeProperty("--font-family");
    fontLinkEl?.remove();
    fontLinkEl = null;
  }
}

function applyThemeToDom(theme: ThemePrefs) {
  const html = document.documentElement;
  html.classList.toggle("light", theme.mode === "light");
  html.classList.toggle("dark", theme.mode === "dark");
  html.style.setProperty("--color-accent", theme.accent);
  html.style.setProperty("--color-accent-hover", theme.accent);
  html.classList.toggle("bloom", !!theme.bloomEnabled);
  html.classList.toggle("shadows", !!theme.shadowsEnabled);
  html.style.setProperty("--bloom-intensity", String(theme.bloomIntensity ?? 0.5));
}

export const useApp = create<AppStore>((set, get) => ({
  providers: [],
  providersLoaded: false,
  zones: [],
  chats: [],
  projects: [],
  tags: [],
  tagsByChat: {},
  chatZonesByChat: {},

  activeChatId: null,
  messagesByChat: {},
  streamingByChat: {},
  perspectiveStreamsByChat: {},
  turnByChat: {},
  regeneratingTitles: new Set(),
  pendingApprovalByChat: {},
  routingByChat: {},
  statsByMessage: {},
  theme: DEFAULT_THEME,
  appSettings: DEFAULT_APP_SETTINGS,
  appSettingsLoaded: false,

  settingsOpen: false,
  zoneEditorOpen: false,
  editingZoneId: null,
  zonesPanelOpen: false,
  defaultZoneId: null,
  projectsPanelOpen: false,
  projectsPanelInitId: null,
  newChatProjectId: null,
  newChatTimestamp: 0,
  homeScreenDraft: "",

  async refreshProviders() {
    const providers = await api.listProviders();
    set({ providers, providersLoaded: true });
  },
  async refreshZones() {
    const zones = await api.listZones();
    set({ zones });

    // One-time migration: move web_search config from per-zone tool_config to global app settings.
    const zonesWithWs = zones.filter((z) => {
      try { return JSON.parse(z.toolConfig)?.web_search != null; } catch { return false; }
    });
    if (zonesWithWs.length === 0) return;

    // Promote first non-default zone config to global settings (only if user hasn't configured it yet).
    // Read directly from DB — do NOT use get().appSettings which may not be loaded yet at startup.
    let savedSettings: Partial<AppSettings> = {};
    try {
      const raw = await api.getSetting("app_settings");
      if (raw) savedSettings = JSON.parse(raw) as Partial<AppSettings>;
    } catch { /* ignore */ }
    const current = { ...DEFAULT_APP_SETTINGS, ...savedSettings };
    if (current.webSearchProvider === "multi" && !current.webSearchEndpoint && !current.webSearchApiKey) {
      const firstWs = (JSON.parse(zonesWithWs[0].toolConfig) as Record<string, any>)?.web_search ?? {};
      if (firstWs.provider !== "multi" || firstWs.endpoint || firstWs.api_key) {
        await get().setAppSettings({
          webSearchProvider: firstWs.provider ?? "multi",
          webSearchEndpoint: firstWs.endpoint ?? "",
          webSearchApiKey: firstWs.api_key ?? "",
        });
      }
    }

    // Strip web_search from every zone's tool_config.
    for (const z of zonesWithWs) {
      try {
        const tc = JSON.parse(z.toolConfig) as Record<string, unknown>;
        delete tc.web_search;
        await api.upsertZone({ ...z, toolConfig: JSON.stringify(tc) });
      } catch { /* skip */ }
    }

    // Reload after migration so the store reflects cleaned zones.
    set({ zones: await api.listZones() });
  },
  async refreshChats() {
    const chats = await api.listChats();
    set({ chats });
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
  async loadMessages(chatId) {
    const messages = await api.getMessages(chatId);
    set((s) => ({ messagesByChat: { ...s.messagesByChat, [chatId]: messages } }));
  },
  applyStreamEvent(chatId, event, perspectiveZoneId) {
    // Route perspective events to the separate perspective streams map.
    if (perspectiveZoneId) {
      set((s) => {
        const chatPersp = { ...(s.perspectiveStreamsByChat[chatId] ?? {}) };
        const perspectiveStreamsByChat = { ...s.perspectiveStreamsByChat };
        const messagesByChat = { ...s.messagesByChat };
        const statsByMessage = { ...s.statsByMessage };
        const msgs = messagesByChat[chatId] ?? [];
        const current = chatPersp[perspectiveZoneId];

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
                firstTokenAt: current.firstTokenAt ?? Date.now(),
              };
            }
            break;
          case "thinking_token":
            if (current) {
              chatPersp[perspectiveZoneId] = {
                ...current,
                phase: "thinking",
                reasoning: current.reasoning + event.delta,
                firstTokenAt: current.firstTokenAt ?? Date.now(),
              };
            }
            break;
          case "assistant_saved":
            messagesByChat[chatId] = [...msgs, event.message];
            // Record generation stats for this perspective response so its block
            // shows the same timing/token readout as the primary answer.
            if (current) {
              const now = Date.now();
              const start = current.firstTokenAt ?? current.startedAt;
              statsByMessage[event.message.id] = {
                durationMs: now - start,
                timeToFirstTokenMs:
                  current.firstTokenAt !== null
                    ? current.firstTokenAt - current.startedAt
                    : null,
                contentChars: current.content.length,
                reasoningChars: current.reasoning.length,
              };
            }
            delete chatPersp[perspectiveZoneId];
            break;
          case "done":
          case "cancelled":
          case "error":
            delete chatPersp[perspectiveZoneId];
            break;
        }

        perspectiveStreamsByChat[chatId] = chatPersp;
        return { perspectiveStreamsByChat, messagesByChat, statsByMessage };
      });
      return;
    }

    set((s) => {
      const msgs = s.messagesByChat[chatId] ?? [];
      const streaming = { ...s.streamingByChat };
      const messagesByChat = { ...s.messagesByChat };
      const statsByMessage = { ...s.statsByMessage };
      const turnByChat = { ...s.turnByChat };
      const pendingApprovalByChat = { ...s.pendingApprovalByChat };
      const routingByChat = { ...s.routingByChat };
      const current = streaming[chatId];

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
          // the live banner starts at zero, not from the previous turn.
          turnByChat[chatId] = {
            startedAt: Date.now(),
            firstTokenAt: null,
            contentChars: 0,
            reasoningChars: 0,
            toolCallChars: 0,
          };
          break;

        case "assistant_start":
          streaming[chatId] = freshStreaming(event.messageId);
          // Fall-back: if a regenerate flow kicked off without a preceding
          // user_message_saved event, seed the turn aggregate here so the
          // banner still has something to display.
          if (!turnByChat[chatId]) {
            turnByChat[chatId] = {
              startedAt: Date.now(),
              firstTokenAt: null,
              contentChars: 0,
              reasoningChars: 0,
              toolCallChars: 0,
            };
          }
          break;

        case "token":
          if (current) {
            const now = Date.now();
            streaming[chatId] = {
              ...current,
              phase: "answering",
              content: current.content + event.delta,
              firstTokenAt: current.firstTokenAt ?? now,
            };
            const t = turnByChat[chatId];
            if (t) {
              turnByChat[chatId] = {
                ...t,
                firstTokenAt: t.firstTokenAt ?? now,
                contentChars: t.contentChars + event.delta.length,
              };
            }
          }
          break;

        case "thinking_token":
          if (current) {
            const now = Date.now();
            streaming[chatId] = {
              ...current,
              phase: "thinking",
              reasoning: current.reasoning + event.delta,
              firstTokenAt: current.firstTokenAt ?? now,
            };
            const t = turnByChat[chatId];
            if (t) {
              turnByChat[chatId] = {
                ...t,
                firstTokenAt: t.firstTokenAt ?? now,
                reasoningChars: t.reasoningChars + event.delta.length,
              };
            }
          }
          break;

        case "tool_call_start":
          if (current) {
            const exists = current.pendingTools.some((t) => t.index === event.index);
            streaming[chatId] = {
              ...current,
              phase: "tool_calling",
              pendingTools: exists
                ? current.pendingTools.map((t) =>
                    t.index === event.index ? { ...t, name: event.name } : t,
                  )
                : [
                    ...current.pendingTools,
                    { index: event.index, name: event.name, args: "" },
                  ],
            };
          }
          break;

        case "tool_call_args_delta":
          if (current) {
            streaming[chatId] = {
              ...current,
              phase: "tool_calling",
              pendingTools: current.pendingTools.map((t) =>
                t.index === event.index ? { ...t, args: t.args + event.delta } : t,
              ),
            };
            const tca = turnByChat[chatId];
            if (tca) {
              turnByChat[chatId] = {
                ...tca,
                toolCallChars: tca.toolCallChars + event.delta.length,
              };
            }
          }
          break;

        case "tool_approval_required":
          pendingApprovalByChat[chatId] = {
            index: event.index,
            name: event.name,
            arguments: event.arguments,
          };
          break;

        case "tool_call_executing":
          if (current) {
            streaming[chatId] = {
              ...current,
              phase: "tool_running",
              runningTool: event.name,
            };
          }
          // Clear approval banner — the tool is now actually executing.
          delete pendingApprovalByChat[chatId];
          break;

        case "tool_call_result":
          if (current) {
            streaming[chatId] = { ...current, runningTool: null };
          }
          // Also clear any lingering approval state (e.g. denied tool).
          delete pendingApprovalByChat[chatId];
          break;

        case "tool_message_saved":
          messagesByChat[chatId] = [...msgs, event.message];
          break;

        case "assistant_saved":
          messagesByChat[chatId] = [...msgs, event.message];
          if (current) {
            const now = Date.now();
            // Duration measures generation time, not network wait. If we
            // somehow saved without a first-token event (no streaming
            // tokens at all), fall back to total time so we don't show 0.
            const start = current.firstTokenAt ?? current.startedAt;
            statsByMessage[event.message.id] = {
              durationMs: now - start,
              timeToFirstTokenMs:
                current.firstTokenAt !== null
                  ? current.firstTokenAt - current.startedAt
                  : null,
              contentChars: current.content.length,
              reasoningChars: current.reasoning.length,
            };
          }
          delete streaming[chatId];
          break;

        case "done":
        case "cancelled":
        case "error":
          delete streaming[chatId];
          delete turnByChat[chatId];
          delete pendingApprovalByChat[chatId];
          break;
      }
      return {
        messagesByChat,
        streamingByChat: streaming,
        statsByMessage,
        turnByChat,
        pendingApprovalByChat,
        routingByChat,
      };
    });

    // After the first assistant response completes, set the chat title.
    if (event.type === "done") {
      const msgs = get().messagesByChat[chatId] ?? [];
      const assistantCount = msgs.filter((m) => m.role === "assistant").length;
      if (assistantCount === 1 && !get().regeneratingTitles.has(chatId)) {
        if (get().appSettings.autoTitle) {
          get().regenerateTitle(chatId).catch(console.error);
        } else {
          // Use the user's first message text as the title; set empty when no text.
          const firstUserMsg = msgs.find((m) => m.role === "user");
          if (firstUserMsg) {
            try {
              const parts = JSON.parse(firstUserMsg.content) as { type: string; text?: string }[];
              const text = parts
                .filter((p) => p.type === "text" && p.text)
                .map((p) => p.text!)
                .join(" ")
                .trim();
              const title = text.length > 80 ? text.slice(0, 77) + "…" : text;
              api.renameChat(chatId, title).catch(console.error);
              get().setChatTitle(chatId, title);
              get().refreshChats().catch(console.error);
            } catch { /* ignore parse errors */ }
          }
        }
      }
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
  async regenerateTitle(chatId) {
    set((s) => {
      const next = new Set(s.regeneratingTitles);
      next.add(chatId);
      return { regeneratingTitles: next };
    });
    try {
      const title = await api.generateTitle(chatId);
      get().setChatTitle(chatId, title);
    } finally {
      set((s) => {
        const next = new Set(s.regeneratingTitles);
        next.delete(chatId);
        return { regeneratingTitles: next };
      });
    }
  },
  async respondApproval(chatId, approved) {
    set((s) => {
      const next = { ...s.pendingApprovalByChat };
      delete next[chatId];
      return { pendingApprovalByChat: next };
    });
    await api.respondToolApproval(chatId, approved);
  },
  async setTheme(partial) {
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
        set({ theme: merged });
        applyThemeToDom(merged);
        return;
      }
    } catch (e) {
      console.warn("failed to load theme", e);
    }
    applyThemeToDom(DEFAULT_THEME);
  },
  async loadAppSettings() {
    try {
      const raw = await api.getSetting("app_settings");
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings> & { fontSize?: any };
        const merged = { ...DEFAULT_APP_SETTINGS, ...parsed };
        // Migrate legacy string fontSize values
        if (typeof merged.fontSize === "string") {
          merged.fontSize = LEGACY_FONT_SIZE[merged.fontSize as string] ?? 14;
        }
        set({ appSettings: merged });
        applyAppSettingsToDom(merged);
      }
    } catch (e) {
      console.warn("failed to load app settings", e);
    } finally {
      set({ appSettingsLoaded: true });
    }
  },
  async setAppSettings(partial) {
    const next = { ...get().appSettings, ...partial };
    set({ appSettings: next });
    applyAppSettingsToDom(next);
    try {
      await api.setSetting("app_settings", JSON.stringify(next));
    } catch (e) {
      console.warn("failed to persist app settings", e);
    }
  },
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openZoneEditor: (id) => set({ zoneEditorOpen: true, editingZoneId: id }),
  closeZoneEditor: () => set({ zoneEditorOpen: false, editingZoneId: null }),
  openZonesPanel: () => set({ zonesPanelOpen: true }),
  closeZonesPanel: () => set({ zonesPanelOpen: false }),
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
  async addChatTag(chatId, tagId) {
    await api.addChatTag(chatId, tagId);
    await get().loadChatTags(chatId);
  },
  async removeChatTag(chatId, tagId) {
    await api.removeChatTag(chatId, tagId);
    set((s) => ({
      tagsByChat: {
        ...s.tagsByChat,
        [chatId]: (s.tagsByChat[chatId] ?? []).filter((t) => t.tagId !== tagId),
      },
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
