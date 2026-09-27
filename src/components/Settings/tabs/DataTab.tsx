import { useEffect, useState } from "react";
import { X, Trash2, Database, AlertTriangle, Loader2, Folder, FolderOpen, FileUp, FileDown, ChevronDown, ChevronRight } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { UpdateSection } from "@/components/Settings/UpdateSection";
import { ToggleRow } from "@/components/common/Toggle";
import { PrivacyStatementLink } from "@/components/common/PrivacyStatement";
import { getVersion } from "@tauri-apps/api/app";
import { saveTextFile } from "@/lib/saveFile";
import { DEFAULT_EXPORT_SELECTION, type ExportSelection, buildSettingsBundle, bundleCounts, describeCounts, serializeSettingsBundle } from "@/lib/settingsBundle";
import { pickBundleFile } from "@/lib/importSettings";
import type { CheckpointUsage, DbStats, LifetimeUsage, Provider } from "@/lib/types";
import { formatBytes, formatCount, formatTokens } from "@/lib/format";
import { errorText } from "@/lib/errors";
import { reportError } from "@/lib/reportError";
import { CheckLine, NumberField, PickList } from "../controls";

export function DataTab() {
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
    api.getDbStats().then(setStats).catch(reportError("Couldn't read storage usage")).finally(() => setLoadingStats(false));
    api.lifetimeTokenUsage().then(setTokens).catch(reportError("Couldn't read token usage"));
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
      setMirrorMsg(`Mirror failed. ${errorText(e)}`);
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
      setImportMsg(`Import failed. ${errorText(e)}`);
    } finally {
      setImportBusy(false);
    }
  }

  async function doReset() {
    setResetStage("resetting");
    try {
      await api.resetDatabase();
    } catch (e) {
      reportError("Couldn't reset the database")(e);
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

  const refresh = () => api.checkpointUsage().then(setUsage).catch(reportError("Couldn't read checkpoint usage"));
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
      setMsg(`Clean-up failed. ${errorText(e)}`);
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
      setMsg(`Export failed. ${errorText(e)}`);
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
      setMsg(errorText(e));
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
