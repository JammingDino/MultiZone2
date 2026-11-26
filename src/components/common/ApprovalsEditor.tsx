import type { ApprovalCategory, ApprovalPolicy, PlanEntry } from "@/lib/types";

/** Override categories, short labels — the long descriptions live in
 * Settings, where the global policy is set and explained. */
const CATEGORIES: [ApprovalCategory, string][] = [
  ["read", "Read"],
  ["edit", "Edit"],
  ["shell", "Shell"],
  ["web", "Web"],
  ["mcp", "MCP"],
  ["spawn", "Sub-agents"],
  ["state", "App state"],
];

/**
 * Approval overrides for one zone or project: Inherit / Ask / Auto per
 * category, and the shell and edit lists. Shared so a zone and a project — the
 * two places overrides live — cannot drift into different editors. The
 * plan-entry row is the project's only (see `approvals::Policy::load`).
 */
export function ApprovalsEditor({
  value,
  onChange,
  withPlanEntry = false,
}: {
  value: ApprovalPolicy;
  onChange: (update: (p: ApprovalPolicy) => ApprovalPolicy) => void;
  withPlanEntry?: boolean;
}) {
  return (
    <>
      <div className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)]">
        {CATEGORIES.map(([cat, label]) => {
          const current = value.categories[cat];
          return (
            <div key={cat} className="flex items-center gap-3 px-2 py-1.5">
              <span className="min-w-0 flex-1 text-xs">{label}</span>
              <div className="flex shrink-0 overflow-hidden rounded border border-[var(--color-border)] text-[11px]">
                {([
                  [undefined, "Inherit"],
                  [false, "Ask"],
                  [true, "Auto"],
                ] as [boolean | undefined, string][]).map(([state, text]) => (
                  <button
                    key={text}
                    type="button"
                    onClick={() =>
                      onChange((p) => {
                        const categories = { ...p.categories };
                        if (state === undefined) delete categories[cat];
                        else categories[cat] = state;
                        return { ...p, categories };
                      })
                    }
                    className={`px-2 py-0.5 ${
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
        {withPlanEntry && (
          <label className="flex items-center gap-3 px-2 py-1.5">
            <span className="min-w-0 flex-1 text-xs">Model enters plan mode</span>
            <select
              value={value.planEntry ?? ""}
              onChange={(e) => {
                const planEntry = (e.target.value || undefined) as PlanEntry | undefined;
                onChange((p) => ({ ...p, planEntry }));
              }}
              className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1 py-0.5 text-[11px]"
            >
              <option value="">Inherit</option>
              <option value="auto">By itself</option>
              <option value="ask">After asking</option>
              <option value="manual">Never (only /plan)</option>
            </select>
          </label>
        )}
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {([
          ["shellAllow", "Run without asking", "npm run test"],
          ["shellDeny", "Never run", "git push"],
          ["editAllow", "Edit without asking", "{project}"],
          ["editDeny", "Never edit", "{project}/.git"],
        ] as ["shellAllow" | "shellDeny" | "editAllow" | "editDeny", string, string][]).map(([key, label, placeholder]) => (
          <label key={key} className="block">
            <span className="mb-1 block text-[11px] font-medium">{label}</span>
            <textarea
              value={value[key].join("\n")}
              onChange={(e) =>
                onChange((p) => ({
                  ...p,
                  [key]: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
                }))
              }
              rows={3}
              spellCheck={false}
              placeholder={placeholder}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">Added to the global lists. One per line; <code>{"{project}"}</code> is the chat's project.</p>
    </>
  );
}
