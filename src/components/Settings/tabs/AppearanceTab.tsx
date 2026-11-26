import { useEffect, useRef, useState, type CSSProperties } from "react";
import { X, ChevronDown, ChevronRight, Check } from "lucide-react";
import { useApp } from "@/store/app";
import type { BackgroundEffect, GlassStyle, ThemeColorKey } from "@/store/app";
import { MAX_CUSTOM_CSS, THEME_COLOR_KEYS } from "@/store/app";
import {
  BACKDROPS, BASE_PALETTE, CUSTOM_GRADIENT, THEME_PRESETS, activePreset, backdropImage, presetPalette, presetPrefs,
  type BackdropId, type ThemePreset, type WindowBlur,
} from "@/lib/themes";
import { HexColorField } from "@/components/common/ColorPicker";
import { ToggleRow } from "@/components/common/Toggle";
import { formatCount } from "@/lib/format";
import { OptionCards, SettingSelect, SliderRow } from "../controls";
import { StreamingMarkdown } from "@/components/Renderers/StreamingMarkdown";
import { useThrottledStreaming } from "@/lib/useThrottledStreaming";
import type { AppSettings } from "@/lib/types";

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
  ["frosted", "Frosted", "Blurs what is behind the panes"],
  ["clear", "Clear", "No blur — the background stays sharp"],
  ["tinted", "Tinted", "Frosted, with a touch of your accent colour"],
];

const WINDOW_BLURS: [WindowBlur, string][] = [
  ["blur", "Blurred"],
  ["mica", "Tinted"],
  ["none", "Clear"],
];

/** Effects whose "Density" slider means something. */
const DENSITY_EFFECTS: BackgroundEffect[] = [
  "particles", "orbs", "stars", "shooting", "grid", "waves", "fireflies", "boids",
  "matrix", "topography", "puzzle", "mountains", "fish",
];

/**
 * Appearance (0.20): a theme to start from, what sits behind the panes, a few
 * switches, and the palette and custom CSS folded away under Advanced — the
 * first screen is for picking a look, not for building one.
 */
