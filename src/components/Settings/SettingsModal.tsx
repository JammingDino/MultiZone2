import { Bell, Bot, ShieldCheck, Server, Smartphone, Palette, MessageSquare, Database, Globe, Brain, Sparkles, Plug, Library, Layers, Mic, Volume2, CalendarClock } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { Modal, ModalTitle } from "@/components/common/Modal";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { NavGroup, NavItem, NavRail } from "@/components/common/NavRail";
import { ApiTab } from "./tabs/ApiTab";
import { AppearanceTab } from "./tabs/AppearanceTab";
import { AgentsTab, ApprovalsTab, ChatTab } from "./tabs/ChatTab";
import { DataTab } from "./tabs/DataTab";
import { KnowledgeTab } from "./tabs/KnowledgeTab";
import { McpTab } from "./tabs/McpTab";
import { MemoryTab } from "./tabs/MemoryTab";
import { NotificationsTab } from "./tabs/NotificationsTab";
import { ProvidersTab } from "./tabs/ProvidersTab";
import { RemoteTab } from "./tabs/RemoteTab";
import { SchedulesTab } from "./tabs/SchedulesTab";
import { SkillsTab } from "./tabs/SkillsTab";
import { SpeechTab } from "./tabs/SpeechTab";
import { VoiceTab } from "./tabs/VoiceTab";
import { ZoneLibrary } from "@/components/Zones/ZoneLibrary";

type Tab = "providers" | "zones" | "appearance" | "chat" | "notifications" | "agents" | "approvals" | "schedules" | "voice" | "speech" | "skills" | "mcp" | "knowledge" | "memory" | "remote" | "api" | "data";

const TAB_IDS: Tab[] = ["providers", "zones", "appearance", "chat", "notifications", "agents", "approvals", "schedules", "voice", "speech", "skills", "mcp", "knowledge", "memory", "remote", "api", "data"];

/** The nav label for each tab, reused when a tab fails to render so the message
 * names the screen the user actually clicked. */
const TAB_LABELS: Record<Tab, string> = {
  providers: "Providers", zones: "Zones", appearance: "Appearance", chat: "Chat", notifications: "Notifications", agents: "Runs", approvals: "Approvals", schedules: "Schedules",
  voice: "Dictation", speech: "Speech", skills: "Skills", mcp: "MCP",
  knowledge: "Knowledge", memory: "Memory", remote: "Phone & remote", api: "API", data: "Data",
};

function isTab(v: string | null): v is Tab {
  return !!v && (TAB_IDS as string[]).includes(v);
}

/**
 * Settings that cannot be saved say so, once, at the top.
 *
 * Both loads are all-or-nothing: the store holds a whole settings object and a
 * whole theme, and writes replace them. When a read has failed — an unreachable
 * desktop, a transport that could not make sense of the answer — the store
 * refuses to write rather than persisting its defaults over whatever is really
 * stored. That refusal is right and completely invisible, so it gets a line.
 */
function UnsavableWarning() {
  const settingsLoaded = useApp((s) => s.appSettingsLoaded);
  const themeLoaded = useApp((s) => s.themeLoaded);
  if (settingsLoaded && themeLoaded) return null;
  return (
    <div className="shrink-0 border-b border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-2 text-xs">
      Your saved settings could not be read
      {settingsLoaded !== themeLoaded ? " in full" : ""}, so changes here will not
      stick — nothing is written over what is stored until the read succeeds. If
      this is a phone, check that it can still reach your computer.
    </div>
  );
}

