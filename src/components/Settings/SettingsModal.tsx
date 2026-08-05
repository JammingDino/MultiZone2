import { useEffect, useRef, useState } from "react";
import { X, Plus, Trash2, RefreshCw, Server, Palette, MessageSquare, Database, AlertTriangle, Loader2, Folder, FolderOpen, Globe, Copy, Check, Search, Brain, Sparkles, FileUp, FileDown, Plug, Wifi, WifiOff, Library, ChevronDown, ChevronRight, Mic, Volume2, AudioLines } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import type { BackgroundEffect, ThemeColorKey } from "@/store/app";
import { THEME_COLOR_KEYS } from "@/store/app";
import { useShallow } from "zustand/react/shallow";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { VisionOverrideSelect } from "@/components/common/VisionOverrideSelect";
import { Modal, ModalTitle } from "@/components/common/Modal";
import { UpdateSection } from "@/components/Settings/UpdateSection";
import { getVersion } from "@tauri-apps/api/app";
import { saveTextFile } from "@/lib/saveFile";
import { resolveBaseProvider } from "@/lib/baseZone";
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
import type { DbStats, GlobalKbView, IndexSummary, KbDocument, LifetimeUsage, McpServerView, McpTool, Provider, Skill, SkillPack } from "@/lib/types";
import { formatCount, formatTokens } from "@/lib/format";

type Tab = "providers" | "appearance" | "chat" | "voice" | "speech" | "search" | "skills" | "mcp" | "knowledge" | "memory" | "api" | "data";

export function SettingsModal() {
  const closeSettings = useApp((s) => s.closeSettings);
  const [tab, setTab] = useState<Tab>("providers");

  return (
    <Modal onClose={closeSettings} className="h-[620px] w-[820px]" header={<ModalTitle>Settings</ModalTitle>}>
      <style>{`.input { width: 100%; border: 1px solid var(--color-border); border-radius: 4px; padding: 8px 12px; background: var(--color-panel); font-size: 13px; outline: none; } .input:focus { border-color: var(--color-accent); }`}</style>
        <div className="flex flex-1 overflow-hidden">
          <nav className="flex w-44 flex-col gap-0.5 overflow-y-auto border-r border-[var(--color-border)] p-2 text-sm">
            <NavGroup label="Models" />
            <TabButton active={tab === "providers"} icon={<Server size={14} />} label="Providers" onClick={() => setTab("providers")} />

            <NavGroup label="Interface" />
            <TabButton active={tab === "appearance"} icon={<Palette size={14} />} label="Appearance" onClick={() => setTab("appearance")} />
            <TabButton active={tab === "chat"} icon={<MessageSquare size={14} />} label="Chat" onClick={() => setTab("chat")} />
            <TabButton active={tab === "voice"} icon={<Mic size={14} />} label="Dictation" onClick={() => setTab("voice")} />
            <TabButton active={tab === "speech"} icon={<Volume2 size={14} />} label="Speech" onClick={() => setTab("speech")} />

            <NavGroup label="Tools & context" />
            <TabButton active={tab === "search"} icon={<Search size={14} />} label="Search" onClick={() => setTab("search")} />
            <TabButton active={tab === "skills"} icon={<Sparkles size={14} />} label="Skills" onClick={() => setTab("skills")} />
            <TabButton active={tab === "knowledge"} icon={<Library size={14} />} label="Knowledge" onClick={() => setTab("knowledge")} />
            <TabButton active={tab === "memory"} icon={<Brain size={14} />} label="Memory" onClick={() => setTab("memory")} />
            <TabButton active={tab === "mcp"} icon={<Plug size={14} />} label="MCP" onClick={() => setTab("mcp")} />

            <NavGroup label="System" />
            <TabButton active={tab === "api"} icon={<Globe size={14} />} label="API" onClick={() => setTab("api")} />
            <TabButton active={tab === "data"} icon={<Database size={14} />} label="Data" onClick={() => setTab("data")} />
          </nav>
          <div className="flex-1 overflow-y-auto p-4">
            {tab === "providers" && <ProvidersTab />}
            {tab === "appearance" && <AppearanceTab />}
            {tab === "chat" && <ChatTab />}
            {tab === "voice" && <VoiceTab />}
            {tab === "speech" && <SpeechTab />}
            {tab === "search" && <SearchTab />}
            {tab === "skills" && <SkillsTab />}
            {tab === "mcp" && <McpTab />}
            {tab === "knowledge" && <KnowledgeTab />}
            {tab === "memory" && <MemoryTab />}
            {tab === "api" && <ApiTab />}
            {tab === "data" && <DataTab />}
          </div>
        </div>
    </Modal>
  );
}