export function AppearanceTab() {
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

  const active = activePreset(theme);
  const glassStrength = theme.glassStrength ?? 0.5;
  const windowOpacity = theme.windowOpacity ?? 0.85;
  const nothingBehind = (theme.backdrop ?? "solid") === "solid" && theme.backgroundEffect === "none";

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium">Theme</h3>
          {!active && (
            <span className="text-xs text-[var(--color-text-muted)]">Custom — pick one to start over</span>
          )}
        </div>
        <div className="grid grid-cols-3 narrow:grid-cols-2 gap-3">
          {THEME_PRESETS.map((p) => (
            <ThemeCard
              key={p.id}
              preset={p}
              active={active === p.id}
              onPick={() => setTheme({ ...presetPrefs(p), followSystem: false })}
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Background</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Shows between the panes, and through them with glass on.
        </p>
        <BackdropPicker />
        <div className="mt-4 grid grid-cols-2 narrow:grid-cols-1 gap-4">
          <div>
            <div className="mb-1 text-xs text-[var(--color-text-muted)]">Animation</div>
            <SettingSelect
              value={theme.backgroundEffect}
              onChange={(v) => setTheme({ backgroundEffect: v as BackgroundEffect })}
            >
              {BACKGROUND_EFFECTS.map(([val, label]) => (
                <option key={val} value={val}>{label}</option>
              ))}
            </SettingSelect>
          </div>
          {theme.backgroundEffect !== "none" && <EffectControls />}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div>
          <h3 className="mb-2 text-sm font-medium">Light or dark</h3>
          <OptionCards
            value={theme.followSystem ? "system" : theme.mode}
            onChange={(v) => setTheme(v === "system" ? { followSystem: true } : { mode: v, followSystem: false })}
            options={[
              ["dark", "Dark"],
              ["light", "Light"],
              ["system", "Match system"],
            ]}
          />
        </div>

        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Glass"
            description="Panes become frosted glass over the background"
            checked={!!theme.glassEnabled}
            onChange={(v) => setTheme({ glassEnabled: v })}
          />
          {theme.glassEnabled && (
            <div className="ml-3 flex flex-col gap-3 rounded border border-[var(--color-border)] p-3">
              <SliderRow
                label="See-through"
                value={glassStrength}
                min={0.1} max={1} step={0.05}
                display={`${Math.round(glassStrength * 100)}%`}
                onChange={(v) => setTheme({ glassStrength: v })}
              />
              <OptionCards
                value={theme.glassStyle ?? "frosted"}
                onChange={(glassStyle) => setTheme({ glassStyle })}
                options={GLASS_STYLES.map(([v, label]) => [v, label] as const)}
              />
              <p className="text-[11px] text-[var(--color-text-muted)]">
                {nothingBehind
                  ? "Glass shows what is behind the panes — pick a background above to see it."
                  : GLASS_STYLES.find(([v]) => v === (theme.glassStyle ?? "frosted"))?.[2]}
              </p>
            </div>
          )}

          <ToggleRow
            label="See-through window"
            description="Let your desktop show through MultiZone. Text stays solid."
            checked={!!theme.windowTransparent}
            onChange={(v) => setTheme({ windowTransparent: v })}
          />
          {theme.windowTransparent && (
            <div className="ml-3 flex flex-col gap-3 rounded border border-[var(--color-border)] p-3">
              <SliderRow
                label="Opacity"
                value={windowOpacity}
                min={0.3} max={1} step={0.05}
                display={`${Math.round(windowOpacity * 100)}%`}
                onChange={(v) => setTheme({ windowOpacity: v })}
              />
              <div>
                <div className="mb-1.5 text-xs text-[var(--color-text-muted)]">What is behind the window</div>
                <OptionCards
                  value={theme.windowBlur ?? "blur"}
                  onChange={(windowBlur) => setTheme({ windowBlur })}
                  options={WINDOW_BLURS}
                />
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Blurred and Tinted are drawn by Windows; Tinted needs Windows 11 and shows your wallpaper's colour rather than the windows behind.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Everything past the everyday choices above: one fold, closed. */}
      <Advanced>
        <section>
          <h3 className="mb-2 text-sm font-medium">Accent colour</h3>
          <div className="flex flex-wrap items-center gap-2">
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c}
                onClick={() => setTheme({ accent: c })}
                className={`h-7 w-7 rounded-full border-2 ${theme.accent.toLowerCase() === c.toLowerCase() ? "border-[var(--color-text)]" : "border-transparent"}`}
                style={{ background: c }}
                title={c}
              />
            ))}
            <div className="ml-2 flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
              Any colour
              <HexColorField
                value={theme.accent}
                onChange={(accent) => setTheme({ accent })}
                title="Custom accent colour"
              />
            </div>
          </div>
        </section>

        <ToggleRow
          label="Shadows"
          description="Soft shadows under menus, dialogs and floating panes"
          checked={!!theme.shadowsEnabled}
          onChange={(v) => setTheme({ shadowsEnabled: v })}
        />

        <PaletteSection />

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

        <StreamingSection />

        <section>
          <h3 className="mb-3 text-sm font-medium">Zone layout</h3>
          <OptionCards
            value={appSettings.zoneLayout}
            onChange={(zoneLayout) => setAppSettings({ zoneLayout })}
            options={[
              ["chronological", "Chronological", "One column, in the order the replies arrived."],
              ["stacked", "Stacked", "One column, the chat's own zone first."],
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
          <p className="mt-3 text-xs text-[var(--color-text-muted)]">For one page: Margins “None”, Background graphics on.</p>

          <div className="mt-4 flex flex-col gap-3">
            <ToggleRow
              label="Include sub-agent conversations"
              description="Nested under the turns that spawned them."
              checked={appSettings.exportSubchats}
              onChange={(exportSubchats) => setAppSettings({ exportSubchats })}
            />
            <ToggleRow
              label="Append the session log"
              description="Every turn and tool, timed. PDF only."
              checked={appSettings.pdfExportSessionLog}
              onChange={(pdfExportSessionLog) => setAppSettings({ pdfExportSessionLog })}
            />
          </div>
        </section>

        <CustomCssSection />
      </Advanced>
    </div>
  );
}

/**
 * A built-in theme as a little window in its own colours: the backdrop, a
 * sidebar and a chat pane, glass where the theme has it.
 */
function ThemeCard({ preset, active, onPick }: { preset: ThemePreset; active: boolean; onPick: () => void }) {
  const c = presetPalette(preset);
  const prefs = presetPrefs(preset);
  const pane = (col: string) => (prefs.glassEnabled ? `color-mix(in srgb, ${col} 60%, transparent)` : col);
  const paneStyle = (col: string): CSSProperties => ({
    background: pane(col),
    boxShadow: `0 0 0 1px ${prefs.glassEnabled ? `color-mix(in srgb, ${c.text} 14%, transparent)` : c.border}`,
    backdropFilter: prefs.glassEnabled ? "blur(6px) saturate(1.5)" : undefined,
  });
  const line = (w: string, col: string) => <div className="h-[3px] rounded-full" style={{ width: w, background: col }} />;
  return (
    <button
      onClick={onPick}
      aria-pressed={active}
      className={`flex flex-col gap-1.5 rounded-lg p-1.5 text-left transition-shadow ${
        active ? "ring-2 ring-[var(--color-accent)]" : "ring-1 ring-[var(--color-border)] hover:ring-[var(--color-text-muted)]"
      }`}
    >
      <div
        className="relative h-[76px] w-full overflow-hidden rounded-md"
        style={{
          backgroundColor: c.bg,
          backgroundImage: backdropImage(prefs),
          "--color-accent": c.accent,
          "--mz-glow": prefs.mode === "light" ? "55%" : "60%",
        } as CSSProperties}
      >
        <div className="absolute inset-x-[5px] bottom-[5px] top-[13px] flex gap-[4px]">
          <div className="flex w-[30%] flex-col gap-[5px] rounded-[4px] p-[6px]" style={paneStyle(c.panel)}>
            {line("80%", c.textMuted)}
            {line("60%", c.textMuted)}
            {line("70%", c.textMuted)}
          </div>
          <div className="relative flex flex-1 flex-col gap-[5px] rounded-[4px] p-[6px]" style={paneStyle(c.bg)}>
            {line("85%", c.text)}
            {line("65%", c.text)}
            {line("40%", c.textMuted)}
            <div className="absolute bottom-[5px] right-[6px] h-[7px] w-[16px] rounded-full" style={{ background: c.accent }} />
          </div>
        </div>
      </div>
      <span className="flex items-center justify-between gap-1 px-0.5 text-xs">
        <span className="truncate">{preset.name}</span>
        {active && <Check size={12} className="shrink-0 text-[var(--color-accent)]" />}
      </span>
    </button>
  );
}

/** The backdrop: plain, a built-in gradient, or two colours of your own. */
function BackdropPicker() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const current = theme.backdrop ?? "solid";
  const from = theme.backdropFrom || CUSTOM_GRADIENT.from;
  const to = theme.backdropTo || CUSTOM_GRADIENT.to;
  const angle = theme.backdropAngle ?? CUSTOM_GRADIENT.angle;
  const pick = (backdrop: BackdropId) =>
    setTheme(backdrop === "custom" ? { backdrop, backdropFrom: from, backdropTo: to, backdropAngle: angle } : { backdrop });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 narrow:grid-cols-2 gap-2">
        {BACKDROPS.map((b) => (
          <button
            key={b.id}
            onClick={() => pick(b.id)}
            aria-pressed={current === b.id}
            className={`flex flex-col gap-1 rounded-md p-1 text-left text-[11px] ${
              current === b.id ? "ring-2 ring-[var(--color-accent)]" : "ring-1 ring-[var(--color-border)] hover:ring-[var(--color-text-muted)]"
            }`}
          >
            <div
              className="h-9 w-full rounded"
              style={{
                backgroundColor: "var(--color-bg)",
                backgroundImage: backdropImage({ backdrop: b.id, backdropFrom: from, backdropTo: to, backdropAngle: angle }),
              }}
            />
            <span className="truncate px-0.5">{b.label}</span>
          </button>
        ))}
      </div>
      {current === "custom" && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            From
            <HexColorField value={from} onChange={(backdropFrom) => setTheme({ backdropFrom })} title="Gradient start" />
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            To
            <HexColorField value={to} onChange={(backdropTo) => setTheme({ backdropTo })} title="Gradient end" />
          </div>
          <div className="min-w-[200px] flex-1">
            <SliderRow
              label="Direction"
              value={angle}
              min={0} max={360} step={15}
              display={`${angle}°`}
              onChange={(backdropAngle) => setTheme({ backdropAngle })}
            />
          </div>
        </div>
      )}
      {current !== "solid" && (
        <ToggleRow
          label="Slowly drift"
          description="The gradient moves, very gently"
          checked={!!theme.backdropMotion}
          onChange={(backdropMotion) => setTheme({ backdropMotion })}
        />
      )}
    </div>
  );
}