export function SettingsModal() {
  const closeSettings = useApp((s) => s.closeSettings);
  // In the store, so "edit this zone" from anywhere can land on Zones.
  const stored = useApp((s) => s.settingsTab);
  const tab: Tab = isTab(stored) ? stored : "providers";
  const setTab = useApp((s) => s.setSettingsTab);
  const zonesNonce = useApp((s) => s.zoneLibraryNonce);

  // The one rail, with the Zones page's own items nested under "Zones" while
  // it is open (0.18.1). Configure Zones used to be a second panel with a
  // second rail, and moving between the two changed the whole left side.
  const rail = (zoneItems?: React.ReactNode) => (
    <NavRail>
      <NavGroup label="Models" />
      <NavItem active={tab === "providers"} icon={<Server size={14} />} label="Providers" onClick={() => setTab("providers")} />
      <NavItem active={tab === "zones"} icon={<Layers size={14} />} label="Zones" onClick={() => setTab("zones")} />
      {zoneItems}

      <NavGroup label="Interface" />
      <NavItem active={tab === "appearance"} icon={<Palette size={14} />} label="Appearance" onClick={() => setTab("appearance")} />
      <NavItem active={tab === "chat"} icon={<MessageSquare size={14} />} label="Chat" onClick={() => setTab("chat")} />
      <NavItem active={tab === "notifications"} icon={<Bell size={14} />} label="Notifications" onClick={() => setTab("notifications")} />
      <NavItem active={tab === "voice"} icon={<Mic size={14} />} label="Dictation" onClick={() => setTab("voice")} />
      <NavItem active={tab === "speech"} icon={<Volume2 size={14} />} label="Speech" onClick={() => setTab("speech")} />

      <NavGroup label="Agents" />
      <NavItem active={tab === "agents"} icon={<Bot size={14} />} label="Runs" onClick={() => setTab("agents")} />
      <NavItem active={tab === "approvals"} icon={<ShieldCheck size={14} />} label="Approvals" onClick={() => setTab("approvals")} />
      <NavItem active={tab === "schedules"} icon={<CalendarClock size={14} />} label="Schedules" onClick={() => setTab("schedules")} />

      <NavGroup label="Tools & context" />
      <NavItem active={tab === "skills"} icon={<Sparkles size={14} />} label="Skills" onClick={() => setTab("skills")} />
      <NavItem active={tab === "knowledge"} icon={<Library size={14} />} label="Knowledge" onClick={() => setTab("knowledge")} />
      <NavItem active={tab === "memory"} icon={<Brain size={14} />} label="Memory" onClick={() => setTab("memory")} />
      <NavItem active={tab === "mcp"} icon={<Plug size={14} />} label="MCP" onClick={() => setTab("mcp")} />

      <NavGroup label="System" />
      {/* Its own tab above API (0.17.3): someone connecting a phone is not
          thinking about REST, even though the two share a socket. */}
      <NavItem active={tab === "remote"} icon={<Smartphone size={14} />} label="Phone & remote" onClick={() => setTab("remote")} />
      <NavItem active={tab === "api"} icon={<Globe size={14} />} label="API" onClick={() => setTab("api")} />
      <NavItem active={tab === "data"} icon={<Database size={14} />} label="Data" onClick={() => setTab("data")} />
    </NavRail>
  );

  return (
    <Modal onClose={closeSettings} header={<ModalTitle>Settings</ModalTitle>}>
      <UnsavableWarning />
      <style>{`.input { width: 100%; border: 1px solid var(--color-border); border-radius: 4px; padding: 8px 12px; background: var(--color-panel); font-size: 13px; outline: none; } .input:focus { border-color: var(--color-accent); }`}</style>
        {/* A left rail of tabs is 176px the phone does not have (0.17.3). On a
            narrow screen the same buttons become one horizontally scrolling
            strip along the top — the tab list is the one part of Settings that
            has to stay reachable from every panel, and a strip keeps it visible
            without a second navigation concept to learn. */}
        <div className="flex flex-1 overflow-hidden narrow:flex-col">
          {tab === "zones" ? (
            // The Zones page draws the rail itself, so its list can sit under
            // "Zones" in it; keyed so each "open zones" request starts fresh.
            <ErrorBoundary label="Zones settings" resetKey={zonesNonce}>
              <ZoneLibrary key={zonesNonce} rail={rail} />
            </ErrorBoundary>
          ) : (
          <>
          {rail()}
          {/* `items-start`: a flex row stretches its child to the scroller's
              own height, which put the page's bottom padding at the bottom
              of the view instead of after the last section. */}
          <div className="flex flex-1 items-start overflow-y-auto p-5">
            {/* Per tab, and remounted when the tab changes: one screen that
                throws is one screen, not the window. The bottom padding keeps
                the last section off the panel's edge. */}
            <ErrorBoundary label={`${TAB_LABELS[tab]} settings`} resetKey={tab}>
              <div className="min-w-0 flex-1 pb-10">
                {tab === "providers" && <ProvidersTab />}
                {tab === "appearance" && <AppearanceTab />}
                {tab === "chat" && <ChatTab />}
                {tab === "notifications" && <NotificationsTab />}
                {tab === "agents" && <AgentsTab />}
                {tab === "approvals" && <ApprovalsTab />}
                {tab === "schedules" && <SchedulesTab />}
                {tab === "voice" && <VoiceTab />}
                {tab === "speech" && <SpeechTab />}
                {tab === "skills" && <SkillsTab />}
                {tab === "mcp" && <McpTab />}
                {tab === "knowledge" && <KnowledgeTab />}
                {tab === "memory" && <MemoryTab />}
                {tab === "remote" && <RemoteTab />}
                {tab === "api" && <ApiTab />}
                {tab === "data" && <DataTab />}
              </div>
            </ErrorBoundary>
          </div>
          </>
          )}
        </div>
    </Modal>
  );
}

// ─── Zones ────────────────────────────────────────────────────────────────────
