import { useEffect, useRef, useState } from "react";
import { X, Plus, Trash2, RefreshCw, Server, Smartphone, Palette, MessageSquare, Database, AlertTriangle, Loader2, Folder, FolderOpen, Globe, Copy, Check, Brain, Sparkles, FileUp, FileDown, Plug, Wifi, WifiOff, Library, Layers, ChevronDown, ChevronRight, Mic, Volume2, AudioLines, Stethoscope, ExternalLink, Download, Search } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import type { BackgroundEffect, GlassStyle, ThemeColorKey } from "@/store/app";
import { MAX_CUSTOM_CSS, THEME_COLOR_KEYS } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { VisionOverrideSelect } from "@/components/common/VisionOverrideSelect";
import { Modal, ModalTitle } from "@/components/common/Modal";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { HexColorField } from "@/components/common/ColorPicker";
import { UpdateSection } from "@/components/Settings/UpdateSection";
import { RemoteAccess } from "@/components/Settings/RemoteAccess";
import { isRemote } from "@/lib/remote/transport";
import { Toggle, ToggleRow } from "@/components/common/Toggle";
import { PrivacyStatementLink } from "@/components/common/PrivacyStatement";
import { InstalledZones, useZoneActions } from "@/components/Zones/InstalledZones";
import { getVersion } from "@tauri-apps/api/app";
import { saveTextFile } from "@/lib/saveFile";
import { resolveBaseProvider } from "@/lib/baseZone";
import { PROVIDER_PRESETS, presetForBaseUrl, type ProviderPreset } from "@/lib/providerPresets";
import {
  DEFAULT_EXPORT_SELECTION,
  type ExportSelection,
  buildSettingsBundle,
  bundleCounts,
  describeCounts,
  serializeSettingsBundle,
} from "@/lib/settingsBundle";
import { pickBundleFile } from "@/lib/importSettings";
import { type SkillSeed, serializeSkill, parseSkill } from "@/lib/skillFile";
import type { ApiBindState, ApprovalCategory, ApprovalPolicy, CheckpointUsage, ConnectorCatalog, ConnectorEntry, ConnectorField, DbStats, GlobalKbView, IndexSummary, KbDocument, LifetimeUsage, McpDiagnosis, McpServerView, McpTool, Provider, Skill, SkillPack } from "@/lib/types";
import { formatBytes, formatCount, formatTokens } from "@/lib/format";
import { PRIMARY_ACTION } from "@/lib/chrome";

type Tab = "providers" | "zones" | "appearance" | "chat" | "voice" | "speech" | "skills" | "mcp" | "knowledge" | "memory" | "remote" | "api" | "data";

const TAB_IDS: Tab[] = ["providers", "zones", "appearance", "chat", "voice", "speech", "skills", "mcp", "knowledge", "memory", "remote", "api", "data"];

/** The nav label for each tab, reused when a tab fails to render so the message
 * names the screen the user actually clicked. */
const TAB_LABELS: Record<Tab, string> = {
  providers: "Providers", zones: "Zones", appearance: "Appearance", chat: "Chat",
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
  // Something outside Settings can say which tab to land on — the zone
  // library's back button does, so returning lands on Zones rather than
  // dumping the user back at Providers with no sense of where they were.
  const initialTab = useApp((s) => s.settingsInitialTab);
  const [tab, setTab] = useState<Tab>(isTab(initialTab) ? initialTab : "providers");

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
          <nav className="flex w-44 flex-col gap-0.5 overflow-y-auto border-r border-[var(--color-border)] p-2 text-sm narrow:w-full narrow:flex-none narrow:flex-row narrow:overflow-x-auto narrow:overflow-y-hidden narrow:border-r-0 narrow:border-b">
            <NavGroup label="Models" />
            <TabButton active={tab === "providers"} icon={<Server size={14} />} label="Providers" onClick={() => setTab("providers")} />
            <TabButton active={tab === "zones"} icon={<Layers size={14} />} label="Zones" onClick={() => setTab("zones")} />

            <NavGroup label="Interface" />
            <TabButton active={tab === "appearance"} icon={<Palette size={14} />} label="Appearance" onClick={() => setTab("appearance")} />
            <TabButton active={tab === "chat"} icon={<MessageSquare size={14} />} label="Chat" onClick={() => setTab("chat")} />
            <TabButton active={tab === "voice"} icon={<Mic size={14} />} label="Dictation" onClick={() => setTab("voice")} />
            <TabButton active={tab === "speech"} icon={<Volume2 size={14} />} label="Speech" onClick={() => setTab("speech")} />

            <NavGroup label="Tools & context" />
            <TabButton active={tab === "skills"} icon={<Sparkles size={14} />} label="Skills" onClick={() => setTab("skills")} />
            <TabButton active={tab === "knowledge"} icon={<Library size={14} />} label="Knowledge" onClick={() => setTab("knowledge")} />
            <TabButton active={tab === "memory"} icon={<Brain size={14} />} label="Memory" onClick={() => setTab("memory")} />
            <TabButton active={tab === "mcp"} icon={<Plug size={14} />} label="MCP" onClick={() => setTab("mcp")} />

            <NavGroup label="System" />
            {/* Above API, and its own tab (0.17.3). It was a section inside the
                API panel, which is where it was *built* rather than where
                anybody would look for it: someone connecting a phone is not
                thinking about REST, and the two have different audiences even
                though they share a socket. */}
            <TabButton active={tab === "remote"} icon={<Smartphone size={14} />} label="Phone & remote" onClick={() => setTab("remote")} />
            <TabButton active={tab === "api"} icon={<Globe size={14} />} label="API" onClick={() => setTab("api")} />
            <TabButton active={tab === "data"} icon={<Database size={14} />} label="Data" onClick={() => setTab("data")} />
          </nav>
          <div className="flex flex-1 overflow-y-auto p-4">
            {/* Per tab, and remounted when the tab changes: one screen that
                throws is one screen, not the window. */}
            <ErrorBoundary label={`${TAB_LABELS[tab]} settings`} resetKey={tab}>
              <div className="min-w-0 flex-1">
                {tab === "providers" && <ProvidersTab />}
                {tab === "zones" && <ZonesTab />}
                {tab === "appearance" && <AppearanceTab />}
                {tab === "chat" && <ChatTab />}
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
        </div>
    </Modal>
  );
}

/** A heading in the tab rail. Hidden when the rail becomes a horizontal strip:
 *  a group label in a scrolling row of tabs reads as another tab. */
function NavGroup({ label }: { label: string }) {
  return (
    <div className="mt-3 px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] first:mt-0 narrow:hidden">
      {label}
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded px-2 py-1.5 text-left narrow:shrink-0 narrow:whitespace-nowrap narrow:px-3 narrow:py-2 ${
        active ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Zones ────────────────────────────────────────────────────────────────────

/**
 * Settings → Zones. Zones are configured in the Configure Zones panel (the zone
 * library), which is a whole screen of its own rather than something that fits
 * in a settings pane — so this tab is the door to it, plus the list of what is
 * installed so the door is worth opening from here at all.
 *
 * That list is the same component the Configure Zones rail uses (0.12.4). It
 * used to be a second, plainer one written here — same zones, same action, two
 * looks — which is exactly the kind of split that makes an app feel like
 * several apps. Opening a zone lands in the same editor from either side too:
 * `openZoneEditor` goes through Configure Zones wherever it is called from.
 *
 * Both destinations close Settings and leave a breadcrumb (`returnTo`) instead
 * of stacking a second modal on top of it: the panel that opens shows a "Back
 * to settings" button that lands the user back on this tab.
 */
function ZonesTab() {
  const zones = useApp((s) => s.zones);
  const openZoneLibrary = useApp((s) => s.openZoneLibrary);
  const openZoneEditor = useApp((s) => s.openZoneEditor);
  const zoneActions = useZoneActions({ onEdit: (id) => openZoneEditor(id, "settings") });

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Zones</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => openZoneEditor(null, "settings")}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Plus size={12} /> New zone
          </button>
          <button
            onClick={() => openZoneLibrary("settings")}
            className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Layers size={12} /> Configure Zones
          </button>
        </div>
      </div>

      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        A zone is an assistant with its own model, prompt and tools.
      </p>

      {zones.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-text-muted)]">
          No zones yet.{" "}
          <button onClick={() => openZoneLibrary("settings")} className="text-[var(--color-accent)] hover:underline">
            Browse the library
          </button>{" "}
          or create one.
        </div>
      ) : (
        <>
          <div className="px-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Installed · {zones.length}
          </div>
          <InstalledZones
            actions={zoneActions}
            onOpen={(id) => openZoneEditor(id, "settings")}
          />
          {zoneActions.menuElement}
        </>
      )}
    </>
  );
}

// ─── Providers ────────────────────────────────────────────────────────────────

function ProvidersTab() {
  const { providers, refreshProviders } = useApp(
    useShallow((s) => ({ providers: s.providers, refreshProviders: s.refreshProviders })),
  );
  const zones = useApp((s) => s.zones);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");

  // There is no separate "default provider" setting (0.9.9) — the base zone in
  // Settings → Chat names one, and that is the provider everything falls back
  // to. Shown here so the Providers list still says which one that is.
  const baseProvider = resolveBaseProvider(providers, zones, baseZoneId);

  // A list of a dozen endpoints is a list you scroll rather than read, and the
  // editor used to open above it — so clicking the ninth provider scrolled the
  // one you wanted off the top. Rows are one line each and open in place, and a
  // filter appears once there are enough of them to be worth filtering.
  const q = filter.trim().toLowerCase();
  const shown = q
    ? providers.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.baseUrl.toLowerCase().includes(q) ||
          (p.defaultModel ?? "").toLowerCase().includes(q),
      )
    : providers;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Providers</h3>
        <button
          onClick={() => { setOpenId(null); setAdding(true); }}
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> Add provider
        </button>
      </div>

      {providers.length > 5 && (
        <div className="relative mb-2">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"
          />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter providers"
            className="input !pl-7 text-xs"
          />
        </div>
      )}

      {adding && (
        <ProviderForm
          value={{ name: "", baseUrl: "", apiKey: "" }}
          onClose={() => setAdding(false)}
          onDeleted={async () => { await refreshProviders(); setAdding(false); }}
        />
      )}

      <div className="flex flex-col gap-1">
        {shown.map((p) => {
          const open = openId === p.id;
          return (
            <div
              key={p.id}
              className={`rounded border bg-[var(--color-bg)] ${
                open ? "border-[var(--color-accent)]" : "border-[var(--color-border)]"
              }`}
            >
              <button
                onClick={() => setOpenId(open ? null : p.id)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:text-[var(--color-accent)]"
              >
                <ChevronRight
                  size={12}
                  className={`shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-90" : ""}`}
                />
                <span className="shrink-0 font-medium">{p.name}</span>
                <span className="truncate text-xs text-[var(--color-text-muted)]">{p.baseUrl}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--color-text-muted)]">
                  {p.defaultModel || ""}
                </span>
              </button>
              {open && (
                <div className="border-t border-[var(--color-border)] p-3">
                  <ProviderForm
                    value={p}
                    onClose={() => setOpenId(null)}
                    onDeleted={async () => { await refreshProviders(); setOpenId(null); }}
                  />
                </div>
              )}
            </div>
          );
        })}
        {providers.length === 0 && !adding && (
          <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-text-muted)]">
            No providers yet. Add one to get started.
          </div>
        )}
        {providers.length > 0 && shown.length === 0 && (
          <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
            Nothing matches “{filter}”.
          </div>
        )}
      </div>

      {baseProvider && (
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          Everything falls back to <span className="font-medium text-[var(--color-text)]">{baseProvider.name}</span>,
          the provider behind your base zone (Settings → Chat).
        </p>
      )}
    </>
  );
}

// ─── Appearance ───────────────────────────────────────────────────────────────

const ACCENT_PRESETS = ["#4f9cf9", "#22c55e", "#a855f7", "#f97316", "#ec4899", "#facc15"];
const FONT_PRESETS = ["Inter", "Roboto", "JetBrains Mono", "Fira Code", "Merriweather", "Lato"];

/**
 * Pulls every preset face down in one request so the dropdown can render each
 * option in its own font — a name set in Inter tells you nothing about what the
 * font looks like. Only the regular weight, since it is preview text.
 */