/** The tuning for the animated layer, once one is chosen. */
function EffectControls() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const grid = theme.backgroundEffect === "grid";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
        Colour
        <button
          onClick={() => setTheme({ effectColor: "accent" })}
          className={`rounded border px-2.5 py-1 text-xs ${
            theme.effectColor === "accent"
              ? "border-[var(--color-accent)] bg-[var(--color-panel-hover)] text-[var(--color-text)]"
              : "border-[var(--color-border)] hover:border-[var(--color-accent)]"
          }`}
        >
          Accent
        </button>
        <HexColorField
          // Following the accent is a mode, not a colour, so the field sits
          // empty there rather than showing an accent value that isn't stored.
          value={theme.effectColor === "accent" ? null : (theme.effectColor || null)}
          fallback={theme.accent}
          onChange={(effectColor) => setTheme({ effectColor })}
          title="Custom effect colour"
        />
      </div>
      <SliderRow
        label="Speed"
        value={theme.effectSpeed}
        min={0.1} max={3} step={0.1}
        display={`${theme.effectSpeed.toFixed(1)}×`}
        onChange={(v) => setTheme({ effectSpeed: v })}
      />
      {DENSITY_EFFECTS.includes(theme.backgroundEffect) && (
        <SliderRow
          label={grid ? "Scale" : "Amount"}
          value={theme.effectDensity}
          min={grid ? 15 : 10}
          max={grid ? 150 : 200}
          step={5}
          display={grid ? `${theme.effectDensity}px` : String(theme.effectDensity)}
          onChange={(v) => setTheme({ effectDensity: v })}
        />
      )}
      <SliderRow
        label="Strength"
        value={theme.effectOpacity}
        min={0.05} max={1} step={0.05}
        display={`${Math.round(theme.effectOpacity * 100)}%`}
        onChange={(v) => setTheme({ effectOpacity: v })}
      />
      <SliderRow
        label="Colour variety"
        value={theme.effectHue ?? 0}
        min={0} max={180} step={5}
        display={(theme.effectHue ?? 0) === 0 ? "Off" : `±${theme.effectHue}°`}
        onChange={(v) => setTheme({ effectHue: v })}
      />
    </div>
  );
}