function NavGroup({ label }: { label: string }) {
  return (
    <div className="mt-3 px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] first:mt-0">
      {label}
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded px-2 py-1.5 text-left ${
        active ? "bg-[var(--color-panel-hover)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Providers ────────────────────────────────────────────────────────────────

function ProvidersTab() {
  const { providers, refreshProviders } = useApp(
    useShallow((s) => ({ providers: s.providers, refreshProviders: s.refreshProviders })),
  );
  const zones = useApp((s) => s.zones);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const [editing, setEditing] = useState<Partial<Provider> | null>(null);

  // There is no separate "default provider" setting (0.9.9) — the base zone in
  // Settings → Chat names one, and that is the provider everything falls back
  // to. Shown here so the Providers list still says which one that is.
  const baseProvider = resolveBaseProvider(providers, zones, baseZoneId);

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">Providers</h3>
        <button
          onClick={() => setEditing({ name: "", baseUrl: "http://localhost:11434/v1", apiKey: "" })}
          className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
        >
          <Plus size={12} /> Add provider
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {providers.map((p) => (
          <div
            key={p.id}
            onClick={() => setEditing(p)}
            className="cursor-pointer rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm hover:border-[var(--color-accent)]"
          >
            <div className="font-medium">{p.name}</div>
            <div className="text-xs text-[var(--color-text-muted)]">{p.baseUrl}</div>
            <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              Default model: {p.defaultModel ? <span className="font-mono">{p.defaultModel}</span> : <span className="italic">none set</span>}
            </div>
          </div>
        ))}
        {providers.length === 0 && (
          <div className="rounded border border-dashed border-[var(--color-border)] p-6 text-center text-xs text-[var(--color-text-muted)]">
            No providers yet. Add one to get started.
          </div>
        )}
      </div>

      {baseProvider && (
        <p className="mt-4 text-xs text-[var(--color-text-muted)]">
          <span className="font-medium text-[var(--color-text)]">{baseProvider.name}</span> is what
          MultiZone falls back to — it's the provider behind your base zone (Settings → Chat), or
          the first provider here when no base zone is set. Change it by pointing your base zone at
          a different provider.
        </p>
      )}

      {editing && (
        <ProviderForm
          value={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { await refreshProviders(); setEditing(null); }}
        />
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
          <label className="ml-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            Custom
            <input
              type="color"
              value={theme.accent}
              onChange={(e) => setTheme({ accent: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
            />
          </label>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">
          Colors · {theme.mode === "light" ? "Light" : "Dark"} mode
        </h3>
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(THEME_COLOR_KEYS) as ThemeColorKey[]).map((key) => {
            const value = overrides[key] ?? base[key];
            const custom = !!overrides[key];
            return (
              <label
                key={key}
                className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5"
              >
                <input
                  type="color"
                  value={value}
                  onChange={(e) => setColor(key, e.target.value)}
                  className="h-6 w-8 shrink-0 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
                />
                <span className="min-w-0 flex-1 truncate text-xs">{COLOR_LABELS[key]}</span>
                {custom && (
                  <button
                    onClick={(e) => { e.preventDefault(); setColor(key, null); }}
                    title="Reset to default"
                    className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  >
                    <X size={11} />
                  </button>
                )}
              </label>
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
        <div className="grid grid-cols-2 gap-4">
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
                  className="shrink-0 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
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
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-medium">Background effect</h3>
        <div className="grid grid-cols-2 gap-4">
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
                  <input
                    type="color"
                    value={theme.effectColor === "accent" ? theme.accent : (theme.effectColor || theme.accent)}
                    onChange={(e) => setTheme({ effectColor: e.target.value })}
                    title="Custom effect color"
                    className="h-7 w-10 cursor-pointer rounded border border-[var(--color-border)] bg-transparent"
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
          Export opens your print dialog: choose “Save as PDF”, set Margins to
          “None” for a single continuous page, and enable “Background graphics”
          so the theme’s colours are drawn.
        </p>

        <div className="mt-4">
          <ToggleRow
            label="Include sub-agent conversations"
            description="Fold the sub-agents a run delegated to into the export, nested under the turns that spawned them and marked throughout as zone-to-zone rather than something you said. Applies to Markdown and PDF."
            checked={appSettings.exportSubchats}
            onChange={(exportSubchats) => setAppSettings({ exportSubchats })}
          />
        </div>
      </section>

    </div>
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
        <h3 className="mb-1 text-sm font-medium">Tool auto-approval</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Dangerous: code execution and shell. Moderate: web search and file access.
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
          Language hint used when images are OCR'd for a model that can't see them
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
            className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
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
            description="The context meter also reports every subagent's context, not just this chat's. Only appears when a chat has subagents."
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
          The mic button's recordings are transcribed by one of your configured providers. Any provider
          exposing an OpenAI-compatible <span className="font-mono">/audio/transcriptions</span> endpoint
          works — OpenAI itself, or a local server like LM Studio serving a whisper model (fully on-device).
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
        <h3 className="mb-1 text-sm font-medium">Language</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          BCP-47-ish language code (e.g. <span className="font-mono">en</span>). Leave empty to auto-detect.
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
          Responses can be spoken by one of your configured providers. Any provider exposing an
          OpenAI-compatible <span className="font-mono">/audio/speech</span> endpoint works — OpenAI itself,
          or a local server (fully on-device).
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
          How many upcoming sentences are synthesized in parallel while the current one plays. Higher
          removes the gap between sentences but sends more concurrent requests to the provider.
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
        Some speech models can clone a voice from a short sample (e.g. a local F5-TTS server); most
        hosted providers (like OpenAI) cannot — they only offer fixed built-in voices. Cloning is
        handled entirely in-app: your reference clip and its transcript are sent with each request, so
        no server-side setup is needed. Enable this only if your speech model supports cloning.
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
                className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
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
              className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
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
        Chain dictation and speech into a continuous loop: after a spoken response finishes, the mic
        starts listening again so you can reply by voice. Speaking interrupts playback (barge-in).
        Requires both a dictation provider and a speech provider above.
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
          Global, on-demand instruction sets. Any zone with the <span className="font-mono">Skills</span> tool
          sees the name + description of every enabled skill and can load its full instructions itself when a
          request matches — like any other tool call. Write the description as the use case that should trigger it.
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
        Skills published as a folder — <span className="font-mono">SKILL.md</span> plus reference pages and
        scripts — installed by their own CLI. They appear in every agent's catalog alongside the skills above,
        and an agent reads the extra files through <span className="font-mono">load_skill</span>, so no
        filesystem access is needed. Edit them where they were installed, not here.
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

  async function onSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.upsertSkill({ id: skill?.id, name: name.trim(), description: description.trim() || null, content, enabled });
      onDone();
    } finally { setSaving(false); }
  }

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
          <button onClick={onExport} className="mr-auto flex items-center gap-1 rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)]">
            <FileDown size={12} /> Export
          </button>
        )}
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
        <button onClick={onSave} disabled={saving || !name.trim()} className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white disabled:opacity-50">
          {skill ? "Save" : "Create skill"}
        </button>
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
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});

  useEffect(() => { refreshMcpServers().catch(console.error); }, [refreshMcpServers]);

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

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="mb-1 text-sm font-medium">MCP servers</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Connect external <span className="font-mono">Model Context Protocol</span> servers — local
          commands (stdio) or remote endpoints (SSE/HTTP). On connect, MultiZone fetches the server's
          tools; set a danger level per tool, then enable specific tools per zone in the zone editor.
          MCP tool calls go through the same approval pipeline as built-in tools.
        </p>
      </section>

      <div>
        <button
          onClick={() => setEditing("new")}
          className="flex items-center gap-1.5 rounded border border-dashed border-[var(--color-border)] px-3 py-1.5 text-xs transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          <Plus size={12} /> Add server
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
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
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
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => connect(s)}
                    disabled={busyId === s.id}
                    className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[11px] hover:border-[var(--color-accent)] disabled:opacity-50"
                  >
                    {busyId === s.id ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                    {s.status.state === "connected" ? "Refresh" : "Connect"}
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

              {s.tools.length > 0 && (
                <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--color-border)] pt-2">
                  <div className="text-[11px] font-medium text-[var(--color-text-muted)]">
                    Tools ({s.tools.length})
                  </div>
                  {s.tools.map((t) => (
                    <McpToolRow key={t.id} tool={t} onSetDanger={(lvl) => setDanger(t.id, lvl)} />
                  ))}
                </div>
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
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function onSave() {
    if (!name.trim()) return;
    if (transport === "stdio" && !command.trim()) { setError("A stdio server needs a command."); return; }
    if (transport === "sse" && !url.trim()) { setError("An SSE/HTTP server needs a URL."); return; }
    if (env.trim()) {
      try { JSON.parse(env); } catch { setError("Env must be valid JSON (e.g. {\"API_KEY\":\"…\"})."); return; }
    }
    setSaving(true);
    setError("");
    try {
      await api.upsertMcpServer({
        id: server?.id,
        name: name.trim(),
        transport,
        command: transport === "stdio" ? command.trim() : null,
        url: transport === "sse" ? url.trim() : null,
        env: env.trim() || null,
        enabled,
      });
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

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
        <label className="block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">URL</div>
          <input value={url} onChange={(e) => setUrl(e.target.value)} className="w-full rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]" placeholder="https://example.com/mcp" />
        </label>
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
        <button onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]">Cancel</button>
        <button onClick={onSave} disabled={saving || !name.trim()} className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white disabled:opacity-50">
          {server ? "Save" : "Add server"}
        </button>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)]">
        After saving, click <span className="font-medium">Connect</span> to fetch this server's tools.
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
          Set a <span className="font-medium">default embedding model</span> — new projects inherit it
          automatically — and index your <span className="font-medium">default directory</span> into a
          global knowledge base that chats without a project can search via the{" "}
          <code className="rounded bg-[var(--color-bg)] px-1">search_local_files</code> tool. For a local
          model, add Ollama as a provider and pick something like{" "}
          <code className="rounded bg-[var(--color-bg)] px-1">nomic-embed-text</code>.
        </p>
      </section>

      {/* Default embedding provider + model */}
      <section>
        <div className="mb-1.5 text-xs font-medium">Default embedding model</div>
        <div className="grid grid-cols-2 gap-2">
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
            <span>Changing the embedding model rebuilds the global index from scratch.</span>
            <button onClick={saveConfig} disabled={savingCfg} className="rounded bg-[var(--color-accent)] px-2 py-1 text-white disabled:opacity-50">
              {savingCfg ? "Saving…" : "Save"}
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
          <button onClick={pickDir} className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)]">
            <Folder size={12} /> {dir ? "Change" : "Choose"}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={runIndex}
            disabled={indexing || !configured || !dir || dirty}
            title={
              !dir ? "Choose a default directory first."
                : !configured ? "Set and save an embedding provider + model first."
                : dirty ? "Save the embedding settings first."
                : "Walk the default directory and (re)index it."
            }
            className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
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

// ─── Search ─────────────────────────────────────────────────────────────────────

function SearchTab() {
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Web search</h3>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">
          The built-in <strong>Search the web</strong> tool queries several independent engines at
          once (DuckDuckGo, Bing, Brave, Yandex, Ecosia, Yahoo, Wikipedia) and merges the results —
          keyless, with nothing to configure here. If one engine is rate-limited, the others still
          answer, so you rarely get a false “no results”. Enable it per zone in the zone editor.
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          Want a paid provider like <strong>Tavily</strong>, Brave, or Serper? Connect their MCP
          server in the <strong>MCP</strong> tab and its search tool becomes available to your zones —
          no key handling here, and you manage it alongside your other integrations.
        </p>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Reading pages</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          <strong>Fetch a page or PDF</strong> reads a result in full as clean markdown, and{" "}
          <strong>Crawl a site</strong> follows links within one site to gather a topic in a single
          call. Both are keyless too. Enable them per zone alongside search.
        </p>
      </section>
    </div>
  );
}

// ─── API ──────────────────────────────────────────────────────────────────────

function ApiTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);

  const [portInput, setPortInput] = useState(String(appSettings.apiPort ?? 8765));
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const baseUrl = `http://127.0.0.1:${appSettings.apiPort ?? 8765}`;
  const parsedPort = parseInt(portInput, 10);
  const portInvalid = !Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535;

  // Push the current config to the backend, persist it, and reflect any error.
  async function apply(next: { apiEnabled?: boolean; apiPort?: number; apiToken?: string }) {
    const merged = { ...appSettings, ...next };
    setBusy(true);
    setStatus(null);
    try {
      // Ensure a token exists before enabling.
      if (merged.apiEnabled && !merged.apiToken) {
        merged.apiToken = await api.generateApiToken();
      }
      await api.applyApiSettings(merged.apiEnabled, merged.apiPort, merged.apiToken);
      await setAppSettings({
        apiEnabled: merged.apiEnabled,
        apiPort: merged.apiPort,
        apiToken: merged.apiToken,
      });
      setStatus(merged.apiEnabled ? `Running on ${`http://127.0.0.1:${merged.apiPort}`}` : "Stopped.");
    } catch (e: any) {
      setStatus(`Error: ${e?.message || String(e)}`);
      // Roll the toggle back if start failed.
      if (next.apiEnabled) await setAppSettings({ apiEnabled: false });
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
          Exposes a local REST + SSE API (bound to 127.0.0.1) so external tools or scripts can
          list and create chats, pick zones/projects, and send messages — the same capabilities as
          the app. Requests must include your bearer token.
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
            className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={regenerateToken}
            disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
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
          Keep every chat as a real <span className="font-mono">.md</span> file you can read, edit, and version
          outside the app. The database stays the source of truth, but the files sync both ways: chats are written
          out as you go, and edits you make to a file on disk (message text, title) are pulled back in. Zone configs
          are written as JSON in a <span className="font-mono">zones/</span> subfolder alongside.
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
            className="flex shrink-0 items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)]"
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
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            title={!mirrorDir ? "Choose a folder first." : "Re-write every chat to the folder now."}
          >
            {mirrorBusy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
            Mirror all chats now
          </button>
          <button
            onClick={importMarkdown}
            disabled={importBusy}
            className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importBusy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
            Import from markdown…
          </button>
          {(mirrorMsg || importMsg) && (
            <span className="text-xs text-[var(--color-text-muted)]">{mirrorMsg ?? importMsg}</span>
          )}
        </div>
      </section>

      <SettingsTransferSection />

      {/* Reset */}
      <section>
        <h3 className="mb-1 text-sm font-medium">Reset</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Permanently deletes the database, all chats, zones, projects, tags, and attachments. The app will exit — on next launch everything starts fresh.
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
                className="rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]"
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
        Save your setup — providers, zones, skills, MCP servers, global memories, preferences and
        theme — as a single JSON file, and import it into another install. Chats aren't included (use
        the markdown storage above for those), and neither are machine-specific paths or the local
        API token, so the other install keeps its own. You can also just drop a settings file onto
        the window at any time.
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
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
          Export settings…
        </button>
        <button
          onClick={pickImport}
          disabled={busy}
          className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
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
    <div className={layout === "row" ? "flex gap-2" : "flex flex-col gap-2"}>
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

function ToggleRow({
  label, description, checked, onChange,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div
      onClick={() => onChange(!checked)}
      className="flex cursor-pointer items-center justify-between gap-3 rounded border border-[var(--color-border)] px-3 py-2.5 hover:border-[var(--color-accent)]"
    >
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {description && <div className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">{description}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={`relative h-5 w-9 flex-shrink-0 rounded-full transition-colors ${checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-200 ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

function ProviderForm({ value, onClose, onSaved }: { value: Partial<Provider>; onClose: () => void; onSaved: () => void }) {
  const refreshProviders = useApp((s) => s.refreshProviders);
  const [name, setName] = useState(value.name ?? "");
  const [baseUrl, setBaseUrl] = useState(value.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(value.apiKey ?? "");
  const [defaultModel, setDefaultModel] = useState(value.defaultModel ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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

  // Autosave for existing providers: debounce 500 ms after any field change.
  useEffect(() => {
    if (!value.id) return;
    if (!name.trim() || !baseUrl.trim()) return;
    const timer = setTimeout(async () => {
      try {
        await api.upsertProvider({
          id: value.id,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim() || null,
          defaultModel: defaultModel.trim() || null,
        });
        await refreshProviders();
      } catch (e) {
        console.error("provider autosave failed", e);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [name, baseUrl, apiKey, defaultModel, value.id]);

  async function onCreate() {
    if (!name.trim() || !baseUrl.trim()) return;
    setSaving(true);
    try {
      await api.upsertProvider({
        id: value.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || null,
        defaultModel: defaultModel.trim() || null,
      });
      onSaved();
    } finally { setSaving(false); }
  }

  async function onDelete() {
    if (!value.id) return;
    await api.deleteProvider(value.id);
    onSaved();
  }

  async function onTest() {
    if (!value.id) { setTestResult("Save the provider first to test models."); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const list = await api.fetchModels(value.id);
      setModels(list);
      setTestResult(`Found ${list.length} model${list.length === 1 ? "" : "s"}.`);
    } catch (e: any) {
      setTestResult(`Error: ${e?.message || String(e)}`);
    } finally { setTesting(false); }
  }

  return (
    <div className="mt-4 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Ollama local" />
      </Field>
      <Field label="Base URL">
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="input" placeholder="http://localhost:11434/v1" />
      </Field>
      <Field label="API key (optional)">
        <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" className="input" placeholder="sk-..." />
      </Field>
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
        {value.id && (
          <button onClick={onDelete} className="flex items-center gap-1 rounded border border-[var(--color-danger)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white">
            <Trash2 size={12} /> Delete
          </button>
        )}
        <button onClick={onTest} disabled={testing} className="flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)] disabled:opacity-50">
          <RefreshCw size={12} className={testing ? "animate-spin" : ""} /> Test
        </button>
        <button onClick={onClose} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs hover:border-[var(--color-accent)]">
          {value.id ? "Done" : "Cancel"}
        </button>
        {!value.id && (
          <button onClick={onCreate} disabled={saving || !name.trim() || !baseUrl.trim()} className="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
            Add provider
          </button>
        )}
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
