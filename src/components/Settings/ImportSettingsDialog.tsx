import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, FileUp, Loader2, Plus, RefreshCw, SkipForward } from "lucide-react";
import { useApp } from "@/store/app";
import { Modal, ModalTitle } from "@/components/common/Modal";
import {
  applySettingsBundle,
  describeCounts,
  planSettingsImport,
  readLocalSnapshot,
  summarizePlan,
  type ImportPlan,
  type ImportResult,
  type PlanRow,
} from "@/lib/settingsBundle";

/**
 * Confirmation step for a settings import, wherever it was raised from —
 * Settings → Data, the first-run screen, or a settings file dropped onto the
 * window. It reads `pendingImport` from the store, so there is exactly one place
 * that decides what an import does and one dialog that describes it.
 *
 * The point of the preview is to make the *skips* visible. "Import settings"
 * sounds destructive, and the honest answer for most rows is that nothing will
 * happen to them: anything sharing a name with something you already have is
 * left alone. That's much easier to accept when it's counted up front rather
 * than discovered afterwards.
 */
export function ImportSettingsDialog() {
  const pending = useApp((s) => s.pendingImport);
  const clearImport = useApp((s) => s.clearImport);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const setTheme = useApp((s) => s.setTheme);
  const refreshProviders = useApp((s) => s.refreshProviders);
  const refreshZones = useApp((s) => s.refreshZones);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  const refreshMemories = useApp((s) => s.refreshMemories);

  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Reconcile against what's actually here right now — the snapshot has to be
  // read at dialog time, not at pick time, or a provider added in between would
  // be invisible to the plan.
  useEffect(() => {
    if (!pending) {
      setPlan(null);
      setResult(null);
      setPlanError(null);
      return;
    }
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    readLocalSnapshot()
      .then((local) => {
        if (!cancelled) setPlan(planSettingsImport(pending.bundle, local));
      })
      .catch((e) => {
        if (!cancelled) setPlanError(String(e instanceof Error ? e.message : e));
      });
    return () => { cancelled = true; };
  }, [pending]);

  const summary = useMemo(() => (plan ? summarizePlan(plan) : null), [plan]);

  if (!pending) return null;

  async function confirm() {
    if (!plan || !pending) return;
    setBusy(true);
    try {
      const r = await applySettingsBundle(pending.bundle, plan, setAppSettings, setTheme);
      await Promise.all([
        refreshProviders(),
        refreshZones(),
        refreshSkills(),
        refreshMcpServers(),
        refreshMemories(),
      ]);
      setResult(r);
      if (r.failures.length) console.warn("settings import failures", r.failures);
    } catch (e) {
      console.error(e);
      setPlanError(`Import failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  const close = () => { setResult(null); clearImport(); };

  return (
    <Modal
      onClose={busy ? () => {} : close}
      header={<ModalTitle>{result ? "Import complete" : "Import settings"}</ModalTitle>}
      className="w-[560px]"
    >
      <div className="overflow-y-auto px-5 py-4">
        {result ? (
          <ImportOutcome result={result} />
        ) : planError ? (
          <div className="rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-3 text-xs text-[var(--color-danger)]">
            {planError}
          </div>
        ) : !plan || !summary ? (
          <div className="flex items-center gap-2 py-6 text-sm text-[var(--color-text-muted)]">
            <Loader2 size={14} className="animate-spin" />
            Checking what's already here…
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2 text-sm">
              <FileUp size={14} className="text-[var(--color-text-muted)]" />
              <span className="truncate font-medium">{pending.source}</span>
            </div>

            <div className="flex flex-col gap-2">
              <PlanLine
                icon={<Plus size={13} />}
                tone="add"
                label="Added"
                text={describeCounts(summary.created)}
              />
              <PlanLine
                icon={<RefreshCw size={13} />}
                tone="update"
                label="Updated"
                text={describeCounts(summary.updated)}
                hint="matched an existing item by id"
              />
              <PlanLine
                icon={<SkipForward size={13} />}
                tone="skip"
                label="Kept as-is"
                text={describeCounts(summary.skipped)}
                hint="you already have something with this name"
              />
            </div>

            {summary.totalSkipped > 0 && <ConflictList plan={plan} />}

            {plan.unresolvedProviderZones.length > 0 && (
              <div className="mt-3 flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
                <AlertTriangle size={14} className="mt-px shrink-0 text-amber-500" />
                <div>
                  <div className="font-medium">
                    {plan.unresolvedProviderZones.length} zone
                    {plan.unresolvedProviderZones.length === 1 ? "" : "s"} arrive without a provider
                  </div>
                  <div className="mt-0.5 text-[var(--color-text-muted)]">
                    {plan.unresolvedProviderZones.slice(0, 4).join(", ")}
                    {plan.unresolvedProviderZones.length > 4 &&
                      ` and ${plan.unresolvedProviderZones.length - 4} more`}
                    . The export didn't include the provider they point at, and no local provider
                    matches its name — pick one in the zone editor after importing.
                  </div>
                </div>
              </div>
            )}

            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              {plan.includePreferences && plan.includeTheme
                ? "Preferences and theme are applied too. "
                : plan.includePreferences
                ? "Preferences are applied too. "
                : plan.includeTheme
                ? "The theme is applied too. "
                : ""}
              Your chats, projects and local paths are untouched.
              {!pending.bundle.includesSecrets &&
                " This export carries no API keys — you'll need to add them after."}
            </p>
          </>
        )}
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
        {result ? (
          <button
            onClick={close}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white hover:opacity-90"
          >
            Done
          </button>
        ) : (
          <>
            <button
              onClick={close}
              disabled={busy}
              className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={busy || !plan}
              className="flex items-center gap-1.5 rounded bg-[var(--color-accent)] px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Import
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

const TONES = {
  add: "text-emerald-500",
  update: "text-[var(--color-accent)]",
  skip: "text-[var(--color-text-muted)]",
} as const;

function PlanLine({
  icon, tone, label, text, hint,
}: {
  icon: React.ReactNode;
  tone: keyof typeof TONES;
  label: string;
  text: string;
  hint?: string;
}) {
  const empty = text === "nothing";
  return (
    <div className={`flex items-start gap-2 text-xs ${empty ? "opacity-40" : ""}`}>
      <span className={`mt-px shrink-0 ${TONES[tone]}`}>{icon}</span>
      <div>
        <span className="font-medium">{label}: </span>
        <span>{text}</span>
        {hint && !empty && (
          <span className="text-[var(--color-text-muted)]"> — {hint}</span>
        )}
      </div>
    </div>
  );
}

/** Name every skipped row, so "kept as-is" isn't a number the user has to trust. */
function ConflictList({ plan }: { plan: ImportPlan }) {
  const rows: { kind: string; name: string }[] = [];
  const collect = (kind: string, list: PlanRow<{ name: string }>[]) => {
    for (const r of list) if (r.disposition === "skip") rows.push({ kind, name: r.item.name });
  };
  collect("Provider", plan.providers);
  collect("Zone", plan.zones);
  collect("Skill", plan.skills);
  collect("MCP server", plan.mcpServers);
  const skippedMemories = plan.memories.filter((m) => m.disposition === "skip").length;

  return (
    <div className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5">
      <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        Kept as-is
      </div>
      <div className="flex flex-col gap-1">
        {rows.slice(0, 8).map((r, i) => (
          <div key={i} className="flex gap-1.5 text-xs">
            <span className="w-[76px] shrink-0 text-[var(--color-text-muted)]">{r.kind}</span>
            <span className="truncate">{r.name}</span>
          </div>
        ))}
        {rows.length > 8 && (
          <div className="text-xs text-[var(--color-text-muted)]">
            and {rows.length - 8} more
          </div>
        )}
        {skippedMemories > 0 && (
          <div className="text-xs text-[var(--color-text-muted)]">
            {skippedMemories} memor{skippedMemories === 1 ? "y" : "ies"} you already have
          </div>
        )}
      </div>
    </div>
  );
}

function ImportOutcome({ result }: { result: ImportResult }) {
  const wrote = describeCounts(result);
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex items-center gap-2">
        <Check size={15} className="text-emerald-500" />
        <span>{wrote === "nothing" ? "Nothing new to add." : `Imported ${wrote}.`}</span>
      </div>
      {result.skipped > 0 && (
        <div className="text-xs text-[var(--color-text-muted)]">
          {result.skipped} item{result.skipped === 1 ? "" : "s"} left as-is because you already had
          something with the same name.
        </div>
      )}
      {result.unresolvedProviders.length > 0 && (
        <div className="flex gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs">
          <AlertTriangle size={14} className="mt-px shrink-0 text-amber-500" />
          <span>
            No provider could be resolved for: {result.unresolvedProviders.join(", ")}. Open the zone
            editor and pick one before using them.
          </span>
        </div>
      )}
      {result.failures.length > 0 && (
        <div className="rounded border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 p-2.5 text-xs text-[var(--color-danger)]">
          <div className="font-medium">{result.failures.length} item(s) failed to import</div>
          <ul className="mt-1 list-inside list-disc">
            {result.failures.slice(0, 5).map((f, i) => <li key={i} className="truncate">{f}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