function usePresetFontPreviews() {
  useEffect(() => {
    const id = "font-preset-previews";
    if (document.getElementById(id)) return;
    const families = FONT_PRESETS.map((f) => `family=${encodeURIComponent(f)}`).join("&");
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`;
    document.head.appendChild(link);
  }, []);
}

/**
 * The palette each mode falls back to — a mirror of the `:root` / `html.light`
 * blocks in styles.css. Needed here because a colour the user hasn't overridden
 * still has to show its real value in the picker.
 */
const BASE_PALETTE: Record<"dark" | "light", Record<ThemeColorKey, string>> = {
  dark:  { bg: "#0b0d10", panel: "#14171c", panelHover: "#242a33", border: "#2d333d", text: "#e4e6eb", textMuted: "#8b929e" },
  light: { bg: "#fafafa", panel: "#ffffff", panelHover: "#e9edf2", border: "#d8dde4", text: "#1f2329", textMuted: "#5b6573" },
};

const COLOR_LABELS: Record<ThemeColorKey, string> = {
  bg: "Background",
  panel: "Panels",
  panelHover: "Hover",
  border: "Borders",
  text: "Text",
  textMuted: "Muted text",
};

const BACKGROUND_EFFECTS: [BackgroundEffect, string][] = [
  ["none", "None"],
  ["particles", "Particles"],
  ["orbs", "Orbs"],
  ["aurora", "Aurora"],
  ["grid", "Grid"],
  ["stars", "Stars"],
  ["shooting", "Shooting stars"],
  ["waves", "Waves"],
  ["fireflies", "Fireflies"],
  ["boids", "Boids"],
  ["matrix", "Matrix rain"],
  ["topography", "Topography"],
  ["puzzle", "Puzzle"],
  ["mountains", "Mountains"],
  ["fish", "Fish"],
];

const GLASS_STYLES: [GlassStyle, string, string][] = [
  ["frosted", "Frosted", "Blurred and desaturated — the classic frosted pane"],
  ["clear", "Clear", "No blur, so the background stays sharp through the glass"],
  ["tinted", "Tinted", "Frosted, with your accent colour bled into the glass"],
];

/** Effects whose "Density" slider means something. */
const DENSITY_EFFECTS: BackgroundEffect[] = [
  "particles", "orbs", "stars", "shooting", "grid", "waves", "fireflies", "boids",
  "matrix", "topography", "puzzle", "mountains", "fish",
];

function AppearanceTab() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const [fontInput, setFontInput] = useState(appSettings.fontFamily ?? "");
  usePresetFontPreviews();

  const fontSize = typeof appSettings.fontSize === "number" ? appSettings.fontSize : 14;
  const linked = !!appSettings.fontSizeLinked;
  const uiFontSize = linked
    ? Math.round((fontSize / 14) * 16)
    : typeof appSettings.uiFontSize === "number" ? appSettings.uiFontSize : 16;

  function applyFont(f: string) {
    setFontInput(f);
    setAppSettings({ fontFamily: f });
  }

  // Colour editing always targets the mode currently on screen, so what you
  // change is what you see.
  const paletteKey = theme.mode === "light" ? "colorsLight" : "colorsDark";
  const overrides = (theme.mode === "light" ? theme.colorsLight : theme.colorsDark) ?? {};
  const base = BASE_PALETTE[theme.mode === "light" ? "light" : "dark"];

  function setColor(key: ThemeColorKey, value: string | null) {
    const next = { ...overrides };
    if (value) next[key] = value;
    else delete next[key];
    setTheme({ [paletteKey]: next });
  }

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="mb-2 text-sm font-medium">Color mode</h3>
        <OptionCards
          value={theme.mode}
          onChange={(mode) => setTheme({ mode })}
          options={[
            ["dark",  "Dark"],
            ["light", "Light"],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Accent color</h3>
        <div className="flex flex-wrap items-center gap-2">
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              onClick={() => setTheme({ accent: c })}
              className={`h-8 w-8 rounded-full border-2 ${theme.accent.toLowerCase() === c.toLowerCase() ? "border-[var(--color-text)]" : "border-transparent"}`}
              style={{ background: c }}
              title={c}
            />
          ))}
          <div className="ml-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            Custom
            <HexColorField
              value={theme.accent}
              onChange={(accent) => setTheme({ accent })}
              title="Custom accent color"
            />
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">
          Colors · {theme.mode === "light" ? "Light" : "Dark"} mode
        </h3>
        {/* Two columns rather than three: each cell now carries an editable hex
            alongside its swatch, and a colour you can read is worth more than a
            grid one row shorter. */}
        <div className="grid grid-cols-2 narrow:grid-cols-1 gap-2">
          {(Object.keys(THEME_COLOR_KEYS) as ThemeColorKey[]).map((key) => {
            const value = overrides[key] ?? base[key];
            const custom = !!overrides[key];
            return (
              <div
                key={key}
                className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs">{COLOR_LABELS[key]}</span>
                <HexColorField
                  value={value}
                  onChange={(hex) => setColor(key, hex)}
                  title={`${COLOR_LABELS[key]} — ${custom ? "custom" : "default"}`}
                />
                <button
                  onClick={() => setColor(key, null)}
                  title="Reset to default"
                  disabled={!custom}
                  className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:invisible"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex items-center justify-end">
          {Object.keys(overrides).length > 0 && (
            <button
              onClick={() => setTheme({ [paletteKey]: {} })}
              className="text-[10px] text-[var(--color-text-muted)] underline hover:text-[var(--color-accent)]"
            >
              Reset all
            </button>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Typography</h3>
        <div className="grid grid-cols-2 narrow:grid-cols-1 gap-4">
          <div>
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Font</div>
            <select
              value={FONT_PRESETS.includes(fontInput) ? fontInput : fontInput ? "__custom" : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom") return;
                applyFont(v);
              }}
              style={{ fontFamily: `"${fontInput || "Inter"}", var(--font-family)` }}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            >
              <option value="" style={{ fontFamily: "Inter, sans-serif" }}>Default (Inter)</option>
              {FONT_PRESETS.map((f) => (
                <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>{f}</option>
              ))}
              {fontInput && !FONT_PRESETS.includes(fontInput) && (
                <option value="__custom" style={{ fontFamily: `"${fontInput}"` }}>{fontInput} (custom)</option>
              )}
            </select>
            <div className="mt-2 flex gap-2">
              <input
                value={fontInput}
                onChange={(e) => setFontInput(e.target.value)}
                onBlur={() => setAppSettings({ fontFamily: fontInput })}
                onKeyDown={(e) => { if (e.key === "Enter") setAppSettings({ fontFamily: fontInput }); }}
                placeholder="Any Google Font, e.g. Source Code Pro"
                className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
              />
              {fontInput && (
                <button
                  onClick={() => applyFont("")}
                  className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <SliderRow
              label="Message text"
              value={fontSize}
              min={10} max={24} step={1}
              display={`${fontSize}px`}
              onChange={(v) => setAppSettings({ fontSize: v })}
            />
            <div className={linked ? "pointer-events-none opacity-50" : ""}>
              <SliderRow
                label="Interface"
                value={uiFontSize}
                min={12} max={22} step={1}
                display={`${uiFontSize}px`}
                onChange={(v) => setAppSettings({ uiFontSize: v })}
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-text-muted)]">
              <input
                type="checkbox"
                checked={linked}
                onChange={(e) => setAppSettings({ fontSizeLinked: e.target.checked })}
              />
              Scale the interface with message text
            </label>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Visual effects</h3>
        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Drop shadows"
            description="Adds depth shadows to panels and cards"
            checked={!!theme.shadowsEnabled}
            onChange={(v) => setTheme({ shadowsEnabled: v })}
          />
          <ToggleRow
            label="Bloom / glow"
            description="Adds glow to interactive elements and accent colors"
            checked={!!theme.bloomEnabled}
            onChange={(v) => setTheme({ bloomEnabled: v })}
          />
          {theme.bloomEnabled && (
            <div className="ml-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <SliderRow
                label="Glow intensity"
                value={theme.bloomIntensity ?? 0.5}
                min={0.1} max={1} step={0.05}
                display={`${Math.round((theme.bloomIntensity ?? 0.5) * 100)}%`}
                onChange={(v) => setTheme({ bloomIntensity: v })}
              />
            </div>
          )}
          <ToggleRow
            label="Glass / transparency"
            description="Panels, menus and dialogs let the background show through"
            checked={!!theme.glassEnabled}
            onChange={(v) => setTheme({ glassEnabled: v })}
          />
          {theme.glassEnabled && (
            <div className="ml-3 flex flex-col gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div>
                <div className="mb-1.5 text-xs text-[var(--color-text-muted)]">Style</div>
                <div className="flex flex-wrap gap-1.5">
                  {GLASS_STYLES.map(([val, label, hint]) => (
                    <button
                      key={val}
                      title={hint}
                      onClick={() => setTheme({ glassStyle: val })}
                      className={`rounded border px-2.5 py-1 text-xs ${
                        (theme.glassStyle ?? "frosted") === val
                          ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]"
                          : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <SliderRow
                label="Transparency"
                value={theme.glassStrength ?? 0.5}
                min={0.1} max={1} step={0.05}
                display={`${Math.round((theme.glassStrength ?? 0.5) * 100)}%`}
                onChange={(v) => setTheme({ glassStrength: v })}
              />
              {theme.backgroundEffect === "none" && (
                <p className="text-[11px] text-[var(--color-text-muted)]">
                  With no background effect there's little behind the glass to see — pick one below.
                </p>
              )}
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Background effect</h3>
        <div className="grid grid-cols-2 narrow:grid-cols-1 gap-4">
          <div>
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Effect</div>
            <select
              value={theme.backgroundEffect}
              onChange={(e) => setTheme({ backgroundEffect: e.target.value as BackgroundEffect })}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            >
              {BACKGROUND_EFFECTS.map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </select>
            {theme.backgroundEffect !== "none" && (
              <div className="mt-3">
                <div className="mb-1.5 text-xs text-[var(--color-text-muted)]">Color</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setTheme({ effectColor: "accent" })}
                    className={`rounded border px-2.5 py-1 text-xs ${
                      theme.effectColor === "accent"
                        ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]"
                        : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                    }`}
                  >
                    Accent
                  </button>
                  <HexColorField
                    // Following the accent is a mode, not a colour, so the field
                    // sits empty there rather than showing an accent value that
                    // isn't what is stored.
                    value={theme.effectColor === "accent" ? null : (theme.effectColor || null)}
                    fallback={theme.accent}
                    onChange={(effectColor) => setTheme({ effectColor })}
                    title="Custom effect color"
                  />
                </div>
              </div>
            )}
          </div>
          {theme.backgroundEffect !== "none" && (
            <div className="flex flex-col gap-3">
              <SliderRow
                label="Speed"
                value={theme.effectSpeed}
                min={0.1} max={3} step={0.1}
                display={`${theme.effectSpeed.toFixed(1)}×`}
                onChange={(v) => setTheme({ effectSpeed: v })}
              />
              {DENSITY_EFFECTS.includes(theme.backgroundEffect) && (
                <SliderRow
                  label={theme.backgroundEffect === "grid" ? "Scale" : "Density"}
                  value={theme.effectDensity}
                  min={theme.backgroundEffect === "grid" ? 15 : 10}
                  max={theme.backgroundEffect === "grid" ? 150 : 200}
                  step={5}
                  display={theme.backgroundEffect === "grid" ? `${theme.effectDensity}px` : String(theme.effectDensity)}
                  onChange={(v) => setTheme({ effectDensity: v })}
                />
              )}
              <SliderRow
                label="Opacity"
                value={theme.effectOpacity}
                min={0.05} max={1} step={0.05}
                display={`${Math.round(theme.effectOpacity * 100)}%`}
                onChange={(v) => setTheme({ effectOpacity: v })}
              />
              <SliderRow
                label="Hue variation"
                value={theme.effectHue ?? 0}
                min={0} max={180} step={5}
                display={(theme.effectHue ?? 0) === 0 ? "Off" : `±${theme.effectHue}°`}
                onChange={(v) => setTheme({ effectHue: v })}
              />
            </div>
          )}
        </div>
      </section>

      <CustomCssSection />

      <section>
        <h3 className="mb-3 text-sm font-medium">Perspective layout</h3>
        <OptionCards
          value={appSettings.perspectiveLayout}
          onChange={(perspectiveLayout) => setAppSettings({ perspectiveLayout })}
          options={[
            ["stacked", "Stacked", "Full-width response blocks stacked vertically."],
            ["columns", "Columns", "Side-by-side columns for direct comparison."],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Zone library page size</h3>
        <OptionCards
          align="center"
          value={appSettings.zoneLibraryPageSize || 6}
          onChange={(zoneLibraryPageSize) => setAppSettings({ zoneLibraryPageSize })}
          options={[[6, "6"], [9, "9"], [12, "12"], [15, "15"], [30, "30"]]}
        />
      </section>

      {/* Exporting a chat is a question of how the document looks — how much of
          the run it draws and in which theme — so it lives here with the rest of
          the appearance settings rather than under Chat. */}
      <section>
        <h3 className="mb-3 text-sm font-medium">Chat export</h3>
        <OptionCards
          layout="column"
          value={appSettings.pdfExportDetail}
          onChange={(pdfExportDetail) => setAppSettings({ pdfExportDetail })}
          options={[
            ["steps", "Every step",  "One card per tool call and reasoning block."],
            ["rails", "Condensed",   "Each run of steps on one line, as the chat shows it. Plans, diagrams and files still drawn."],
            ["text",  "Text only",   "The conversation and its attachments, nothing else."],
          ]}
        />
        <p className="mb-2 mt-3 text-xs text-[var(--color-text-muted)]">
          Theme the document is drawn in.
        </p>
        <OptionCards
          value={appSettings.pdfExportTheme}
          onChange={(pdfExportTheme) => setAppSettings({ pdfExportTheme })}
          options={[
            ["app",   "Follow app"],
            ["light", "Light"],
            ["dark",  "Dark"],
          ]}
        />
        <p className="mt-3 text-xs text-[var(--color-text-muted)]">
          Export opens your print dialog. Set Margins to “None” for one continuous page, and
          enable “Background graphics” so the theme’s colours are drawn.
        </p>

        <div className="mt-4 flex flex-col gap-3">
          <ToggleRow
            label="Include sub-agent conversations"
            description="Nested under the turns that spawned them, and marked as zone-to-zone. Markdown and PDF."
            checked={appSettings.exportSubchats}
            onChange={(exportSubchats) => setAppSettings({ exportSubchats })}
          />
          <ToggleRow
            label="Append the session log"
            description="Closes the PDF with the run as recorded — every turn and tool, timed from the first. Evidence rather than reading, so it is off unless you want it. PDF only."
            checked={appSettings.pdfExportSessionLog}
            onChange={(pdfExportSessionLog) => setAppSettings({ pdfExportSessionLog })}
          />
        </div>
      </section>

    </div>
  );
}

/**
 * Custom CSS (0.11.3) — the escape hatch under the appearance settings.
 *
 * Everything above it is a control we chose to build; this is for the change we
 * didn't. It edits into local state and commits on a short idle, because the
 * theme row is written to the database on every commit and a write per keystroke
 * would be both wasteful and, through the settings-updated echo, jumpy.
 *
 * The variable list is not decoration: a stylesheet that hardcodes `#14171c`
 * breaks the moment the user switches to light mode, and `var(--color-panel)`
 * doesn't. Showing the names is the difference between an escape hatch and a
 * support question.
 */
function CustomCssSection() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const [draft, setDraft] = useState(theme.customCss ?? "");
  const [expanded, setExpanded] = useState(!!theme.customCss);
  const enabled = !!theme.customCssEnabled;

  // Follow the stored value when it changes underneath us — a model editing the
  // sheet over `app_control` is the case this exists for — but never while the
  // user is mid-edit, which is what the pending-commit ref rules out.
  const pending = useRef(false);
  const stored = theme.customCss ?? "";
  useEffect(() => {
    if (!pending.current) setDraft(stored);
  }, [stored]);

  useEffect(() => {
    if (draft === stored) return;
    pending.current = true;
    const id = setTimeout(() => {
      pending.current = false;
      setTheme({ customCss: draft.slice(0, MAX_CUSTOM_CSS) });
    }, 400);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, stored]);

  const tooLong = draft.length > MAX_CUSTOM_CSS;

  return (
    <section>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="mb-2 flex items-center gap-1 text-sm font-medium hover:text-[var(--color-accent)]"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Custom CSS
      </button>
      {expanded && (
        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Apply custom CSS"
            description="Loaded after the app's own, so it wins. Off restores the stock look without deleting it."
            checked={enabled}
            onChange={(customCssEnabled) => setTheme({ customCssEnabled })}
          />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={10}
            placeholder={`/* e.g. */\n.sidebar { width: 220px; }\nbutton { border-radius: 2px; }`}
            className={`w-full resize-y rounded border bg-[var(--color-bg)] px-2.5 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)] ${
              tooLong ? "border-red-500/60" : "border-[var(--color-border)]"
            } ${enabled ? "" : "opacity-60"}`}
          />
          <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--color-text-muted)]">
            <span>
              Use the theme variables so the rules survive a mode switch:{" "}
              <code className="font-mono">
                {Object.values(THEME_COLOR_KEYS).join(", ")}, --color-accent
              </code>
            </span>
            <span className={`shrink-0 tabular-nums ${tooLong ? "text-red-500" : ""}`}>
              {formatCount(draft.length)}/{formatCount(MAX_CUSTOM_CSS)}
            </span>
          </div>
          {tooLong && (
            <p className="text-[11px] text-red-500">
              Only the first {formatCount(MAX_CUSTOM_CSS)} characters are applied.
            </p>
          )}
          {!enabled && draft.trim() !== "" && (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              Saved, but not applied — turn “Apply custom CSS” on to see it.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

function ChatTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const zones = useApp((s) => s.zones);
  const providers = useApp((s) => s.providers);

  // What "— none —" actually resolves to, so the fallback isn't a mystery.
  const fallbackModel = resolveBaseProvider(providers, zones, null)?.defaultModel?.trim() ?? "";

  async function pickDefaultDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setAppSettings({ defaultDirectory: selected });
  }
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Base zone</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Answers Quick Chat and provides the fallback model, prompt, and tools.
        </p>
        <SettingSelect
          value={appSettings.baseZoneId ?? ""}
          onChange={(v) => setAppSettings({ baseZoneId: v || null })}
        >
          <option value="">
            — none{fallbackModel ? ` (${fallbackModel}, no prompt or tools)` : ""} —
          </option>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name} · {z.model}
            </option>
          ))}
        </SettingSelect>
        {zones.length === 0 && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            No zones yet — create one from "Configure Zones".
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Send key</h3>
        <OptionCards
          value={appSettings.sendKey}
          onChange={(sendKey) => setAppSettings({ sendKey })}
          options={[
            ["enter", "Enter", ""],
            ["ctrl_enter", "Ctrl+Enter", "⌘+Enter on Mac"],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Messages</h3>
        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Auto-generate chat titles"
            description="Names a chat from its first response."
            checked={appSettings.autoTitle}
            onChange={(v) => setAppSettings({ autoTitle: v })}
          />
          <ToggleRow
            label="Compact steps into one activity rail"
            description="Off shows every thinking and tool step as its own card."
            checked={appSettings.compactSteps}
            onChange={(v) => setAppSettings({ compactSteps: v })}
          />
          <ToggleRow
            label="Expand reasoning by default"
            description="Off collapses thinking blocks once streaming finishes."
            checked={appSettings.expandThinkingByDefault}
            onChange={(v) => setAppSettings({ expandThinkingByDefault: v })}
          />
        </div>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Max task length</h3>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={4}
            max={200}
            value={appSettings.maxToolSteps}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setAppSettings({ maxToolSteps: Math.min(200, Math.max(4, Math.round(n))) });
              }
            }}
            className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm"
          />
          <span className="text-xs text-[var(--color-text-muted)]">steps per response (4–200)</span>
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Session token limit</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          A ceiling on what one session — a chat and every sub-agent under it — may spend before the
          run is <strong>stopped</strong>. Counted on the requests themselves, so a ten-step turn
          that re-sends 50k of context ten times counts as 500k. <strong>0 is off</strong>, which is
          the default: against a model on your own machine a long session costs nothing but time.
          Set it when tokens are money and a panel is running unattended.
        </p>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          This is the <strong>default for chats that have not set their own</strong>. Raising the
          limit from the card in a chat that has hit it applies to that chat alone, which is what
          lifting a ceiling to let one piece of work finish is supposed to mean.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            step={100000}
            value={appSettings.maxSessionTokens}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setAppSettings({ maxSessionTokens: Math.max(0, Math.round(n)) });
              }
            }}
            className="w-32 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm"
          />
          <span className="text-xs text-[var(--color-text-muted)]">
            {appSettings.maxSessionTokens > 0
              ? `tokens per session (${(appSettings.maxSessionTokens / 1_000_000).toFixed(2)}M)`
              : "no limit"}
          </span>
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Tool auto-approval</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          By danger, for anything the categories below leave undecided. Dangerous: code execution
          and shell. Moderate: web search and file access.
        </p>
        <OptionCards
          layout="column"
          value={appSettings.autoApproveLevel}
          onChange={(autoApproveLevel) => setAppSettings({ autoApproveLevel })}
          options={[
            ["all",          "Everything",          "No approval prompts."],
            ["safe_moderate","Safe + moderate",     "Dangerous tools ask first."],
            ["safe",         "Safe only",           "Moderate and dangerous tools ask first."],
            ["none",         "Nothing",             "Every tool call asks first."],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">By kind of work</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          The slider above answers "how dangerous is this tool". This answers a different question:
          what kind of work do you want to be asked about. Reading files all day is not worth twenty
          prompts; one shell command usually is. Anything left on <strong>Inherit</strong> follows
          the slider, so changing nothing here changes nothing.
        </p>
        <ApprovalCategoryGrid
          value={appSettings.approvals}
          onChange={(approvals) => setAppSettings({ approvals })}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Notifications</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          A run that needs you stops until you answer — an approval times out after five minutes and
          the agent behind it stalls with no visible cause. Since the reason to start a long run is
          not to sit watching it, the app says so.
        </p>
        <ToggleRow
          label="Tell me when a run is waiting on me"
          description="Approvals and questions only, and only when the window is in the background. Finished turns never notify."
          checked={appSettings.notifyWhenWaiting}
          onChange={(v) => setAppSettings({ notifyWhenWaiting: v })}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Command rules</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          One command prefix per line, matched on whole words. <strong>Longest match wins</strong>,
          so allowing <code>git</code> and denying <code>git push</code> resolves the way it reads.
          A denied command is <em>refused</em>, not prompted — writing the rule down is the answer.
          These apply to shell, code execution and terminal input only.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <PrefixList
            label="Run without asking"
            placeholder={"git status\nnpm run test\nls"}
            value={appSettings.approvals.shellAllow}
            onChange={(shellAllow) =>
              setAppSettings({ approvals: { ...appSettings.approvals, shellAllow } })
            }
          />
          <PrefixList
            label="Never run"
            placeholder={"git push\nrm -rf\ncurl"}
            value={appSettings.approvals.shellDeny}
            onChange={(shellDeny) =>
              setAppSettings({ approvals: { ...appSettings.approvals, shellDeny } })
            }
          />
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Where edits may land</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          One path per line, matched a whole folder at a time — <code>{"{project}"}</code> stands
          for whichever project the chat is in. Longest match wins, so allowing{" "}
          <code>{"{project}"}</code> and denying <code>{"{project}/.git"}</code> reads the way it
          looks. The category above decides <em>whether</em> edits are approved; this decides{" "}
          <strong>where</strong>.
        </p>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Listing anything under <em>Edit without asking</em> makes it a boundary: an edit outside
          every line is prompted even when the Edit category is set to auto — being asked about
          exactly those is the reason to draw one.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <PrefixList
            label="Edit without asking"
            placeholder={"{project}\nC:\\Users\\me\\scratch"}
            value={appSettings.approvals.editAllow}
            onChange={(editAllow) =>
              setAppSettings({ approvals: { ...appSettings.approvals, editAllow } })
            }
          />
          <PrefixList
            label="Never edit"
            placeholder={"{project}/.git\n{project}/node_modules"}
            value={appSettings.approvals.editDeny}
            onChange={(editDeny) =>
              setAppSettings({ approvals: { ...appSettings.approvals, editDeny } })
            }
          />
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Review file edits before they land</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          A zone's writes queue up as a diff you apply whole, by file, or by hunk. The model
          carries on as if they had landed, so a long task still works.
        </p>
        <ToggleRow
          label="Stage file edits for review"
          description="Create and edit calls, in every chat."
          checked={appSettings.reviewQueue}
          onChange={(v) => setAppSettings({ reviewQueue: v })}
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">PDF attachments</h3>
        <OptionCards
          value={appSettings.pdfMode}
          onChange={(pdfMode) => setAppSettings({ pdfMode })}
          options={[
            ["images", "Images", "Best for diagrams and scans."],
            ["text",   "Text",   "Faster, for text-heavy PDFs."],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">OCR fallback</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Used when an image is OCR'd for a model that can't see it
          (<span className="font-mono">eng</span>, <span className="font-mono">deu</span>,{" "}
          <span className="font-mono">fra</span>…).
        </p>
        <input
          type="text"
          value={appSettings.ocrLanguage}
          onChange={(e) => setAppSettings({ ocrLanguage: e.target.value.trim() })}
          placeholder="eng"
          spellCheck={false}
          className="w-32 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Default file directory</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={pickDefaultDir}
            className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <FolderOpen size={13} /> Choose folder…
          </button>
          {appSettings.defaultDirectory ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
              <Folder size={12} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="truncate font-mono text-xs" title={appSettings.defaultDirectory}>{appSettings.defaultDirectory}</span>
              <button
                onClick={() => setAppSettings({ defaultDirectory: "" })}
                className="ml-auto shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <span className="text-xs text-[var(--color-text-muted)]">No default directory set</span>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">The project's own instructions</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Most repositories already carry a file written to tell an agent how to work in them —
          <code> AGENTS.md</code> or <code>CLAUDE.md</code>. Read from the working directory up to
          the repository root and put in front of every zone that has tools, so seven agents do not
          rediscover the same conventions one mistake at a time. The context meter lists what it
          costs under <em>Project instructions</em>.
        </p>
        <ToggleRow
          label="Read AGENTS.md and CLAUDE.md from the project"
          description="Standing instructions from the repository. They outrank the model's habits, never what you ask for now."
          checked={appSettings.projectInstructions}
          onChange={(v) => setAppSettings({ projectInstructions: v })}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Planning offer</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Zones with tools are told that <code>enter_plan_mode</code> exists and when to reach
          for it. The full block (~270 tokens) restates the tool's own description; the short
          form is one sentence and leaves the rest to the tool schema. Turn this off to try the
          short form — if "plan this for me" still reaches the tool from a read-only zone, the
          block was never needed.
        </p>
        <ToggleRow
          label="Full planning offer in the system prompt"
          description="Off sends a one-line pointer instead. The context meter shows the difference under Planning available."
          checked={appSettings.planOfferFull}
          onChange={(v) => setAppSettings({ planOfferFull: v })}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Repository map</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          What the project defines, ranked by how much the rest of the code refers to it — so an
          agent starts knowing roughly where things are instead of spending its first several steps
          finding out. A panel of seven pays that cost seven times, in parallel, to reach the same
          answer. Rebuilt when the tree changes, at most every ten minutes.
        </p>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="number"
            min={0}
            max={8000}
            step={250}
            value={appSettings.repoMapTokens}
            onChange={(e) =>
              setAppSettings({
                repoMapTokens: Math.max(0, Math.min(8000, Number(e.target.value) || 0)),
              })
            }
            className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-[var(--color-text-muted)]">
            tokens per request — 0 turns the map off. Offered only to zones that have file tools.
          </span>
        </label>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Perspective run mode</h3>
        <OptionCards
          value={appSettings.perspectiveMode}
          onChange={(perspectiveMode) => setAppSettings({ perspectiveMode })}
          options={[
            ["parallel",   "Parallel",   "All zones at once — fastest."],
            ["sequential", "Sequential", "One at a time — easier on local VRAM."],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Subagent depth limit</h3>
        <OptionCards
          align="center"
          value={appSettings.subchatDepthLimit || 3}
          onChange={(subchatDepthLimit) => setAppSettings({ subchatDepthLimit })}
          options={[[1, "1"], [2, "2"], [3, "3"], [4, "4"], [5, "5"]]}
        />
        <div className="mt-3">
          <ToggleRow
            label="Show the team's total context"
            description="Adds every subagent's context to the meter. Only shown when a chat has subagents."
            checked={appSettings.teamContextMeter !== false}
            onChange={(v) => setAppSettings({ teamContextMeter: v })}
          />
        </div>
      </section>

    </div>
  );
}

// ─── Voice ──────────────────────────────────────────────────────────────────────

function VoiceTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const providers = useApp((s) => s.providers);
  const voiceInputDevices = useApp((s) => s.voiceInputDevices);
  const refreshVoiceInputDevices = useApp((s) => s.refreshVoiceInputDevices);
  const [providerModels, setProviderModels] = useState<string[]>([]);

  useEffect(() => {
    if (!appSettings.sttProviderId) { setProviderModels([]); return; }
    let cancelled = false;
    api.fetchModels(appSettings.sttProviderId)
      .then((m) => { if (!cancelled) setProviderModels(m); })
      .catch(() => { if (!cancelled) setProviderModels([]); });
    return () => { cancelled = true; };
  }, [appSettings.sttProviderId]);

  useEffect(() => {
    refreshVoiceInputDevices().catch(console.error);
  }, [refreshVoiceInputDevices]);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Dictation provider</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Any provider with an OpenAI-compatible <span className="font-mono">/audio/transcriptions</span>{" "}
          endpoint — including a local whisper server, which keeps recordings on this machine.
        </p>
        {providers.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No providers configured yet — add one in the Providers tab, then choose it here.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--color-text-muted)]">Provider</p>
            <SettingSelect
              value={appSettings.sttProviderId ?? ""}
              onChange={(v) => setAppSettings({ sttProviderId: v || null, sttModel: "" })}
            >
              <option value="">— choose a provider —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </SettingSelect>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Model</p>
            <ModelCombobox
              value={appSettings.sttModel}
              onChange={(v) => setAppSettings({ sttModel: v })}
              options={providerModels}
              placeholder="e.g. whisper-1"
              className="input"
            />
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Audio uploads</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Drop an audio file into any composer — MP3, WAV, M4A, MP4, FLAC, OGG, WebM — and the
          transcript is sent as text, so a text-only model can take spoken input.
        </p>
        {(!appSettings.sttProviderId || !appSettings.sttModel) && (
          <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
            Audio uploads need the transcription provider above configured first.
          </p>
        )}

        <p className="mb-2 text-xs text-[var(--color-text-muted)]">When a transcript is ready</p>
        <OptionCards
          value={appSettings.sttUploadMode}
          onChange={(sttUploadMode) => setAppSettings({ sttUploadMode })}
          options={[
            ["quick", "Use it", "Put the transcript straight into the message box"],
            ["review", "Review first", "Read and correct it on the chip before sending"],
          ]}
        />

        <p className="mb-2 mt-4 text-xs text-[var(--color-text-muted)]">How it reaches the model</p>
        <OptionCards
          value={appSettings.sttUploadInjection}
          onChange={(sttUploadInjection) => setAppSettings({ sttUploadInjection })}
          options={[
            ["message", "As my message", "The transcript becomes the text you send"],
            ["context", "As an attachment", "Model reads it as context; the message box stays yours"],
          ]}
        />
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Long recordings want “as an attachment”, so you can type the instruction —
          “summarise this meeting” — alongside the transcript.
        </p>

        <div className="mt-4">
          <ToggleRow
            label="Include timestamps and language"
            description="Per-segment timings and the detected language. Not every server implements it."
            checked={appSettings.sttUploadMetadata}
            onChange={(sttUploadMetadata) => setAppSettings({ sttUploadMetadata })}
          />
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <SliderRow
            label="Maximum file size"
            value={appSettings.sttUploadMaxMb}
            min={1}
            max={200}
            step={1}
            display={`${appSettings.sttUploadMaxMb} MB`}
            onChange={(sttUploadMaxMb) => setAppSettings({ sttUploadMaxMb })}
          />
          <SliderRow
            label="Maximum duration"
            value={appSettings.sttUploadMaxMinutes}
            min={0}
            max={480}
            step={5}
            display={
              appSettings.sttUploadMaxMinutes === 0
                ? "no limit"
                : `${appSettings.sttUploadMaxMinutes} min`
            }
            onChange={(sttUploadMaxMinutes) => setAppSettings({ sttUploadMaxMinutes })}
          />
        </div>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          OpenAI's hosted endpoint refuses anything over 25 MB itself — raise this only for a
          server with its own ceiling.
        </p>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Language</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          BCP-47-ish code (e.g. <span className="font-mono">en</span>). Empty auto-detects, which is
          usually better than forcing one.
        </p>
        <input
          type="text"
          value={appSettings.sttLanguage}
          onChange={(e) => setAppSettings({ sttLanguage: e.target.value.trim() })}
          placeholder="auto-detect"
          spellCheck={false}
          className="w-32 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Input device</h3>
        {isRemote() ? (
          /* The list is the *desktop's* microphones, and a phone does not use
             them: it records here and sends the audio over for your computer to
             transcribe with the provider above. Offering the choice anyway
             would be a picker that changes nothing. */
          <p className="text-xs text-[var(--color-text-muted)]">
            This device records with its own microphone and sends the audio to your computer,
            which converts it to 16 kHz mono WAV with ffmpeg before handing it to the provider
            above — the same format the computer's own microphone produces, so a local
            transcription server accepts both. Without ffmpeg installed the recording is sent as
            it was recorded, and the error says so if the provider refuses it.
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-[var(--color-text-muted)]">
              Microphone used for dictation.
            </p>
            <SettingSelect
              value={appSettings.sttInputDevice ?? ""}
              onChange={(v) => setAppSettings({ sttInputDevice: v || null })}
            >
              <option value="">System default</option>
              {voiceInputDevices.map((d) => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </SettingSelect>
          </>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Activation mode</h3>
        <OptionCards
          value={appSettings.sttActivationMode}
          onChange={(sttActivationMode) => setAppSettings({ sttActivationMode })}
          options={[
            ["toggle", "Toggle", "Click to start, click again to stop"],
            ["hold", "Hold", "Press and hold to record (push-to-talk)"],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Insertion mode</h3>
        <OptionCards
          value={appSettings.sttInsertionMode}
          onChange={(sttInsertionMode) => setAppSettings({ sttInsertionMode })}
          options={[
            ["cursor", "At cursor", "Insert the transcript at the cursor position"],
            ["replace", "Replace field", "Replace the entire input field with the transcript"],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Live transcription</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Re-transcribes the recording on an interval. Each pass is a full request — free against
          a local server, billed per call against a hosted one.
          {isRemote() && (
            /* The desktop re-transcribes the utterance so far every couple of
               seconds. Doing that from a phone means re-uploading the whole
               recording on every tick, so the phone does not — and a switch
               that is on while nothing happens is worse than one that explains
               itself. */
            <>
              {" "}
              <span className="text-[var(--color-text)]">
                This device does not do this: it would re-upload the whole recording on every
                pass. The setting below applies when you dictate on the computer itself.
              </span>
            </>
          )}
        </p>
        <ToggleRow
          label="Show words while speaking"
          checked={appSettings.sttLivePartialMs > 0}
          onChange={(v) => setAppSettings({ sttLivePartialMs: v ? 1500 : 0 })}
        />
        {appSettings.sttLivePartialMs > 0 && (
          <div className="mt-2">
            <SliderRow
              label="Refresh interval"
              value={appSettings.sttLivePartialMs}
              min={500}
              max={5000}
              step={250}
              display={`${appSettings.sttLivePartialMs}ms`}
              onChange={(v) => setAppSettings({ sttLivePartialMs: v })}
            />
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Auto-send on silence</h3>
        <ToggleRow
          label="Auto-send after silence"
          checked={appSettings.sttAutoSendSilenceMs > 0}
          onChange={(v) => setAppSettings({ sttAutoSendSilenceMs: v ? 1200 : 0 })}
        />
        {appSettings.sttAutoSendSilenceMs > 0 && (
          <div className="mt-2">
            <SliderRow
              label="Silence threshold"
              value={appSettings.sttAutoSendSilenceMs}
              min={500}
              max={3000}
              step={100}
              display={`${appSettings.sttAutoSendSilenceMs}ms`}
              onChange={(v) => setAppSettings({ sttAutoSendSilenceMs: v })}
            />
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Text-to-speech (0.8.1) ───────────────────────────────────────────────────

const COMMON_TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

function SpeechTab() {
  return (
    <div className="flex flex-col gap-6">
      <SpeechSynthesisSettings />
      <div className="border-t border-[var(--color-border)]" />
      <VoiceCloningSettings />
      <div className="border-t border-[var(--color-border)]" />
      <ConversationModeSettings />
    </div>
  );
}

function SpeechSynthesisSettings() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const providers = useApp((s) => s.providers);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [serverVoices, setServerVoices] = useState<string[]>([]);
  const [clonedVoices, setClonedVoices] = useState<string[]>([]);

  useEffect(() => {
    if (!appSettings.ttsProviderId) { setProviderModels([]); return; }
    let cancelled = false;
    api.fetchModels(appSettings.ttsProviderId)
      .then((m) => { if (!cancelled) setProviderModels(m); })
      .catch(() => { if (!cancelled) setProviderModels([]); });
    return () => { cancelled = true; };
  }, [appSettings.ttsProviderId]);

  // Voices advertised by the provider itself (a local shim's /audio/voices),
  // merged with the OpenAI names as datalist suggestions.
  useEffect(() => {
    if (!appSettings.ttsProviderId || !appSettings.ttsModel) { setServerVoices([]); return; }
    let cancelled = false;
    api.listTtsVoices()
      .then((v) => { if (!cancelled) setServerVoices(v); })
      .catch(() => { if (!cancelled) setServerVoices([]); });
    return () => { cancelled = true; };
  }, [appSettings.ttsProviderId, appSettings.ttsModel]);

  useEffect(() => {
    let cancelled = false;
    api.listClonedVoices()
      .then((v) => { if (!cancelled) setClonedVoices(v.map((c) => c.name)); })
      .catch(() => { if (!cancelled) setClonedVoices([]); });
    return () => { cancelled = true; };
  }, [appSettings.ttsVoice]);

  const voiceOptions = Array.from(new Set([...clonedVoices, ...serverVoices, ...COMMON_TTS_VOICES]));

  return (
    <>
      <section>
        <h3 className="mb-1 text-sm font-medium">Speech (read aloud)</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Any provider with an OpenAI-compatible <span className="font-mono">/audio/speech</span>{" "}
          endpoint, including a local one.
        </p>
        {providers.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No providers configured yet — add one in the Providers tab, then choose it here.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--color-text-muted)]">Provider</p>
            <SettingSelect
              value={appSettings.ttsProviderId ?? ""}
              onChange={(v) => setAppSettings({ ttsProviderId: v || null, ttsModel: "" })}
            >
              <option value="">— choose a provider —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </SettingSelect>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Model</p>
            <ModelCombobox
              value={appSettings.ttsModel}
              onChange={(v) => setAppSettings({ ttsModel: v })}
              options={providerModels}
              placeholder="e.g. tts-1"
              className="input"
            />
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Voice</p>
            <input
              type="text"
              list="tts-voice-options"
              value={appSettings.ttsVoice}
              onChange={(e) => setAppSettings({ ttsVoice: e.target.value.trim() })}
              placeholder="e.g. alloy"
              spellCheck={false}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <datalist id="tts-voice-options">
              {voiceOptions.map((v) => <option key={v} value={v} />)}
            </datalist>
            {serverVoices.length > 0 && (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Voices from this provider: {serverVoices.map((v) => (
                  <button
                    key={v}
                    onClick={() => setAppSettings({ ttsVoice: v })}
                    className={`mr-1 rounded px-1.5 py-0.5 ${appSettings.ttsVoice === v ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]" : "hover:bg-[var(--color-panel-hover)]"}`}
                  >
                    {v}
                  </button>
                ))}
              </p>
            )}
            <p className="text-[11px] text-[var(--color-text-muted)]">
              A zone can override this with its own voice in the zone editor. Audio leaves your machine
              unless the provider runs locally.
            </p>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Speed</h3>
        <SliderRow
          label="Playback speed"
          value={Math.round(appSettings.ttsRate * 100)}
          min={50}
          max={200}
          step={5}
          display={`${appSettings.ttsRate.toFixed(2)}×`}
          onChange={(v) => setAppSettings({ ttsRate: v / 100 })}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Summarize long responses</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Condense long answers into a short spoken summary (via the chat's model) instead of reading
          out large verbose blocks.
        </p>
        <ToggleRow
          label="Auto-summarize before speaking"
          checked={appSettings.ttsAutoSummarize}
          onChange={(v) => setAppSettings({ ttsAutoSummarize: v })}
        />
        {appSettings.ttsAutoSummarize && (
          <div className="mt-2">
            <SliderRow
              label="Summarize above"
              value={appSettings.ttsSummarizeThreshold}
              min={300}
              max={4000}
              step={100}
              display={`${appSettings.ttsSummarizeThreshold} chars`}
              onChange={(v) => setAppSettings({ ttsSummarizeThreshold: v })}
            />
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Auto-speak</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Automatically speak assistant responses as they stream in. Speech is chunked by sentence so
          it starts before the full answer completes.
        </p>
        <ToggleRow
          label="Speak responses automatically"
          checked={appSettings.ttsAutoSpeak}
          onChange={(v) => setAppSettings({ ttsAutoSpeak: v })}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Prefetch</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Sentences synthesized in parallel while the current one plays. Higher removes the gap
          between them, at more concurrent requests.
        </p>
        <SliderRow
          label="Sentences ahead"
          value={appSettings.ttsPrefetch}
          min={1}
          max={8}
          step={1}
          display={appSettings.ttsPrefetch === 1 ? "1 (sequential)" : `${appSettings.ttsPrefetch}`}
          onChange={(v) => setAppSettings({ ttsPrefetch: v })}
        />
      </section>
    </>
  );
}

// ─── Voice cloning (0.8.3) ────────────────────────────────────────────────────

function VoiceCloningSettings() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const supported = appSettings.ttsSupportsCloning;

  const [name, setName] = useState("");
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [refText, setRefText] = useState("");
  const [busy, setBusy] = useState<null | "transcribing" | "creating">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [voices, setVoices] = useState<import("@/lib/tauri").ClonedVoice[]>([]);

  const canConfigureProvider = !!appSettings.ttsProviderId && !!appSettings.ttsModel;

  const refreshVoices = () => {
    api.listClonedVoices().then(setVoices).catch(() => setVoices([]));
  };
  useEffect(() => { refreshVoices(); }, []);

  async function pickAudio() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "flac", "webm"] }],
    });
    if (typeof picked === "string") { setAudioPath(picked); setMsg(null); }
  }

  async function autoTranscribe() {
    if (!audioPath) return;
    setBusy("transcribing"); setMsg(null);
    try {
      const text = await api.transcribeAudioFile(audioPath);
      setRefText(text);
    } catch (e) {
      setMsg({ kind: "err", text: `Transcription failed: ${e}` });
    } finally {
      setBusy(null);
    }
  }

  async function createVoice() {
    if (!name.trim() || !audioPath) return;
    setBusy("creating"); setMsg(null);
    try {
      const saved = await api.createClonedVoice(name.trim(), audioPath, refText.trim());
      setMsg({ kind: "ok", text: `Created voice "${saved}". Set it as your voice above or per-zone.` });
      setName(""); setAudioPath(null); setRefText("");
      refreshVoices();
    } catch (e) {
      setMsg({ kind: "err", text: String(e) });
    } finally {
      setBusy(null);
    }
  }

  const fileName = audioPath ? audioPath.split(/[\\/]/).pop() : null;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <AudioLines size={14} className="text-[var(--color-accent)]" />
        <h3 className="text-sm font-medium">Voice cloning</h3>
      </div>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        Some local models (F5-TTS, say) clone a voice from a short sample; hosted ones like OpenAI
        only offer fixed voices. Your clip and its transcript ride along with each request, so there
        is nothing to set up server-side.
      </p>
      <ToggleRow
        label="My speech model supports voice cloning"
        checked={supported}
        onChange={(v) => setAppSettings({ ttsSupportsCloning: v })}
      />

      {!supported ? null : !canConfigureProvider ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          Choose a speech provider and model above first.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-3">
          <div>
            <p className="mb-1 text-xs text-[var(--color-text-muted)]">Voice name</p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. my-voice"
              spellCheck={false}
              className="input"
            />
          </div>

          <div>
            <p className="mb-1 text-xs text-[var(--color-text-muted)]">Reference sample</p>
            <div className="flex items-center gap-2">
              <button
                onClick={pickAudio}
                className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <FileUp size={12} /> Choose audio…
              </button>
              {fileName && <span className="truncate text-xs text-[var(--color-text-muted)]">{fileName}</span>}
            </div>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              3–10 seconds of clean, single-speaker speech works best.
            </p>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs text-[var(--color-text-muted)]">Sample transcript (optional)</p>
              <button
                onClick={autoTranscribe}
                disabled={!audioPath || busy !== null}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-panel-hover)] disabled:opacity-40"
                title="Transcribe the sample using your dictation provider"
              >
                {busy === "transcribing" ? <Loader2 size={11} className="animate-spin" /> : <Mic size={11} />}
                Auto-transcribe
              </button>
            </div>
            <textarea
              value={refText}
              onChange={(e) => setRefText(e.target.value)}
              rows={2}
              placeholder="Exact words spoken in the sample. Leave empty to let the server transcribe it."
              className="input font-normal"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={createVoice}
              disabled={!name.trim() || !audioPath || busy !== null}
              className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
            >
              {busy === "creating" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Create voice
            </button>
            {msg && (
              <span className={`text-xs ${msg.kind === "ok" ? "text-emerald-500" : "text-red-500"}`}>
                {msg.text}
              </span>
            )}
          </div>

          {voices.length > 0 && (
            <div className="border-t border-[var(--color-border)] pt-2">
              <p className="mb-1 text-[11px] text-[var(--color-text-muted)]">Your cloned voices</p>
              <div className="flex flex-col gap-1">
                {voices.map((v) => (
                  <div key={v.name} className="flex items-center gap-2">
                    <button
                      onClick={() => setAppSettings({ ttsVoice: v.name })}
                      className={`rounded-full border px-2 py-0.5 text-xs ${appSettings.ttsVoice === v.name ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"}`}
                      title="Use this voice"
                    >
                      {v.name}{appSettings.ttsVoice === v.name ? " ✓" : ""}
                    </button>
                    {v.refText && (
                      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={v.refText}>
                        {v.refText}
                      </span>
                    )}
                    <button
                      onClick={async () => { await api.deleteClonedVoice(v.name); refreshVoices(); }}
                      className="text-[var(--color-text-muted)] hover:text-red-500"
                      title="Delete voice"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Hands-free conversation mode (0.8.2) ─────────────────────────────────────

function ConversationModeSettings() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">Conversation mode (hands-free)</h3>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        The mic reopens when a spoken response finishes, and speaking interrupts playback. Needs
        both a dictation and a speech provider above.
      </p>
      <ToggleRow
        label="Enable conversation mode"
        checked={appSettings.voiceConversationEnabled}
        onChange={(v) => setAppSettings({ voiceConversationEnabled: v })}
      />
    </section>
  );
}

// ─── Skills ─────────────────────────────────────────────────────────────────────

function SkillsTab() {
  const skills = useApp((s) => s.skills);
  const zones = useApp((s) => s.zones);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [creating, setCreating] = useState<SkillSeed | null>(null);

  useEffect(() => { refreshSkills().catch(console.error); }, [refreshSkills]);

  async function importFile(file: File) {
    const raw = await file.text();
    const fallbackName = file.name.replace(/\.(md|markdown|txt)$/i, "");
    const parsed = parseSkill(raw, fallbackName);
    setEditing(null);
    setCreating(parsed);
  }

  async function toggle(s: Skill) {
    await api.setSkillEnabled(s.id, !s.enabled);
    await refreshSkills();
  }

  async function remove(s: Skill) {
    await api.deleteSkill(s.id);
    await refreshSkills();
  }

  // Skills a zone wrote itself and that the user hasn't looked at yet. Sorted to
  // the top so the review queue is the first thing on the page.
  const pendingReview = skills.filter((s) => s.authoredByZoneId && !s.enabled);
  const sortedSkills = [...skills].sort((a, b) => {
    const aPending = a.authoredByZoneId && !a.enabled ? 0 : 1;
    const bPending = b.authoredByZoneId && !b.enabled ? 0 : 1;
    return aPending - bPending || a.name.localeCompare(b.name);
  });
  const zoneName = (id: string) => zones.find((z) => z.id === id)?.name ?? "a zone";

  if (editing || creating) {
    return (
      <SkillEditor
        skill={editing}
        seed={creating}
        onDone={async () => { setEditing(null); setCreating(null); await refreshSkills(); }}
        onCancel={() => { setEditing(null); setCreating(null); }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="mb-1 text-sm font-medium">Skills</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          On-demand instruction sets. A zone with the <span className="font-mono">Skills</span> tool sees
          every enabled skill's description and loads the full text itself when one matches — so write
          the description as the use case that should trigger it.
        </p>
      </section>

      <div className="flex gap-2">
        <button
          onClick={() => { setEditing(null); setCreating({ name: "", description: "", content: "" }); }}
          className="flex items-center gap-1.5 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> New skill
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <FileUp size={12} /> Import .md
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }}
        />
      </div>

      {/* Self-authored drafts (0.9.2): a zone wrote these itself via `create_skill`.
          They are created disabled and enter no agent's catalog until reviewed, so
          surface them here rather than letting them sit unnoticed in the list. */}
      {pendingReview.length > 0 && (
        <div className="rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5 p-3 text-xs">
          <div className="font-medium">
            {pendingReview.length === 1
              ? "1 skill written by a zone is waiting for your review"
              : `${pendingReview.length} skills written by zones are waiting for your review`}
          </div>
          <div className="mt-0.5 text-[var(--color-text-muted)]">
            They are disabled — no agent can load them until you enable them below.
          </div>
        </div>
      )}

      {skills.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
          No skills yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sortedSkills.map((s) => (
            <div
              key={s.id}
              className={`rounded border bg-[var(--color-bg)] p-3 ${
                s.authoredByZoneId && !s.enabled
                  ? "border-[var(--color-accent)]/40"
                  : "border-[var(--color-border)]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    {!s.enabled && (
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">disabled</span>
                    )}
                    {s.authoredByZoneId && (
                      <span
                        className="rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]"
                        title={`Written by the ${zoneName(s.authoredByZoneId)} zone on ${new Date(s.createdAt * 1000).toLocaleDateString()} — review before enabling`}
                      >
                        written by {zoneName(s.authoredByZoneId)}
                      </span>
                    )}
                  </div>
                  {s.description && <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{s.description}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => toggle(s)}
                    title={s.enabled ? "Enabled — click to remove from the agent catalog" : "Disabled — click to offer to agents"}
                    className={`relative h-5 w-9 rounded-full transition-colors ${s.enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
                  >
                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${s.enabled ? "translate-x-4" : ""}`} />
                  </button>
                  <button onClick={() => { setCreating(null); setEditing(s); }} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Edit</button>
                  <button onClick={() => remove(s)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <SkillPacksSection />
    </div>
  );
}

/**
 * Folder-backed skills (0.9.9). The ecosystem publishes skills as directories —
 * `SKILL.md` plus reference pages and scripts — installed by a CLI rather than
 * pasted in. MultiZone scans for those trees and offers them to agents next to
 * the skills written above; `load_skill` serves the sub-files, so a zone needs
 * no filesystem tools to read one.
 *
 * Read-only by design: the installer owns the tree and its `update` command
 * overwrites it, so an edit made here would vanish on the next update.
 */
function SkillPacksSection() {
  const packs = useApp((s) => s.skillPacks);
  const refreshSkillPacks = useApp((s) => s.refreshSkillPacks);
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const [root, setRoot] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const extraDirs = appSettings.skillPackDirs ?? [];

  useEffect(() => {
    refreshSkillPacks().catch(console.error);
    api.skillPacksRoot().then(setRoot).catch(console.error);
  }, [refreshSkillPacks]);

  async function togglePack(pack: SkillPack) {
    const disabled = appSettings.disabledSkillPacks ?? [];
    const next = pack.enabled
      ? [...disabled, pack.name]
      : disabled.filter((n) => n.toLowerCase() !== pack.name.toLowerCase());
    await setAppSettings({ disabledSkillPacks: next });
    await refreshSkillPacks();
  }

  async function addFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    if (extraDirs.some((d) => d === selected)) return;
    await setAppSettings({ skillPackDirs: [...extraDirs, selected] });
    await refreshSkillPacks();
  }

  async function removeFolder(dir: string) {
    await setAppSettings({ skillPackDirs: extraDirs.filter((d) => d !== dir) });
    await refreshSkillPacks();
  }

  function copy(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  }

  // The install line is the whole point of the help panel, so it carries the
  // real path rather than a placeholder the user has to substitute.
  const installTarget = root || "<skills folder>";

  return (
    <section className="mt-2 border-t border-[var(--color-border)] pt-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Installed skill folders</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => refreshSkillPacks().catch(console.error)}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
            title="Rescan the folders below"
          >
            <RefreshCw size={11} /> Rescan
          </button>
          <button
            onClick={() => setShowHelp((v) => !v)}
            className="rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
          >
            {showHelp ? "Hide setup" : "How to install"}
          </button>
        </div>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Skills published as a folder — <span className="font-mono">SKILL.md</span> plus reference pages
        and scripts — installed by their own CLI. They join the catalog above; edit them where they
        were installed, not here.
      </p>

      {showHelp && (
        <div className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-xs">
          <div className="mb-2 text-[var(--color-text-muted)]">
            Install into MultiZone's skills folder, then hit Rescan. Both of these publish an
            installer to npm; anything that writes a <span className="font-mono">SKILL.md</span> folder works
            the same way.
          </div>
          <div className="mb-1 font-medium">Impeccable (frontend design)</div>
          <CopyLine
            text={`cd "${installTarget}"\nnpx impeccable install -y --providers=claude --scope=project`}
            copied={copied === "impeccable"}
            onCopy={() => copy(`cd "${installTarget}"\nnpx impeccable install -y --providers=claude --scope=project`, "impeccable")}
          />
          <div className="mb-1 mt-3 font-medium">HyperFrames (video composition)</div>
          <CopyLine
            text={`cd "${installTarget}"\nnpx hyperframes skills install`}
            copied={copied === "hyperframes"}
            onCopy={() => copy(`cd "${installTarget}"\nnpx hyperframes skills install`, "hyperframes")}
          />
          <div className="mt-3 text-[var(--color-text-muted)]">
            The installers ask which coding tool you use — the answer only decides which folder name they
            write (<span className="font-mono">.claude/skills/</span>, <span className="font-mono">.agents/skills/</span>, …).
            MultiZone reads all of them, so pick any. You can also point it at a project you have already
            installed into with "Add folder" below, instead of installing twice.
          </div>
          <div className="mt-2 text-[var(--color-text-muted)]">
            Some skills shell out to their own scripts. Those steps only run for a zone that has the
            <span className="font-mono"> Terminal</span> or <span className="font-mono">Code execution</span>{" "}
            tool and a working Node install; without them an agent gets the instructions but not the scripts.
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {root && (
          <button
            onClick={() => api.openPath(root).catch(console.error)}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            title={root}
          >
            <FolderOpen size={12} /> Open skills folder
          </button>
        )}
        <button
          onClick={addFolder}
          className="flex items-center gap-1.5 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> Add folder
        </button>
      </div>

      {extraDirs.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {extraDirs.map((dir) => (
            <div key={dir} className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <Folder size={11} className="shrink-0" />
              <span className="truncate font-mono">{dir}</span>
              <button
                onClick={() => removeFolder(dir)}
                className="ml-auto shrink-0 rounded p-1 hover:text-[var(--color-danger)]"
                title="Stop scanning this folder"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {packs.length === 0 ? (
        <div className="mt-3 rounded border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
          No skill folders found. Install one into the skills folder, or add a folder that already has some.
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {packs.map((pack) => (
            <div key={pack.dir} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{pack.name}</span>
                    {pack.fileCount !== null && (
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                        {pack.fileCount} {pack.fileCount === 1 ? "file" : "files"}
                      </span>
                    )}
                    {!pack.enabled && (
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">disabled</span>
                    )}
                  </div>
                  {pack.description && (
                    <div className="mt-0.5 line-clamp-3 text-xs text-[var(--color-text-muted)]">{pack.description}</div>
                  )}
                  <div className="mt-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]" title={pack.dir}>
                    {pack.dir}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => togglePack(pack)}
                    title={pack.enabled ? "Enabled — click to remove from the agent catalog" : "Disabled — click to offer to agents"}
                    className={`relative h-5 w-9 rounded-full transition-colors ${pack.enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
                  >
                    <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${pack.enabled ? "translate-x-4" : ""}`} />
                  </button>
                  <button
                    onClick={() => api.openPath(pack.dir).catch(console.error)}
                    className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                    title="Open folder"
                  >
                    <FolderOpen size={12} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** A copyable shell snippet in the skill-folder setup panel. */
function CopyLine({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11px]">{text}</pre>
      <button
        onClick={onCopy}
        className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        title="Copy"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  );
}

function SkillEditor({
  skill,
  seed,
  onDone,
  onCancel,
}: {
  skill: Skill | null;
  seed: SkillSeed | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(skill?.name ?? seed?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? seed?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? seed?.content ?? "");
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const refreshSkills = useApp((s) => s.refreshSkills);

  async function onCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.upsertSkill({ id: skill?.id, name: name.trim(), description: description.trim() || null, content, enabled });
      onDone();
    } finally { setSaving(false); }
  }

  // An existing skill saves itself: this is a page of prose you scroll, and a
  // Save button at the bottom of one is a Save button you leave without pressing.
  useEffect(() => {
    if (!skill?.id || !name.trim()) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await api.upsertSkill({ id: skill.id, name: name.trim(), description: description.trim() || null, content, enabled });
        await refreshSkills();
      } catch (e) {
        console.error("skill autosave failed", e);
      } finally { setSaving(false); }
    }, 600);
    return () => clearTimeout(timer);
  }, [skill?.id, name, description, content, enabled]);

  async function onExport() {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "skill";
    // Emit name/description as YAML frontmatter so a skill exported here
    // round-trips intact through importFile() on another machine — previously
    // only `content` was written and the description was lost on import.
    await saveTextFile(`${slug}.md`, serializeSkill(name, description, content), [
      { name: "Markdown", extensions: ["md"] },
    ]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{skill ? "Edit skill" : "New skill"}</h3>
        <button onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">← Back</button>
      </div>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" placeholder="e.g. frontend-design" />
      </label>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">
          Description <span className="ml-1 opacity-60">(the use case that should make an agent load this skill)</span>
        </div>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" placeholder="Use when the user asks to build, design, or review a web UI / frontend component…" />
      </label>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Instructions <span className="ml-1 opacity-60">(freeform markdown, returned when the agent loads the skill)</span></div>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" />
      </label>

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <button
          onClick={() => setEnabled((v) => !v)}
          className={`relative h-5 w-9 rounded-full transition-colors ${enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
        >
          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${enabled ? "translate-x-4" : ""}`} />
        </button>
        <span>Enabled — offered to agents in the skills catalog</span>
      </label>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
        {skill && (
          <button onClick={onExport} className="mr-auto flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
            <FileDown size={12} /> Export
          </button>
        )}
        {skill ? (
          <>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {saving ? "Saving…" : "Changes save as you make them"}
            </span>
            <button onClick={onDone} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Done</button>
          </>
        ) : (
          <>
            <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
            <button onClick={onCreate} disabled={saving || !name.trim()} className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}>
              Create skill
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── MCP (Model Context Protocol) ───────────────────────────────────────────────

const DANGER_META: Record<number, { label: string; cls: string }> = {
  0: { label: "Safe",      cls: "border-green-600/40  bg-green-600/10  text-green-500" },
  1: { label: "Moderate",  cls: "border-yellow-600/40 bg-yellow-600/10 text-yellow-500" },
  2: { label: "Dangerous", cls: "border-red-600/40    bg-red-600/10    text-red-500" },
};

function StatusPill({ status }: { status: McpServerView["status"] }) {
  const meta = {
    connected:   { icon: <Wifi size={11} />,    cls: "border-green-600/40 bg-green-600/10 text-green-500", label: "Connected" },
    error:       { icon: <WifiOff size={11} />,  cls: "border-red-600/40   bg-red-600/10   text-red-500",   label: "Error" },
    disconnected:{ icon: <WifiOff size={11} />,  cls: "border-[var(--color-border)] text-[var(--color-text-muted)]", label: "Disconnected" },
  }[status.state];
  return (
    <span
      title={status.error || undefined}
      className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}
    >
      {meta.icon} {meta.label}
    </span>
  );
}

function McpTab() {
  const mcpServers = useApp((s) => s.mcpServers);
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  const [editing, setEditing] = useState<McpServerView | "new" | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [diagById, setDiagById] = useState<Record<string, McpDiagnosis>>({});

  useEffect(() => { refreshMcpServers().catch(console.error); }, [refreshMcpServers]);

  // The launch autostart connects servers in parallel and reports each one as it
  // settles. Opening this tab while that is still in flight would otherwise show
  // stale "Disconnected" pills that never update.
  useEffect(() => {
    const un = api.onMcpStatusChanged(() => { refreshMcpServers().catch(console.error); });
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [refreshMcpServers]);

  async function connect(s: McpServerView) {
    setBusyId(s.id);
    setErrorById((e) => ({ ...e, [s.id]: "" }));
    try {
      await api.connectMcpServer(s.id);
    } catch (e) {
      setErrorById((prev) => ({ ...prev, [s.id]: String(e) }));
    } finally {
      setBusyId(null);
      await refreshMcpServers();
    }
  }

  async function disconnect(s: McpServerView) {
    await api.disconnectMcpServer(s.id);
    await refreshMcpServers();
  }

  // The diagnosis attempts the handshake itself, so it doubles as a connect —
  // refresh afterwards or the panel would show a stale "disconnected" beside a
  // report that says it connected.
  async function diagnose(s: McpServerView) {
    setBusyId(s.id);
    setErrorById((e) => ({ ...e, [s.id]: "" }));
    try {
      const report = await api.diagnoseMcpServer(s.id);
      setDiagById((d) => ({ ...d, [s.id]: report }));
    } catch (e) {
      setErrorById((prev) => ({ ...prev, [s.id]: String(e) }));
    } finally {
      setBusyId(null);
      await refreshMcpServers();
    }
  }

  async function remove(s: McpServerView) {
    if (!confirm(`Remove MCP server "${s.name}"? Its tools will be unenrolled from every zone.`)) return;
    await api.deleteMcpServer(s.id);
    await refreshMcpServers();
  }

  async function setDanger(toolId: string, level: number) {
    await api.setMcpToolDanger(toolId, level);
    await refreshMcpServers();
  }

  if (editing) {
    return (
      <McpServerEditor
        server={editing === "new" ? null : editing}
        onDone={async () => { setEditing(null); await refreshMcpServers(); }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  if (browsing) {
    return (
      <ConnectorCatalogPanel
        onDone={async () => { setBrowsing(false); await refreshMcpServers(); }}
        onCancel={() => setBrowsing(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="mb-1 text-sm font-medium">MCP servers</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Local commands (stdio) or remote endpoints (SSE/HTTP). Connecting fetches the server's
          tools; give each a danger level here, then enable the ones you want per zone in the zone
          editor. They go through the same approval pipeline as built-in tools.
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Every enabled server connects on launch, so its tools and their descriptions are current
          before the first message. Turn a server off with its own switch to stop it starting;
          <strong> Connect</strong> here is for reconnecting after a change or a failure.
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Prefer the <strong>catalog</strong>: an entry already knows the command and the variables,
          so all it asks you for is the credential.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setBrowsing(true)}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Library size={12} /> Browse catalog
        </button>
        <button
          onClick={() => setEditing("new")}
          className="flex items-center gap-1.5 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> Add manually
        </button>
      </div>

      {mcpServers.length === 0 ? (
        <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
          No MCP servers yet.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {mcpServers.map((s) => (
            <div key={s.id} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
              {/* Five actions and four badges fit a 980px panel and not a phone
                  (0.17.3). Unwrapped, the name column collapsed to nothing and
                  the buttons still ran off the right edge — the screenshot that
                  prompted this had a card showing half a Disconnect button and
                  no server name at all. */}
              <div className="flex items-start justify-between gap-3 narrow:flex-col narrow:items-stretch">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 narrow:flex-wrap">
                    <span className="truncate text-sm font-medium">{s.name}</span>
                    <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]">
                      {s.transport}
                    </span>
                    <StatusPill status={s.status} />
                    {!s.enabled && (
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">disabled</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-[var(--color-text-muted)]">
                    {s.transport === "stdio" ? s.command : s.url}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1 narrow:flex-wrap">
                  <button
                    onClick={() => connect(s)}
                    disabled={busyId === s.id}
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
                  >
                    {busyId === s.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    {s.status.state === "connected" ? "Refresh" : "Connect"}
                  </button>
                  <button
                    onClick={() => diagnose(s)}
                    disabled={busyId === s.id}
                    title="Run the checks in the order they can fail and report the first one that does"
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
                  >
                    <Stethoscope size={11} /> Diagnose
                  </button>
                  {s.status.state === "connected" && (
                    <button onClick={() => disconnect(s)} className="rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Disconnect</button>
                  )}
                  <button onClick={() => setEditing(s)} className="rounded px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Edit</button>
                  <button onClick={() => remove(s)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Delete">
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {errorById[s.id] && (
                <div className="mt-2 rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500">
                  {errorById[s.id]}
                </div>
              )}

              {diagById[s.id] && (
                <DiagnosisPanel
                  diagnosis={diagById[s.id]}
                  onDismiss={() => setDiagById(({ [s.id]: _drop, ...rest }) => rest)}
                />
              )}

              {s.tools.length > 0 && (
                <McpToolList tools={s.tools} onSetDanger={setDanger} />
              )}
              {s.tools.length === 0 && s.status.state === "connected" && (
                <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">This server advertised no tools.</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A server's tools, folded away by default.
 *
 * A connected GitHub server advertises 47 of them, each with a description and
 * a danger dropdown — expanded, one server filled several screens and finding
 * the next one meant scrolling past all of it. The count is on the summary line,
 * which is what you want to know most of the time; the filter appears once the
 * list is long enough that scanning it is the slow part.
 */
function McpToolList({
  tools,
  onSetDanger,
}: {
  tools: McpTool[];
  onSetDanger: (toolId: string, level: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const q = filter.trim().toLowerCase();
  const shown = q
    ? tools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q),
      )
    : tools;

  return (
    <div className="mt-3 border-t border-[var(--color-border)] pt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-[11px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        <ChevronRight size={11} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        Tools ({tools.length})
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {tools.length > 8 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter tools"
              className="input text-xs"
            />
          )}
          {shown.map((t) => (
            <McpToolRow key={t.id} tool={t} onSetDanger={(lvl) => onSetDanger(t.id, lvl)} />
          ))}
          {shown.length === 0 && (
            <div className="py-2 text-center text-[11px] text-[var(--color-text-muted)]">
              Nothing matches “{filter}”.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The report a failed connection should have given in the first place: the
 * checks in the order they can fail, the first false one, and the thing to do
 * about it. The passing checks stay visible — "npx resolved, the key is set,
 * the server itself refused us" is a different problem from "npx is missing",
 * and only the list makes that legible.
 */
function DiagnosisPanel({ diagnosis, onDismiss }: { diagnosis: McpDiagnosis; onDismiss: () => void }) {
  const tone = diagnosis.ok
    ? "border-green-600/40 bg-green-600/10"
    : "border-yellow-600/40 bg-yellow-600/10";
  return (
    <div className={`mt-2 rounded border p-2 text-[11px] ${tone}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">{diagnosis.summary}</div>
        <button onClick={onDismiss} className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]" title="Dismiss">
          <X size={11} />
        </button>
      </div>
      <ul className="mt-1.5 flex flex-col gap-1">
        {diagnosis.checks.map((c) => (
          <li key={c.name} className="flex items-start gap-1.5">
            <span className={c.ok ? "text-green-500" : "text-red-500"}>{c.ok ? "✓" : "✕"}</span>
            <span className="min-w-0">
              <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{c.name}</span>{" "}
              <span className="whitespace-pre-wrap break-words">{c.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      {diagnosis.nextStep && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-1.5">
          <span className="font-medium">Next: </span>{diagnosis.nextStep}
        </div>
      )}
      {diagnosis.docsUrl && (
        <a href={diagnosis.docsUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
          <ExternalLink size={10} /> {diagnosis.docsUrl}
        </a>
      )}
    </div>
  );
}

/**
 * The catalog: pick a connector, fill in the one thing only you have, install.
 *
 * Entries are files rather than code — the shipped ones come with the app, any
 * imported ones live in the connectors folder — so "import from a URL" is the
 * whole extensibility story and widening the set needs no release.
 */
function ConnectorCatalogPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [catalog, setCatalog] = useState<ConnectorCatalog | null>(null);
  const [chosen, setChosen] = useState<ConnectorEntry | null>(null);
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  async function load() {
    try {
      setCatalog(await api.listConnectors());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => { load().catch(console.error); }, []);

  async function runImport() {
    if (!importUrl.trim()) return;
    setImporting(true);
    setError("");
    setNote("");
    try {
      const added = await api.importConnectors({ url: importUrl.trim() });
      setImportUrl("");
      setNote(`Imported ${added.length} ${added.length === 1 ? "entry" : "entries"}: ${added.map((e) => e.name).join(", ")}`);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setImporting(false);
    }
  }

  async function removeEntry(entry: ConnectorEntry) {
    if (!confirm(`Remove the catalog entry "${entry.name}"? Servers already installed from it stay.`)) return;
    try {
      await api.deleteConnector(entry.id);
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  if (chosen) {
    return (
      <ConnectorInstallForm
        entry={chosen}
        alreadyInstalled={Boolean(catalog?.installed[chosen.id])}
        onCancel={() => setChosen(null)}
        onInstalled={onDone}
      />
    );
  }

  const byCategory = new Map<string, ConnectorEntry[]>();
  for (const e of catalog?.entries ?? []) {
    const key = e.category || "Other";
    byCategory.set(key, [...(byCategory.get(key) ?? []), e]);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Connector catalog</h3>
        <button onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">← Back</button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">
        Each entry carries the command or URL, the variables it needs, and a link to the page each
        credential comes from. Installing writes the server and stops — nothing runs or connects
        until you press Connect.
      </p>

      {!catalog ? (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      ) : (
        [...byCategory.entries()].map(([category, entries]) => (
          <section key={category} className="flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{category}</div>
            {entries.map((e) => (
              <div key={e.id} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{e.name}</span>
                      <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-text-muted)]">{e.transport}</span>
                      {catalog.installed[e.id] && (
                        <span className="rounded border border-green-600/40 bg-green-600/10 px-1.5 py-0.5 text-[10px] text-green-500">Installed</span>
                      )}
                      {!e.curated && (
                        <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">imported</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{e.description}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => setChosen(e)}
                      className="rounded border border-[var(--color-border)] px-2 py-1 text-[11px] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
                    >
                      {catalog.installed[e.id] ? "Reinstall" : "Install"}
                    </button>
                    {!e.curated && (
                      <button onClick={() => removeEntry(e)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Remove this catalog entry">
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </section>
        ))
      )}

      <section className="rounded border border-dashed border-[var(--color-border)] p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium"><Download size={12} /> Import entries from a URL</div>
        <p className="mb-2 text-[11px] text-[var(--color-text-muted)]">
          A JSON file holding one entry, a list of them, or an object with an
          <span className="font-mono"> entries </span> array. One sharing an id with a shipped entry
          replaces it.
        </p>
        <div className="flex items-center gap-2">
          <input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://example.com/connectors.json"
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]"
          />
          <button
            onClick={runImport}
            disabled={importing || !importUrl.trim()}
            className={`shrink-0 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
          >
            {importing ? "Importing…" : "Import"}
          </button>
        </div>
      </section>

      {note && <div className="rounded border border-green-600/40 bg-green-600/10 p-2 text-[11px] text-green-500">{note}</div>}
      {error && <div className="rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500">{error}</div>}
    </div>
  );
}

/**
 * One entry's install form: the prerequisites, then only the values the entry
 * says the user has to supply. Everything else the catalog already knows.
 */
function ConnectorInstallForm({
  entry,
  alreadyInstalled,
  onInstalled,
  onCancel,
}: {
  entry: ConnectorEntry;
  alreadyInstalled: boolean;
  onInstalled: () => void;
  onCancel: () => void;
}) {
  const fields: ConnectorField[] = [...(entry.env ?? []), ...(entry.headers ?? [])];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.default ?? ""])),
  );
  const [name, setName] = useState(entry.name);
  const [suffix, setSuffix] = useState("");
  const [replace, setReplace] = useState(alreadyInstalled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const missing = fields.filter((f) => f.required && !values[f.key]?.trim()).map((f) => f.label);

  async function install() {
    setSaving(true);
    setError("");
    try {
      await api.installConnector({
        entryId: entry.id,
        values,
        name: name.trim() || null,
        commandSuffix: suffix.trim() || null,
        replace,
      });
      onInstalled();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Install {entry.name}</h3>
        <button onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">← Back</button>
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">{entry.description}</p>

      {(entry.prerequisites?.length ?? 0) > 0 && (
        <div className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2">
          <div className="mb-1 text-[11px] font-medium">Before this can work</div>
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-[var(--color-text-muted)]">
            {entry.prerequisites?.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      )}

      {entry.docsUrl && (
        <a href={entry.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline">
          <ExternalLink size={11} /> Setup guide
        </a>
      )}

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Name in MultiZone</div>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" />
      </label>

      <div className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2 font-mono text-[11px] text-[var(--color-text-muted)]">
        {entry.transport === "stdio" ? entry.command : entry.url}
      </div>

      {entry.transport === "stdio" && (
        <label className="block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">Extra arguments <span className="opacity-60">(appended to the command)</span></div>
          <input value={suffix} onChange={(e) => setSuffix(e.target.value)} placeholder="e.g. a directory the server may read" className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" />
        </label>
      )}

      {fields.map((f) => (
        <label key={f.key} className="block">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <span>{f.label}</span>
            {!f.required && <span className="opacity-60">(optional)</span>}
            <span className="font-mono opacity-60">{f.key}</span>
          </div>
          <input
            type={f.secret ? "password" : "text"}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
          />
          {f.description && <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">{f.description}</div>}
          {f.credentialUrl && (
            <a href={f.credentialUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--color-accent)] hover:underline">
              <ExternalLink size={10} /> Where to get this
            </a>
          )}
        </label>
      ))}

      {alreadyInstalled && (
        <label className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
          Update the server already installed from this entry, rather than adding a second one
        </label>
      )}

      {error && <div className="rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500">{error}</div>}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
        <button
          onClick={install}
          disabled={saving || missing.length > 0}
          title={missing.length > 0 ? `Still needs: ${missing.join(", ")}` : undefined}
          className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
        >
          {saving ? "Installing…" : "Install"}
        </button>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Credentials are stored with the server in MultiZone's own database, like the rest of your
        settings. Nothing is sent anywhere until you connect.
      </p>
    </div>
  );
}

function McpToolRow({ tool, onSetDanger }: { tool: McpTool; onSetDanger: (level: number) => void }) {
  const [open, setOpen] = useState(false);
  const badge = DANGER_META[tool.dangerLevel] ?? DANGER_META[1];
  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <button onClick={() => setOpen((v) => !v)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-mono text-[11px] font-medium">{tool.name}</span>
            <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>{badge.label}</span>
          </div>
          {tool.description && (
            <div className="mt-0.5 line-clamp-1 text-[var(--color-text-muted)]">{tool.description}</div>
          )}
        </button>
        <select
          value={tool.dangerLevel}
          onChange={(e) => onSetDanger(Number(e.target.value))}
          className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-1 text-[11px] outline-none focus:border-[var(--color-accent)]"
          title="Danger level — drives the approval prompt"
        >
          <option value={0}>Safe</option>
          <option value={1}>Moderate</option>
          <option value={2}>Dangerous</option>
        </select>
      </div>
      {open && (
        <div className="mt-2 border-t border-[var(--color-border)] pt-2">
          {tool.description && <div className="mb-2 text-[var(--color-text-muted)]">{tool.description}</div>}
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Input schema</div>
          <pre className="max-h-40 overflow-auto rounded bg-[var(--color-bg)] p-2 font-mono text-[10px] text-[var(--color-text-muted)]">
            {tool.inputSchema ? prettyJson(tool.inputSchema) : "(none)"}
          </pre>
        </div>
      )}
    </div>
  );
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function McpServerEditor({
  server,
  onDone,
  onCancel,
}: {
  server: McpServerView | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "sse">(server?.transport ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [env, setEnv] = useState(server?.env ?? "");
  const [headers, setHeaders] = useState(server?.headers ?? "");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);

  /** What's wrong with the form as it stands, or null when it can be written. */
  function invalid(): string | null {
    if (!name.trim()) return "A server needs a name.";
    if (transport === "stdio" && !command.trim()) return "A stdio server needs a command.";
    if (transport === "sse" && !url.trim()) return "An SSE/HTTP server needs a URL.";
    if (env.trim()) {
      try { JSON.parse(env); } catch { return "Env must be valid JSON (e.g. {\"API_KEY\":\"…\"})."; }
    }
    if (headers.trim()) {
      try { JSON.parse(headers); } catch { return "Headers must be valid JSON (e.g. {\"Authorization\":\"Bearer …\"})."; }
    }
    return null;
  }

  function payload() {
    return {
      id: server?.id,
      name: name.trim(),
      transport,
      command: transport === "stdio" ? command.trim() : null,
      url: transport === "sse" ? url.trim() : null,
      env: transport === "stdio" ? env.trim() || null : null,
      headers: transport === "sse" ? headers.trim() || null : null,
      enabled,
    };
  }

  async function onCreate() {
    const problem = invalid();
    if (problem) { setError(problem); return; }
    setSaving(true);
    setError("");
    try {
      await api.upsertMcpServer(payload());
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // An existing server saves itself. A half-typed JSON blob is simply not
  // written — the reason says so and the last good version stays on disk.
  useEffect(() => {
    if (!server?.id) return;
    const problem = invalid();
    setError(problem ?? "");
    if (problem) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await api.upsertMcpServer(payload());
        await refreshMcpServers();
      } catch (e) {
        setError(String(e));
      } finally { setSaving(false); }
    }, 600);
    return () => clearTimeout(timer);
  }, [server?.id, name, transport, command, url, env, headers, enabled]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{server ? "Edit MCP server" : "Add MCP server"}</h3>
        <button onClick={onCancel} className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">← Back</button>
      </div>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]" placeholder="e.g. Filesystem" />
      </label>

      <label className="block">
        <div className="mb-1 text-xs text-[var(--color-text-muted)]">Transport</div>
        <SettingSelect value={transport} onChange={(v) => setTransport(v as "stdio" | "sse")}>
          <option value="stdio">stdio (local command)</option>
          <option value="sse">SSE / HTTP (remote URL)</option>
        </SettingSelect>
      </label>

      {transport === "stdio" ? (
        <>
          <label className="block">
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Command</div>
            <input value={command} onChange={(e) => setCommand(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder="npx -y @modelcontextprotocol/server-filesystem ." />
          </label>
          <label className="block">
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Environment variables <span className="opacity-60">(optional JSON)</span></div>
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder='{ "API_KEY": "…" }' />
          </label>
        </>
      ) : (
        <>
          <label className="block">
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">URL</div>
            <input value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder="https://example.com/mcp" />
          </label>
          <label className="block">
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Headers <span className="opacity-60">(optional JSON)</span></div>
            <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={3} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder={'{ "Authorization": "Bearer \u2026" }'} />
            <div className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              Sent with every request. Almost every hosted MCP server wants an
              <span className="font-mono"> Authorization </span> header here; without one it will
              answer 401 and nothing else will work.
            </div>
          </label>
        </>
      )}

      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <button
          onClick={() => setEnabled((v) => !v)}
          className={`relative h-5 w-9 rounded-full transition-colors ${enabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
        >
          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${enabled ? "translate-x-4" : ""}`} />
        </button>
        <span>Enabled — its tools are available to zones</span>
      </label>

      {error && (
        <div className="rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500">{error}</div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] pt-3">
        {server ? (
          <>
            <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">
              {saving ? "Saving…" : "Changes save as you make them"}
            </span>
            <button onClick={onDone} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Done</button>
          </>
        ) : (
          <>
            <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
            <button onClick={onCreate} disabled={saving || !name.trim()} className={`rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}>
              Add server
            </button>
          </>
        )}
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        Click <span className="font-medium">Connect</span> to fetch this server's tools.
      </p>
    </div>
  );
}

// ─── Knowledge (default embedding + global KB) ──────────────────────────────────

function KnowledgeTab() {
  const providers = useApp((s) => s.providers);
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);

  const [kb, setKb] = useState<GlobalKbView | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [docs, setDocs] = useState<KbDocument[]>([]);
  const [showDocs, setShowDocs] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [summary, setSummary] = useState<IndexSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const savedProvider = kb?.providerId ?? null;
  const savedModel = kb?.embeddingModel ?? "";
  const dirty = (providerId ?? null) !== savedProvider || model.trim() !== savedModel;
  const configured = !!savedProvider && !!savedModel;
  const dir = appSettings.defaultDirectory?.trim();

  async function reload() {
    try {
      const view = await api.getGlobalKb();
      setKb(view);
      setProviderId(view.providerId);
      setModel(view.embeddingModel ?? "");
      setDocs(await api.listGlobalKbDocuments());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    reload().catch(console.error);
    const un = api.onKnowledgeUpdated(() => reload().catch(console.error));
    return () => { un.then((f) => f()).catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!providerId) { setModelOptions([]); return; }
    api.fetchModels(providerId)
      .then((m) => { if (!cancelled) setModelOptions(m); })
      .catch(() => { if (!cancelled) setModelOptions([]); });
    return () => { cancelled = true; };
  }, [providerId]);

  async function pickDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") setAppSettings({ defaultDirectory: selected });
  }

  async function saveConfig() {
    setSavingCfg(true);
    setError(null);
    try {
      await api.setGlobalKbConfig(providerId, model.trim() || null);
      await reload();
      setSummary(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingCfg(false);
    }
  }

  async function runIndex() {
    setIndexing(true);
    setError(null);
    setSummary(null);
    try {
      setSummary(await api.indexGlobalKnowledge());
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setIndexing(false);
    }
  }

  async function clearAll() {
    if (!confirm("Remove the entire global knowledge index? The embedding settings are kept.")) return;
    await api.clearGlobalKnowledge();
    await reload();
    setSummary(null);
  }

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="mb-1 text-sm font-medium">Knowledge</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          New projects inherit the default embedding model, and the default directory is indexed
          into a knowledge base that project-less chats search with{" "}
          <code className="rounded bg-[var(--color-bg)] px-1">search_local_files</code>. To keep it
          local, add Ollama as a provider and pick something like{" "}
          <code className="rounded bg-[var(--color-bg)] px-1">nomic-embed-text</code>.
        </p>
      </section>

      {/* Default embedding provider + model */}
      <section>
        <div className="mb-1.5 text-xs font-medium">Default embedding model</div>
        <div className="grid grid-cols-2 narrow:grid-cols-1 gap-2">
          <label className="block">
            <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Provider</div>
            <select value={providerId ?? ""} onChange={(e) => setProviderId(e.target.value || null)} className="input">
              <option value="">— none —</option>
              {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="block">
            <div className="mb-1 text-[11px] text-[var(--color-text-muted)]">Model</div>
            <ModelCombobox
              value={model}
              onChange={setModel}
              options={modelOptions}
              placeholder="e.g. text-embedding-3-small"
              className="input"
              disabled={!providerId}
            />
          </label>
        </div>
        {dirty && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-[11px] text-[var(--color-text-muted)]">
            {/* Not a save button: applying this *discards* the existing index,
                because the vectors belong to the old model's space. It stays an
                explicit press for the same reason a delete does. */}
            <span>Applying this discards the global index — it has to be rebuilt.</span>
            <button onClick={saveConfig} disabled={savingCfg} className={`shrink-0 rounded px-2 py-1 ${PRIMARY_ACTION}`}>
              {savingCfg ? "Applying…" : "Apply & rebuild"}
            </button>
          </div>
        )}
      </section>

      {/* Default directory + global index */}
      <section>
        <div className="mb-1.5 text-xs font-medium">Global knowledge base</div>
        <div className="mb-2 flex items-center gap-2">
          {dir ? (
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
              <FolderOpen size={13} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="truncate font-mono text-xs" title={dir}>{dir}</span>
            </div>
          ) : (
            <span className="flex-1 text-xs text-[var(--color-text-muted)]">No default directory set.</span>
          )}
          <button onClick={pickDir} className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
            <Folder size={12} /> {dir ? "Change" : "Choose"}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={runIndex}
            disabled={indexing || !configured || !dir || dirty}
            title={
              !dir ? "Choose a default directory first."
                : !configured ? "Set an embedding provider and model first."
                : dirty ? "Apply the embedding change first."
                : "Walk the default directory and (re)index it."
            }
            className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
          >
            {indexing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {indexing ? "Indexing…" : (kb && kb.documentCount > 0 ? "Re-index" : "Index directory")}
          </button>
          {kb && kb.documentCount > 0 && (
            <button onClick={clearAll} className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]">
              Clear index
            </button>
          )}
        </div>

        {kb && (
          <div className="mt-2 text-[11px] text-[var(--color-text-muted)]">
            {kb.documentCount > 0
              ? <>{kb.documentCount} document{kb.documentCount === 1 ? "" : "s"} · {kb.chunkCount} chunk{kb.chunkCount === 1 ? "" : "s"}{kb.dimensions ? ` · ${kb.dimensions}-dim` : ""}{kb.indexedAt ? ` · indexed ${new Date(kb.indexedAt).toLocaleString()}` : ""}</>
              : "Not indexed yet."}
          </div>
        )}

        <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs">
          <button
            onClick={() => setAppSettings({ autoReindex: !appSettings.autoReindex })}
            className={`relative h-5 w-9 rounded-full transition-colors ${appSettings.autoReindex ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${appSettings.autoReindex ? "translate-x-4" : ""}`} />
          </button>
          <span>Auto re-index — watch indexed directories and re-embed changed files automatically</span>
        </label>

        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs">
          <button
            onClick={() => setAppSettings({ knowledgeDefaultEnabled: !appSettings.knowledgeDefaultEnabled })}
            className={`relative h-5 w-9 rounded-full transition-colors ${appSettings.knowledgeDefaultEnabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${appSettings.knowledgeDefaultEnabled ? "translate-x-4" : ""}`} />
          </button>
          <span>Enable knowledge in new chats by default — the <code className="rounded bg-[var(--color-bg)] px-1">search_local_files</code> tool is available from the first message (projects can override this)</span>
        </label>

        {summary && (
          <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[11px] text-[var(--color-text-muted)]">
            Indexed {summary.indexed}, unchanged {summary.unchanged}, removed {summary.removed}, failed {summary.failed}
            {summary.totalChunks ? ` · ${summary.totalChunks} new chunks` : ""}.
            {summary.errors.length > 0 && (
              <ul className="mt-1 list-inside list-disc text-[var(--color-danger)]">
                {summary.errors.slice(0, 8).map((e, i) => <li key={i} className="truncate" title={e}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {error && (
          <div className="mt-2 rounded border border-red-600/40 bg-red-600/10 p-2 text-[11px] text-red-500">{error}</div>
        )}

        {docs.length > 0 && (
          <div className="mt-2">
            <button onClick={() => setShowDocs((v) => !v)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              {showDocs ? "Hide" : "Show"} indexed documents ({docs.length})
            </button>
            {showDocs && (
              <div className="mt-1.5 flex max-h-48 flex-col gap-1 overflow-y-auto">
                {docs.map((d) => (
                  <div key={d.id} className="flex items-center justify-between gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-[11px]">
                    <span className="truncate font-mono" title={d.path}>{d.path}</span>
                    <span className="shrink-0 text-[var(--color-text-muted)]">{d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Memory ─────────────────────────────────────────────────────────────────────

function MemoryTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const memories = useApp((s) => s.memories);
  const refreshMemories = useApp((s) => s.refreshMemories);
  const projects = useApp((s) => s.projects);
  const chats = useApp((s) => s.chats);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    refreshMemories().catch(console.error);
    const un = api.onMemoryUpdated(() => refreshMemories().catch(console.error));
    return () => { un.then((f) => f()).catch(() => {}); };
  }, [refreshMemories]);

  const scopeLabel = (m: { scope: string; scopeId: string | null }) => {
    if (m.scope === "global") return "Global";
    if (m.scope === "project") {
      const p = projects.find((x) => x.id === m.scopeId);
      return `Project · ${p?.name ?? "unknown"}`;
    }
    const c = chats.find((x) => x.id === m.scopeId);
    return `Chat · ${c?.title ?? "unknown"}`;
  };

  async function saveEdit(id: string) {
    const m = memories.find((x) => x.id === id);
    if (!m) return;
    await api.upsertMemory({ id, scope: m.scope, scopeId: m.scopeId, content: draft });
    setEditingId(null);
    await refreshMemories();
  }

  async function remove(id: string) {
    await api.deleteMemory(id);
    await refreshMemories();
  }

  const limit = typeof appSettings.memoryScopeLimit === "number" ? appSettings.memoryScopeLimit : 50;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Memory</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Facts the assistant saves with the memory tool, injected into the system prompt each turn
          (global → project → chat). Give a zone the <span className="font-mono">Memory</span> tool to let it write here.
        </p>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--color-text-muted)]">Max entries per scope</span>
          <NumberField value={limit} min={1} onCommit={(v) => setAppSettings({ memoryScopeLimit: v })} />
        </div>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">Oldest entries in a scope are trimmed once it exceeds this.</p>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Stored memories ({memories.length})</h3>
        {memories.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-text-muted)]">
            No memories yet.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {memories.map((m) => (
              <div key={m.id} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                    {scopeLabel(m)}
                  </span>
                  <div className="flex items-center gap-1">
                    {editingId === m.id ? (
                      <>
                        <button onClick={() => saveEdit(m.id)} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-panel-hover)]">Save</button>
                        <button onClick={() => setEditingId(null)} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
                      </>
                    ) : (
                      <button onClick={() => { setEditingId(m.id); setDraft(m.content); }} className="rounded px-2 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Edit</button>
                    )}
                    <button onClick={() => remove(m.id)} className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Delete">
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                {editingId === m.id ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
                  />
                ) : (
                  <div className="text-xs text-[var(--color-text)]">{m.content}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// The Search tab was removed at 0.12.4. It had held no settings since the
// keyless search tools landed at 1.0 — just prose explaining that there was
// nothing to configure, which is not what a Settings pane is for. The tools are
// enabled per zone in the zone editor, and a paid provider is an MCP server.

// ─── API ──────────────────────────────────────────────────────────────────────

function ApiTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);

  const [portInput, setPortInput] = useState(String(appSettings.apiPort ?? 8765));
  const [status, setStatus] = useState<string | null>(null);
  // The last bind outcome, persisted rather than reported once and forgotten
  // (0.11.0). A port already in use used to leave this toggle reading "on" with
  // no server behind it and nothing anywhere that said so.
  const [bind, setBind] = useState<ApiBindState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refreshBind = () => api.apiBindState().then(setBind).catch(console.error);
  useEffect(() => { void refreshBind(); }, []);

  // The address it is *actually* bound to, not the one it used to always be.
  // Falling back to loopback matches what an un-bound server would be if it
  // came up, and never overstates reach.
  const baseUrl = `http://${bind?.address || "127.0.0.1"}:${appSettings.apiPort ?? 8765}`;
  const parsedPort = parseInt(portInput, 10);
  const portInvalid = !Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535;

  // Push the current config to the backend, persist it, and reflect any error.
  //
  // The LAN bind and its address go through here too (0.17.0) rather than
  // through a second command: all of them decide which socket is open, and a
  // panel that could change the bind without restarting the server would be
  // describing a server that does not exist. Settings are persisted only after
  // the restart succeeds, so a refused bind does not leave the panel claiming a
  // configuration the server is not running.
  async function apply(next: {
    apiEnabled?: boolean;
    apiPort?: number;
    apiToken?: string;
    apiLan?: boolean;
    apiBindAddress?: string;
    apiDiscovery?: boolean;
  }) {
    const merged = { ...appSettings, ...next };
    setBusy(true);
    setStatus(null);
    try {
      // Ensure a token exists before enabling. Still generated even in the
      // LAN case: pairing mints per-device tokens, but the static one is what
      // a script on this machine uses and the server refuses to start without.
      if (merged.apiEnabled && !merged.apiToken) {
        merged.apiToken = await api.generateApiToken();
      }
      await api.applyApiSettings(
        merged.apiEnabled,
        merged.apiPort,
        merged.apiToken,
        merged.apiLan,
        merged.apiBindAddress,
        merged.apiDiscovery,
      );
      await setAppSettings({
        apiEnabled: merged.apiEnabled,
        apiPort: merged.apiPort,
        apiToken: merged.apiToken,
        apiLan: merged.apiLan,
        apiBindAddress: merged.apiBindAddress,
        apiDiscovery: merged.apiDiscovery,
      });
      setStatus(merged.apiEnabled ? "Running." : "Stopped.");
      await refreshBind();
    } catch (e: any) {
      setStatus(`Error: ${e?.message || String(e)}`);
      // Roll the toggle back if start failed. Same for the LAN bind: a refused
      // bind that left the switch reading "on the network" would be the exact
      // dishonesty the persisted bind outcome was added to end.
      if (next.apiEnabled) await setAppSettings({ apiEnabled: false });
      if (next.apiLan) await setAppSettings({ apiLan: false });
      await refreshBind();
    } finally {
      setBusy(false);
    }
  }

  async function regenerateToken() {
    const token = await api.generateApiToken();
    await apply({ apiToken: token });
  }

  function commitPort() {
    const p = parseInt(portInput, 10);
    if (!Number.isFinite(p) || p < 1 || p > 65535) {
      setPortInput(String(appSettings.apiPort ?? 8765));
      return;
    }
    if (p !== appSettings.apiPort) apply({ apiPort: p });
  }

  async function copyToken() {
    if (!appSettings.apiToken) return;
    try {
      await navigator.clipboard.writeText(appSettings.apiToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  const curlExample = `curl -N -X POST ${baseUrl}/api/chats/CHAT_ID/messages \\\n  -H "Authorization: Bearer ${appSettings.apiToken || "YOUR_TOKEN"}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"text":"Hello"}'`;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Local HTTP API</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          A REST + SSE API with the same capabilities as the app — chats, zones, projects,
          messages. It listens on 127.0.0.1 only, until you switch on remote access below. Every
          request needs a token.
        </p>
        <div
          onClick={() => !busy && apply({ apiEnabled: !appSettings.apiEnabled })}
          className="flex cursor-pointer items-center justify-between rounded border border-[var(--color-border)] px-3 py-2.5 hover:border-[var(--color-accent)]"
        >
          <span className="text-sm">Enable API server</span>
          <Toggle checked={appSettings.apiEnabled} onChange={(v) => apply({ apiEnabled: v })} />
        </div>
        {status && (
          <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            {busy && <Loader2 size={12} className="animate-spin" />}
            {status}
          </div>
        )}
        {/* The bind outcome as it stands, including from a previous launch —
            "enabled" and "actually listening" are different facts and only one
            of them used to be visible. */}
        {appSettings.apiEnabled && bind && !bind.ok && (
          <div className="mt-2 flex items-start gap-2 rounded border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/5 px-2.5 py-2 text-xs">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
            <span>
              The server is switched on but is not listening on {bind.address}:{bind.port}
              {bind.error ? <>: <span className="font-mono">{bind.error}</span></> : "."}
            </span>
          </div>
        )}
        {appSettings.apiEnabled && bind?.ok && (
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            Listening on <span className="font-mono">{bind.address}:{bind.port}</span>. Ask it
            about itself:{" "}
            <span className="font-mono">GET {baseUrl}/api/health</span> and{" "}
            <span className="font-mono">/api/routes</span> — both answer without a token.
          </p>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Port</h3>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">Base URL: <span className="font-mono">{baseUrl}</span></p>
        <input
          value={portInput}
          onChange={(e) => setPortInput(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => { if (e.key === "Enter") commitPort(); }}
          inputMode="numeric"
          className={`w-40 rounded border bg-[var(--color-panel)] px-2.5 py-1.5 text-sm outline-none ${
            portInvalid ? "border-[var(--color-danger)]" : "border-[var(--color-border)] focus:border-[var(--color-accent)]"
          }`}
          placeholder="8765"
        />
        {portInvalid && (
          <p className="mt-1 text-[11px] text-[var(--color-danger)]">Enter a port between 1 and 65535.</p>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Bearer token</h3>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">
          Send as <span className="font-mono">Authorization: Bearer &lt;token&gt;</span>. Keep it secret.
        </p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={appSettings.apiToken || "— none generated —"}
            className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-1.5 font-mono text-xs outline-none"
          />
          <button
            onClick={copyToken}
            disabled={!appSettings.apiToken}
            className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={regenerateToken}
            disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={busy ? "animate-spin" : ""} /> Regenerate
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Example</h3>
        <pre className="overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)]">
{curlExample}
        </pre>
        <p className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">
          Append <span className="font-mono">?wait=true</span> to get the final message as JSON instead of an SSE stream.
        </p>
      </section>
    </div>
  );
}

// ─── Phone & remote ───────────────────────────────────────────────────────────

/**
 * Its own tab as of 0.17.3.
 *
 * It shipped as a section inside the API panel because that is where it was
 * built — same socket, same `apply`. That is not where anyone looks for it.
 * Somebody connecting a phone is not thinking about REST endpoints, and burying
 * the feature under a developer heading made it findable only by people who did
 * not need it.
 *
 * It still drives the same `apply`, because the LAN bind and the API server are
 * one restart. The tab is a place to stand, not a second mechanism.
 */
function RemoteTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(next: {
    apiEnabled?: boolean;
    apiLan?: boolean;
    apiBindAddress?: string;
    apiDiscovery?: boolean;
  }) {
    const merged = { ...appSettings, ...next };
    setBusy(true);
    setError(null);
    try {
      // Turning on remote access turns on the server it needs. The alternative
      // is an error telling somebody to go and flip a switch on another tab,
      // which is the app refusing to do the obvious thing.
      if (merged.apiLan) merged.apiEnabled = true;
      if (merged.apiEnabled && !merged.apiToken) {
        merged.apiToken = await api.generateApiToken();
      }
      await api.applyApiSettings(
        merged.apiEnabled,
        merged.apiPort,
        merged.apiToken,
        merged.apiLan,
        merged.apiBindAddress,
        merged.apiDiscovery,
      );
      await setAppSettings({
        apiEnabled: merged.apiEnabled,
        apiPort: merged.apiPort,
        apiToken: merged.apiToken,
        apiLan: merged.apiLan,
        apiBindAddress: merged.apiBindAddress,
        apiDiscovery: merged.apiDiscovery,
      });
    } catch (e: any) {
      setError(e?.message || String(e));
      // A refused bind must not leave the switch reading "on the network".
      if (next.apiLan) await setAppSettings({ apiLan: false });
      if (next.apiEnabled) await setAppSettings({ apiEnabled: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="flex items-start gap-2 rounded border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/5 px-2.5 py-2 text-xs">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
          <span>{error}</span>
        </div>
      )}
      <RemoteAccess apply={apply} busy={busy} />
    </div>
  );
}

// ─── Data ─────────────────────────────────────────────────────────────────────

function DataTab() {
  const [stats, setStats] = useState<DbStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);
  const [tokens, setTokens] = useState<LifetimeUsage | null>(null);
  const [resetStage, setResetStage] = useState<"idle" | "confirm" | "resetting">("idle");

  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const refreshChats = useApp((s) => s.refreshChats);
  const setActiveChat = useApp((s) => s.setActiveChat);
  const closeSettings = useApp((s) => s.closeSettings);

  const mirrorOn = appSettings.markdownMirrorEnabled;
  const mirrorDir = appSettings.markdownMirrorDir?.trim() ?? "";
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [mirrorMsg, setMirrorMsg] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  useEffect(() => {
    setLoadingStats(true);
    api.getDbStats().then(setStats).catch(console.error).finally(() => setLoadingStats(false));
    api.lifetimeTokenUsage().then(setTokens).catch(console.error);
  }, []);

  /** Run a full re-mirror, surfacing a short status line. */
  async function runFullMirror() {
    setMirrorBusy(true);
    setMirrorMsg(null);
    try {
      const n = await api.mirrorAllChats();
      setMirrorMsg(`Mirrored ${n} chat${n === 1 ? "" : "s"}.`);
    } catch (e) {
      console.error(e);
      setMirrorMsg("Mirror failed — see console.");
    } finally {
      setMirrorBusy(false);
    }
  }

  async function toggleMirror(on: boolean) {
    await setAppSettings({ markdownMirrorEnabled: on });
    if (on && mirrorDir) await runFullMirror();
  }

  async function pickMirrorDir() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    await setAppSettings({ markdownMirrorDir: selected });
    if (mirrorOn) await runFullMirror();
  }

  async function importMarkdown() {
    const selected = await open({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (typeof selected !== "string") return;
    setImportBusy(true);
    setImportMsg(null);
    try {
      const chat = await api.importChatFromMarkdown(selected);
      await refreshChats();
      setImportMsg(`Imported “${chat.title}”.`);
      await setActiveChat(chat.id);
      closeSettings();
    } catch (e) {
      console.error(e);
      setImportMsg("Import failed — see console.");
    } finally {
      setImportBusy(false);
    }
  }

  async function doReset() {
    setResetStage("resetting");
    try {
      await api.resetDatabase();
    } catch (e) {
      console.error(e);
      setResetStage("idle");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Privacy first, because this tab is where someone comes to find out
          what the app is holding, and the two disclosures below are the ones a
          settings panel is otherwise free to leave unsaid. */}
      <section>
        <h3 className="mb-3 text-sm font-medium">Privacy</h3>
        <div className="flex flex-col gap-2.5 rounded border border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-muted)]">
          <p>
            Everything is on this machine. No account, no telemetry, no analytics, no cloud sync
            — nothing is collected, by anyone. What leaves the machine leaves because you sent a
            message to a cloud model, ran a web search, or connected a service, and each of those
            is listed in the statement.
          </p>
          <p>
            <span className="text-[var(--color-text)]">Provider API keys are stored in plain text</span>{" "}
            in the database below — not encrypted, not in your OS keychain. Anyone who can read
            your user profile can read them, so treat that file as being as sensitive as the keys
            themselves. Moving them to the keychain is scheduled work, not a thing already done.
          </p>
          <PrivacyStatementLink className="self-start" />
        </div>
      </section>

      <UpdateSection />

      {/* Stats */}
      <section>
        <h3 className="mb-3 text-sm font-medium">Database</h3>
        {loadingStats ? (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <Loader2 size={13} className="animate-spin" /> Loading…
          </div>
        ) : stats ? (
          <div className="grid grid-cols-3 gap-2">
            {([
              ["Chats", stats.chats],
              ["Messages", stats.messages],
              ["Zones", stats.zones],
              ["Projects", stats.projects],
              ["Tags", stats.tags],
            ] as const).map(([label, count]) => (
              <div key={label} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-center">
                <div className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{count}</div>
                <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{label}</div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* Lifetime token spend (0.9.14). The chat header's meter answers "what is
          this conversation carrying"; this answers "what has all of it cost",
          which is what the provider's bill is actually a total of. */}
      {tokens && tokens.spent.requests > 0 && (
        <section>
          <h3 className="mb-3 text-sm font-medium">Token usage, all time</h3>
          <div className="grid grid-cols-3 gap-2">
            {([
              ["Input", formatTokens(tokens.spent.inputTokens)],
              ["Output", formatTokens(tokens.spent.outputTokens)],
              ["Total", formatTokens(tokens.spent.totalTokens)],
            ] as const).map(([label, value]) => (
              <div key={label} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-center">
                <div className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
                <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-muted)]">
            <span>
              {formatCount(tokens.spent.requests)} request{tokens.spent.requests === 1 ? "" : "s"}
            </span>
            <span>
              across {formatCount(tokens.chats)} chat{tokens.chats === 1 ? "" : "s"}
            </span>
            {tokens.spent.cachedInputTokens > 0 && (
              // Cached input bills at a fraction of the rate, so the raw total
              // overstates the cost — often by most of it on agentic turns.
              <span>{formatTokens(tokens.spent.cachedInputTokens)} of input served from cache</span>
            )}
          </div>
        </section>
      )}

      {/* Markdown two-way sync (0.7.2) */}
      <section>
        <h3 className="mb-1 text-sm font-medium">Plaintext markdown storage</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Every chat as a real <span className="font-mono">.md</span> file you can read, edit and
          version. The database stays the source of truth, but the sync runs both ways — edits you
          make on disk are pulled back in. Zone configs go alongside as JSON in{" "}
          <span className="font-mono">zones/</span>.
        </p>

        <ToggleRow
          label="Store chats as markdown files"
          description={mirrorDir ? "Files sync two-way with the database." : "Choose an output folder below to start."}
          checked={mirrorOn}
          onChange={toggleMirror}
        />

        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={pickMirrorDir}
            className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <FolderOpen size={13} /> Choose folder…
          </button>
          {mirrorDir ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5">
              <Folder size={12} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="truncate font-mono text-xs" title={mirrorDir}>{mirrorDir}</span>
              <button
                onClick={() => setAppSettings({ markdownMirrorDir: "" })}
                className="ml-auto shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <span className="text-xs text-[var(--color-text-muted)]">No output folder set</span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={runFullMirror}
            disabled={!mirrorOn || !mirrorDir || mirrorBusy}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            title={!mirrorDir ? "Choose a folder first." : "Re-write every chat to the folder now."}
          >
            {mirrorBusy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
            Mirror all chats now
          </button>
          <button
            onClick={importMarkdown}
            disabled={importBusy}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importBusy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
            Import from markdown…
          </button>
          {(mirrorMsg || importMsg) && (
            <span className="text-xs text-[var(--color-text-muted)]">{mirrorMsg ?? importMsg}</span>
          )}
        </div>
      </section>

      <CheckpointStorageSection />

      <SettingsTransferSection />

      {/* Reset */}
      <section>
        <h3 className="mb-1 text-sm font-medium">Reset</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Deletes the database and everything in it. The app exits, and next launch starts fresh.
        </p>

        {resetStage === "idle" && (
          <button
            onClick={() => setResetStage("confirm")}
            className="flex items-center gap-2 rounded border border-[var(--color-danger)] px-4 py-2 text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
          >
            <Trash2 size={14} />
            Reset to fresh install…
          </button>
        )}

        {resetStage === "confirm" && (
          <div className="rounded border border-[var(--color-danger)] bg-[var(--color-danger)]/5 p-4">
            <div className="mb-3 flex items-start gap-2 text-sm">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
              <div>
                <div className="font-medium text-[var(--color-danger)]">This cannot be undone.</div>
                <div className="mt-0.5 text-[var(--color-text-muted)]">
                  All chats, messages, zones, projects, tags, providers and attached files will be permanently deleted. The app will exit immediately after.
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setResetStage("idle")}
                className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Cancel
              </button>
              <button
                onClick={doReset}
                className="rounded bg-[var(--color-danger)] px-3 py-1.5 text-sm text-white hover:opacity-90"
              >
                Yes, delete everything and exit
              </button>
            </div>
          </div>
        )}

        {resetStage === "resetting" && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 size={14} className="animate-spin" /> Deleting… the app will exit shortly.
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Checkpoint storage ───────────────────────────────────────────────────────

/**
 * Retention for the checkpoint store (0.10.0).
 *
 * This is the one part of the app that grows without anybody asking it to:
 * every turn that writes a file adds the prior contents of those files, and
 * until now nothing ever took anything away. The ceiling is a size rather than
 * a count of turns because size is the resource the user actually cares about —
 * one turn that rewrote a 20 MB export costs more disk than two hundred that
 * touched a config file.
 *
 * Both limits also apply automatically (at startup, and after any turn that
 * changed files); the button is here because someone who has just lowered the
 * ceiling wants the number to move now.
 */
function CheckpointStorageSection() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);

  const [usage, setUsage] = useState<CheckpointUsage | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => api.checkpointUsage().then(setUsage).catch(console.error);
  useEffect(() => { void refresh(); }, []);

  async function runPrune() {
    setBusy(true);
    setMsg(null);
    try {
      const out = await api.pruneCheckpoints();
      setMsg(
        out.removedCheckpoints > 0
          ? `Removed ${out.removedCheckpoints} checkpoint${out.removedCheckpoints === 1 ? "" : "s"}, freeing ${formatBytes(out.freedBytes)}.`
          : "Nothing to clean up — the store is already within its limits.",
      );
      await refresh();
    } catch (e) {
      console.error(e);
      setMsg("Clean-up failed — see console.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">File checkpoints</h3>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        A turn's files are kept as they were before it ran, so it can be reverted from the
        transcript. The newest checkpoint survives the limits below, whatever they say — the turn
        that just ran stays revertible.
      </p>

      {usage && (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {([
            ["Turns kept", formatCount(usage.checkpoints)],
            ["Files", formatCount(usage.files)],
            ["On disk", formatBytes(usage.bytes)],
          ] as const).map(([label, value]) => (
            <div key={label} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-center">
              <div className="text-2xl font-semibold tabular-nums text-[var(--color-text)]">{value}</div>
              <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-start gap-6">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-text-muted)]">Size ceiling (MB) — 0 for no limit</span>
          <NumberField
            value={appSettings.checkpointMaxMb}
            min={0}
            max={100_000}
            onCommit={(v) => setAppSettings({ checkpointMaxMb: v })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-[var(--color-text-muted)]">Keep for (days) — 0 to keep forever</span>
          <NumberField
            value={appSettings.checkpointRetentionDays}
            min={0}
            max={3650}
            onCommit={(v) => setAppSettings({ checkpointRetentionDays: v })}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={runPrune}
          disabled={busy}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
          Apply limits now
        </button>
        {msg && <span className="text-xs text-[var(--color-text-muted)]">{msg}</span>}
      </div>
    </section>
  );
}

// ─── Settings transfer (export / import) ──────────────────────────────────────

/**
 * Move a whole MultiZone setup between installs (0.9.9): providers (with keys,
 * optionally), zones, skills, MCP servers, preferences and theme, as one JSON
 * file. Chats stay out of it — the markdown mirror above is the tool for those.
 *
 * Import is two-step on purpose: the file is parsed and its contents summarised
 * before anything is written, so "this overwrites my providers" is visible while
 * it's still cancellable.
 */
function SettingsTransferSection() {
  const appSettings = useApp((s) => s.appSettings);
  const theme = useApp((s) => s.theme);
  const providers = useApp((s) => s.providers);
  const zones = useApp((s) => s.zones);
  const skills = useApp((s) => s.skills);
  const mcpServers = useApp((s) => s.mcpServers);
  const memories = useApp((s) => s.memories);
  const stageImport = useApp((s) => s.stageImport);

  const [sel, setSel] = useState<ExportSelection>(DEFAULT_EXPORT_SELECTION);
  const [customising, setCustomising] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const globalMemoryCount = memories.filter((m) => m.scope === "global").length;

  /** `null` = every row of this kind; an array = exactly those ids. */
  const chosen = (ids: string[] | null, all: { id: string }[]) =>
    ids === null ? all.map((r) => r.id) : ids;

  function toggleRow(key: "providerIds" | "zoneIds" | "skillIds" | "mcpServerIds", all: { id: string }[], id: string) {
    setSel((s) => {
      const current = new Set(chosen(s[key], all));
      if (current.has(id)) current.delete(id); else current.add(id);
      // Collapse back to `null` when everything is selected, so a later-added
      // row is still included in what the user asked for ("all of them").
      return { ...s, [key]: current.size === all.length ? null : [...current] };
    });
  }

  function setAll(key: "providerIds" | "zoneIds" | "skillIds" | "mcpServerIds", all: { id: string }[], on: boolean) {
    setSel((s) => ({ ...s, [key]: on ? null : [] }));
    void all;
  }

  async function doExport() {
    setBusy(true);
    setMsg(null);
    try {
      let version: string | undefined;
      try { version = await getVersion(); } catch { /* not in the Tauri shell */ }
      const bundle = await buildSettingsBundle(appSettings, theme, sel, version);
      const stamp = new Date().toISOString().slice(0, 10);
      const saved = await saveTextFile(
        `multizone-settings-${stamp}.json`,
        serializeSettingsBundle(bundle),
        [{ name: "MultiZone settings", extensions: ["json"] }],
      );
      if (saved) setMsg(`Exported ${describeCounts(bundleCounts(bundle))}.`);
    } catch (e) {
      console.error(e);
      setMsg(`Export failed: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function pickImport() {
    setBusy(true);
    setMsg(null);
    try {
      const picked = await pickBundleFile();
      if (picked) stageImport(picked);
    } catch (e) {
      console.error(e);
      setMsg(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  // Warn before writing a file whose zones point at providers left out of it —
  // they'd land provider-less on the other side.
  const exportedProviderIds = new Set(chosen(sel.providerIds, providers));
  const orphanZones = (sel.zoneIds === null ? zones : zones.filter((z) => sel.zoneIds!.includes(z.id)))
    .filter((z) => z.providerId && !exportedProviderIds.has(z.providerId));

  const nothingSelected =
    chosen(sel.providerIds, providers).length === 0 &&
    chosen(sel.zoneIds, zones).length === 0 &&
    chosen(sel.skillIds, skills).length === 0 &&
    chosen(sel.mcpServerIds, mcpServers).length === 0 &&
    !sel.preferences && !sel.theme && !sel.memories;

  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">Settings backup & transfer</h3>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        Providers, zones, skills, MCP servers, global memories, preferences and theme as one JSON
        file. Chats are not included — the markdown storage above covers those — and neither are
        machine-specific paths or the local API token. Dropping a settings file on the window
        imports it too.
      </p>

      <ToggleRow
        label="Include provider API keys"
        description={
          sel.includeSecrets
            ? "The exported file will contain your API keys in plain text — keep it somewhere safe."
            : "Keys are left out; you'll re-enter them on the other machine."
        }
        checked={sel.includeSecrets}
        onChange={(v) => setSel((s) => ({ ...s, includeSecrets: v }))}
      />

      <button
        onClick={() => setCustomising((v) => !v)}
        className="mt-3 flex items-center gap-1 text-xs text-[var(--color-accent)] hover:underline"
      >
        {customising ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        Choose what to include
      </button>

      {customising && (
        <div className="mt-2 flex flex-col gap-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="flex flex-col gap-1.5">
            <CheckLine
              label="Preferences"
              hint="send key, tool approval, layout, voice…"
              checked={sel.preferences}
              onChange={(v) => setSel((s) => ({ ...s, preferences: v }))}
            />
            <CheckLine
              label="Appearance"
              hint="theme, colours, fonts"
              checked={sel.theme}
              onChange={(v) => setSel((s) => ({ ...s, theme: v }))}
            />
            <CheckLine
              label={`Global memories (${globalMemoryCount})`}
              hint="what the model has remembered about you"
              checked={sel.memories}
              onChange={(v) => setSel((s) => ({ ...s, memories: v }))}
            />
          </div>

          <PickList
            title="Providers" rows={providers} selected={sel.providerIds}
            onToggle={(id) => toggleRow("providerIds", providers, id)}
            onAll={(on) => setAll("providerIds", providers, on)}
          />
          <PickList
            title="Zones" rows={zones} selected={sel.zoneIds}
            onToggle={(id) => toggleRow("zoneIds", zones, id)}
            onAll={(on) => setAll("zoneIds", zones, on)}
          />
          <PickList
            title="Skills" rows={skills} selected={sel.skillIds}
            onToggle={(id) => toggleRow("skillIds", skills, id)}
            onAll={(on) => setAll("skillIds", skills, on)}
          />
          <PickList
            title="MCP servers" rows={mcpServers} selected={sel.mcpServerIds}
            onToggle={(id) => toggleRow("mcpServerIds", mcpServers, id)}
            onAll={(on) => setAll("mcpServerIds", mcpServers, on)}
          />
        </div>
      )}

      {orphanZones.length > 0 && (
        <div className="mt-2 flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <AlertTriangle size={13} className="mt-px shrink-0 text-amber-500" />
          <span>
            {orphanZones.length} selected zone{orphanZones.length === 1 ? "" : "s"} use a provider
            you haven't included ({orphanZones.slice(0, 3).map((z) => z.name).join(", ")}
            {orphanZones.length > 3 ? "…" : ""}). They'll import without a provider unless the other
            install already has one with a matching name.
          </span>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={doExport}
          disabled={busy || nothingSelected}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
          Export settings…
        </button>
        <button
          onClick={pickImport}
          disabled={busy}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
          Import settings…
        </button>
        {msg && <span className="text-xs text-[var(--color-text-muted)]">{msg}</span>}
      </div>
    </section>
  );
}

/** A labelled checkbox row used by the export selector. */
function CheckLine({
  label, hint, checked, onChange,
}: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
      {hint && <span className="text-[var(--color-text-muted)]">— {hint}</span>}
    </label>
  );
}

/**
 * Per-row picker for one collection. `selected === null` means "all", which is
 * kept distinct from "every id happens to be listed" so rows added later stay in.
 */
function PickList({
  title, rows, selected, onToggle, onAll,
}: {
  title: string;
  rows: { id: string; name: string }[];
  selected: string[] | null;
  onToggle: (id: string) => void;
  onAll: (on: boolean) => void;
}) {
  if (rows.length === 0) return null;
  const isOn = (id: string) => selected === null || selected.includes(id);
  const count = selected === null ? rows.length : selected.length;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          {title} ({count}/{rows.length})
        </span>
        <div className="flex gap-2 text-[11px]">
          <button onClick={() => onAll(true)} className="text-[var(--color-accent)] hover:underline">All</button>
          <button onClick={() => onAll(false)} className="text-[var(--color-accent)] hover:underline">None</button>
        </div>
      </div>
      <div className="flex max-h-[120px] flex-col gap-0.5 overflow-y-auto">
        {rows.map((r) => (
          <label key={r.id} className="flex cursor-pointer items-center gap-2 text-xs">
            <input type="checkbox" checked={isOn(r.id)} onChange={() => onToggle(r.id)} />
            <span className="truncate">{r.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Shared components ────────────────────────────────────────────────────────

/** Standard section block: title, optional help text, and consistent spacing. */
function Section({ title, help, children }: { title: string; help?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {help && <p className="mb-3 text-xs text-[var(--color-text-muted)]">{help}</p>}
      {children}
    </section>
  );
}

/** Styled <select> matching the app's input chrome — replaces bare native selects. */
function SettingSelect({
  value, onChange, children, className = "", disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full appearance-none rounded border border-[var(--color-border)] bg-[var(--color-panel)] py-2 pl-3 pr-8 text-sm outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
      >
        {children}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
    </div>
  );
}

/** Labeled toggle row — the shared pattern for an on/off setting with a description. */
/**
 * A group of mutually-exclusive option cards — the settings counterpart to
 * [`ToggleRow`], for a choice with more than two states or one that needs a line
 * of explanation per option.
 *
 * This markup was hand-copied ten times across this file and had drifted in
 * padding and in whether an option could carry a description, so two settings
 * screens away from each other looked subtly different. One component, one look.
 *
 * `layout` is only about shape: `row` for two or three short labels side by
 * side, `column` when the descriptions need the width. `align` centres a row of
 * bare values (a numeric choice) where a label with prose reads better left.
 */
function OptionCards<T extends string | number>({
  value,
  onChange,
  options,
  layout = "row",
  align = "left",
}: {
  value: T;
  onChange: (value: T) => void;
  /** `[value, label]` or `[value, label, description]`. */
  options: readonly (readonly [T, string] | readonly [T, string, string])[];
  layout?: "row" | "column";
  align?: "left" | "center";
}) {
  return (
    <div className={layout === "row" ? "flex flex-wrap gap-2" : "flex flex-col gap-2"}>
      {options.map(([val, label, description]) => (
        <button
          key={val}
          onClick={() => onChange(val)}
          className={`rounded border px-3 py-2.5 text-sm ${
            align === "center" ? "text-center" : "text-left"
          } ${layout === "row" ? "flex-1" : ""} ${
            value === val
              ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]"
              : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
          }`}
        >
          <div className="font-medium">{label}</div>
          {description && (
            <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{description}</div>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The seven categories, in the order someone reads them: what an agent looks
 * at, then what it changes, then what it reaches (0.14.2).
 */
const APPROVAL_CATEGORIES: [ApprovalCategory, string, string][] = [
  ["read", "Read", "Open files, search, list, read memory or another agent's transcript."],
  ["edit", "Edit", "Write, move, copy or delete files."],
  ["shell", "Shell", "Run commands, execute code, drive a terminal."],
  ["web", "Web", "Search, fetch a page, crawl, raw HTTP."],
  ["mcp", "MCP", "Anything served by a connected MCP server."],
  ["spawn", "Sub-agents", "Start a sub-agent or hand it work."],
  ["state", "App state", "Change settings, memories, skills, zones, tags."],
];

/**
 * Three states per category, and the third one matters: *inherit* is not the
 * same as *ask*. An install that never touches this panel has to keep behaving
 * exactly as it did, which means "undecided" has to be representable.
 */
function ApprovalCategoryGrid({
  value,
  onChange,
  compact,
}: {
  value: ApprovalPolicy;
  onChange: (next: ApprovalPolicy) => void;
  compact?: boolean;
}) {
  function set(cat: ApprovalCategory, next: boolean | undefined) {
    const categories = { ...value.categories };
    if (next === undefined) delete categories[cat];
    else categories[cat] = next;
    onChange({ ...value, categories });
  }

  return (
    <div className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
      {APPROVAL_CATEGORIES.map(([cat, label, description]) => {
        const current = value.categories[cat];
        return (
          <div key={cat} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{label}</div>
              {!compact && (
                <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{description}</div>
              )}
            </div>
            <div className="flex shrink-0 overflow-hidden rounded border border-[var(--color-border)] text-[11px]">
              {([
                [undefined, "Inherit"],
                [false, "Ask"],
                [true, "Auto"],
              ] as [boolean | undefined, string][]).map(([state, text]) => (
                <button
                  key={text}
                  onClick={() => set(cat, state)}
                  className={`px-2 py-1 ${
                    current === state
                      ? "bg-[var(--color-accent)] text-white"
                      : "bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A newline-separated prefix list, edited as text because that is how people
 * think about a list of commands. Blank lines are dropped on the way out. */
function PrefixList({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium">{label}</span>
      <textarea
        value={value.join("\n")}
        onChange={(e) =>
          onChange(
            e.target.value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          )
        }
        rows={4}
        spellCheck={false}
        placeholder={placeholder}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]"
      />
    </label>
  );
}

/** Integer input that validates on every keystroke: commits valid values
 *  immediately and highlights invalid ones inline rather than on save. */
function NumberField({
  value, min, max, onCommit, width = "w-24",
}: {
  value: number;
  min: number;
  max?: number;
  onCommit: (v: number) => void;
  width?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);

  const n = parseInt(draft, 10);
  const invalid = !Number.isFinite(n) || n < min || (max !== undefined && n > max);

  return (
    <div>
      <input
        value={draft}
        inputMode="numeric"
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          const v = parseInt(next, 10);
          if (Number.isFinite(v) && v >= min && (max === undefined || v <= max)) onCommit(v);
        }}
        className={`${width} rounded border bg-[var(--color-panel)] px-2 py-1.5 text-sm outline-none ${
          invalid ? "border-[var(--color-danger)]" : "border-[var(--color-border)] focus:border-[var(--color-accent)]"
        }`}
      />
      {invalid && (
        <p className="mt-1 text-[11px] text-[var(--color-danger)]">
          Enter a whole number {max !== undefined ? `between ${min} and ${max}` : `${min} or greater`}.
        </p>
      )}
    </div>
  );
}

/**
 * The provider editor, which saves itself.
 *
 * It used to autosave only once a provider existed, and existing meant having
 * pressed "Add provider" — so a new provider could not be tested until it had
 * been saved, and the one thing you want to do with an endpoint and a key you
 * just typed is find out whether they work. A name and a base URL is enough to
 * be a provider, so as soon as both are filled the row is written and the form
 * carries on editing it. There is no save button in either direction.
 */
function ProviderForm({ value, onClose, onDeleted }: { value: Partial<Provider>; onClose: () => void; onDeleted: () => void }) {
  const refreshProviders = useApp((s) => s.refreshProviders);
  const [id, setId] = useState<string | null>(value.id ?? null);
  const [name, setName] = useState(value.name ?? "");
  const [baseUrl, setBaseUrl] = useState(value.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(value.apiKey ?? "");
  const [defaultModel, setDefaultModel] = useState(value.defaultModel ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);

  // Auto-load the model list when editing an existing provider.
  useEffect(() => {
    if (!value.id) return;
    let cancelled = false;
    setTesting(true);
    setTestResult(null);
    api.fetchModels(value.id)
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setTestResult(`Found ${list.length} model${list.length === 1 ? "" : "s"}.`);
      })
      .catch((e: any) => { if (!cancelled) setTestResult(`Error: ${e?.message || String(e)}`); })
      .finally(() => { if (!cancelled) setTesting(false); });
    return () => { cancelled = true; };
  }, [value.id]);

  // Autosave, debounced past a burst of typing. The first write is what creates
  // a new provider, so `id` is adopted from what comes back.
  useEffect(() => {
    if (!name.trim() || !baseUrl.trim()) return;
    const timer = setTimeout(async () => {
      try {
        const saved = await api.upsertProvider({
          id: id ?? undefined,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || null,
          defaultModel: defaultModel.trim() || null,
        });
        if (!id) setId(saved.id);
        await refreshProviders();
      } catch (e) {
        console.error("provider autosave failed", e);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [name, baseUrl, apiKey, defaultModel, id]);

  async function onDelete() {
    if (id) await api.deleteProvider(id);
    onDeleted();
  }

  async function onTest() {
    if (!id) { setTestResult("Fill in a name and base URL first."); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const list = await api.fetchModels(id);
      setModels(list);
      setTestResult(`Found ${list.length} model${list.length === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setTestResult(`Error: ${e?.message || String(e)}`);
    } finally { setTesting(false); }
  }

  /** Fill the form from a known service, leaving anything the user typed. */
  function applyPreset(p: ProviderPreset) {
    setPresetId(p.id);
    setName(p.name);
    setBaseUrl(p.baseUrl);
    if (p.suggestedModel && !defaultModel.trim()) setDefaultModel(p.suggestedModel);
  }

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? presetForBaseUrl(baseUrl);

  return (
    <div className={value.id ? "" : "mb-4 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3"}>
      {!value.id && (
        <div className="mb-3">
          <div className="mb-1.5 text-xs text-[var(--color-text-muted)]">
            Start from a known service, or fill the fields in yourself.{" "}
            <span className="text-[var(--color-accent)]">Free</span> marks the ones with a standing
            free tier and no card.
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PROVIDER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={`${p.blurb} — ${p.baseUrl}`}
                onClick={() => applyPreset(p)}
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  preset?.id === p.id
                    ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)]"
                    : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
                }`}
              >
                {p.name}
                {p.freeTier && (
                  <span className="ml-1 text-[10px] text-[var(--color-accent)]">free</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Ollama local" />
      </Field>
      <Field label="Base URL">
        <input
          value={baseUrl}
          onChange={(e) => { setPresetId(null); setBaseUrl(e.target.value); }}
          className="input"
          placeholder="http://localhost:11434/v1"
        />
      </Field>
      <Field label={preset && !preset.needsKey ? "API key (not needed for a local server)" : "API key (optional)"}>
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" className="input" placeholder="sk-..." />
      </Field>
      {/* Said where the key is typed rather than only in the privacy statement,
          because this is the moment someone decides whether to paste one. */}
      {apiKey.trim() !== "" && (
        <p className="-mt-1 mb-2 text-[11px] text-[var(--color-text-muted)]">
          Stored in plain text in this app’s local database — not encrypted, not in your OS
          keychain. It never leaves the machine except to the provider above.
        </p>
      )}
      {preset?.keyUrl && (
        <p className="-mt-1 mb-2 text-[11px] text-[var(--color-text-muted)]">
          Get a {preset.name} key at{" "}
          <a
            href={preset.keyUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-accent)] underline underline-offset-2"
          >
            {preset.keyUrl.replace(/^https:\/\//, "")}
          </a>
          {preset.freeTier && ` — ${preset.freeTier}.`}
        </p>
      )}
      <Field label="Default model">
        <ModelCombobox
          value={defaultModel}
          onChange={setDefaultModel}
          options={models}
          className="input"
          placeholder={testing ? "Loading models…" : value.id ? "Pick or type a model" : "Add provider first, or type a model name"}
        />
      </Field>
      {defaultModel.trim() && (
        <Field label="Image input (default model)">
          <VisionOverrideSelect model={defaultModel} />
        </Field>
      )}
      {testResult && (
        <div className="my-2 rounded bg-[var(--color-panel)] p-2 text-xs text-[var(--color-text-muted)]">{testResult}</div>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onDelete} className="flex items-center gap-1 rounded border border-[var(--color-danger)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white">
          <Trash2 size={12} /> {id ? "Delete" : "Discard"}
        </button>
        <button onClick={onTest} disabled={testing} className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50">
          <RefreshCw size={12} className={testing ? "animate-spin" : ""} /> Test
        </button>
        <button onClick={onClose} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]">
          Done
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <div className="mb-1 text-xs text-[var(--color-text-muted)]">{label}</div>
      {children}
    </label>
  );
}

function SliderRow({
  label, value, min, max, step, display, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number; display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs text-[var(--color-text-muted)]">
        <span>{label}</span>
        <span className="tabular-nums">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full"
      />
    </div>
  );
}