/**
 * Everything past the everyday choices — the accent, every colour, fonts,
 * streaming, layout, export, custom CSS — folded away until asked for, so the
 * tab opens on picking a look rather than on building one.
 */
function Advanced({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-sm font-medium hover:text-[var(--color-accent)]"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        Advanced
        <span className="ml-1 text-xs font-normal text-[var(--color-text-muted)]">
          Accent, every colour, fonts, text streaming, layout, export, custom CSS
        </span>
      </button>
      {open && <div className="mt-4 flex flex-col gap-6">{children}</div>}
    </section>
  );
}

/** The palette, colour by colour, for the mode on screen. */
function PaletteSection() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);

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
    <section>
      <h3 className="mb-2 text-sm font-medium">
        Colours · {theme.mode === "light" ? "Light" : "Dark"} mode
      </h3>
      {/* Two columns rather than three: each cell carries an editable hex
          alongside its swatch, and a colour you can read is worth more
          than a grid one row shorter. */}
      <div className="grid grid-cols-2 narrow:grid-cols-1 gap-x-8">
        {(Object.keys(THEME_COLOR_KEYS) as ThemeColorKey[]).map((key) => {
          const value = overrides[key] ?? base[key];
          const custom = !!overrides[key];
          return (
            <div key={key} className="flex items-center gap-2 py-1">
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
      {Object.keys(overrides).length > 0 && (
        <div className="mt-1.5 flex justify-end">
          <button
            onClick={() => setTheme({ [paletteKey]: {} })}
            className="text-[10px] text-[var(--color-text-muted)] underline hover:text-[var(--color-accent)]"
          >
            Reset all
          </button>
        </div>
      )}
    </section>
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
            description="Off restores the stock look."
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

// ─── Streaming text (0.18.3) ──────────────────────────────────────────────────

const SAMPLE =
  "Models rarely write at an even pace. Tokens arrive in bursts — a whole clause at once, then a pause " +
  "while the next one is decided. **Smoothing** spreads those bursts out, and the animation decides how " +
  "each new piece lands. Adjust the settings and replay to see the difference.";

/** How streamed answers arrive: pacing, unit, and the animation each piece gets. */
function StreamingSection() {
  const settings = useApp((s) => s.appSettings);
  const set = useApp((s) => s.setAppSettings);
  const animation = settings.streamAnimation ?? "fade";
  const smoothing = settings.streamSmoothingMs ?? 0;
  const ms = settings.streamAnimationMs ?? 250;

  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">Streaming text</h3>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">How an answer appears as the model writes it.</p>
      <div className="grid grid-cols-2 narrow:grid-cols-1 gap-4">
        <label className="block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">Animation</div>
          <SettingSelect
            value={animation}
            onChange={(v) => set({ streamAnimation: v as AppSettings["streamAnimation"] })}
          >
            <option value="none">None</option>
            <option value="fade">Fade in</option>
            <option value="rise">Rise</option>
            <option value="blur">Blur in</option>
            <option value="grow">Grow</option>
          </SettingSelect>
        </label>
        <label className="block">
          <div className="mb-1 text-xs text-[var(--color-text-muted)]">Reveal by</div>
          <SettingSelect
            value={settings.streamUnit ?? "adaptive"}
            onChange={(v) => set({ streamUnit: v as AppSettings["streamUnit"] })}
          >
            <option value="char">Character</option>
            <option value="word">Whole word</option>
            <option value="adaptive">Adaptive — words when it is fast</option>
          </SettingSelect>
        </label>
        <SliderRow
          label="Smoothing"
          value={smoothing}
          min={0} max={1000} step={50}
          display={smoothing === 0 ? "Off" : `${smoothing} ms`}
          onChange={(v) => set({ streamSmoothingMs: v })}
        />
        <SliderRow
          label="Animation length"
          value={ms}
          min={50} max={1000} step={25}
          display={animation === "none" ? "—" : `${ms} ms`}
          onChange={(v) => set({ streamAnimationMs: v })}
        />
      </div>
      <StreamPreview />
    </section>
  );
}

/**
 * The settings above, applied to a sample streamed the way a model streams:
 * uneven bursts with pauses between them.
 */
function StreamPreview() {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let i = 0;
    let t: number;
    setText("");
    setStreaming(true);
    const next = () => {
      // Bursts of 1–24 characters, 20–220 ms apart: the jitter smoothing is for.
      i = Math.min(SAMPLE.length, i + 1 + Math.floor(Math.random() * 24));
      setText(SAMPLE.slice(0, i));
      if (i < SAMPLE.length) t = window.setTimeout(next, 20 + Math.random() * 200);
      else setStreaming(false);
    };
    t = window.setTimeout(next, 300);
    return () => window.clearTimeout(t);
  }, [run]);

  const visible = useThrottledStreaming(text, streaming);
  const live = streaming || visible !== text;
  const settings = useApp((s) => s.appSettings);
  const animation = settings.streamAnimation ?? "none";
  const ms = settings.streamAnimationMs ?? 250;

  return (
    <div className="mt-3">
      <div className="min-h-[5.5rem] rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
        <StreamingMarkdown
          source={visible}
          reveal={live && animation !== "none" ? { unit: settings.streamUnit ?? "char", animation, ms } : undefined}
        />
      </div>
      <button
        onClick={() => setRun((n) => n + 1)}
        className="mt-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        Replay
      </button>
    </div>
  );
}
