import { useEffect, useRef, useState } from "react";
import { X, ChevronDown, ChevronRight } from "lucide-react";
import { useApp } from "@/store/app";
import type { BackgroundEffect, GlassStyle, ThemeColorKey } from "@/store/app";
import { MAX_CUSTOM_CSS, THEME_COLOR_KEYS } from "@/store/app";
import { HexColorField } from "@/components/common/ColorPicker";
import { ToggleRow } from "@/components/common/Toggle";
import { formatCount } from "@/lib/format";
import { OptionCards, SliderRow } from "../controls";

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
        <div className="grid grid-cols-2 narrow:grid-cols-1 gap-x-8">
          {(Object.keys(THEME_COLOR_KEYS) as ThemeColorKey[]).map((key) => {
            const value = overrides[key] ?? base[key];
            const custom = !!overrides[key];
            return (
              <div
                key={key}
                className="flex items-center gap-2 py-1"
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
                <p className="text-[11px] text-[var(--color-text-muted)]">Pick a background effect to see it.</p>
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
