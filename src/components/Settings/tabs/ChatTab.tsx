import { X, Folder, FolderOpen } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import { ToggleRow } from "@/components/common/Toggle";
import { resolveBaseProvider } from "@/lib/baseZone";
import { ApprovalCategoryGrid, OptionCards, PrefixList, SettingSelect } from "../controls";

export function ChatTab() {
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
        <h3 className="mb-1 text-sm font-medium">Rolling context</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Keeps a chat's conversation under a fixed size by forgetting its oldest messages as it
          grows — except what the model marks important, which it is always shown. Suits long
          unattended runs, where a chat would otherwise outgrow the model. The model is told to
          record what it has finished and verified, and not to redo it. <strong>0 is off</strong>;
          each chat can set its own from the compact button under the composer.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            step={4000}
            value={appSettings.rollingContextTokens}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (Number.isFinite(n)) setAppSettings({ rollingContextTokens: Math.max(0, n) });
            }}
            className="w-28 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm"
          />
          <span className="text-xs text-[var(--color-text-muted)]">tokens of conversation per chat by default</span>
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Smart compaction</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Shrinks what the model re-reads of a long chat by rule, with no model call: old tool
          output is trimmed to its head and tail, long tool inputs are hidden, and results of calls
          repeated later are dropped. Runs from the compact button under the composer, when the
          model calls <code>smart_compact</code>, and automatically before a chat outgrows its
          model's window — a summary is only written if trimming was not enough.
        </p>
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-muted)]">
          <label className="flex items-center gap-2">
            Keep
            <input
              type="number"
              min={100}
              step={100}
              value={appSettings.smartCompact.outputChars}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) setAppSettings({ smartCompact: { ...appSettings.smartCompact, outputChars: Math.max(100, n) } });
              }}
              className="w-24 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            />
            characters of each old tool result
          </label>
          <label className="flex items-center gap-2">
            Hide tool inputs over
            <input
              type="number"
              min={100}
              step={50}
              value={appSettings.smartCompact.inputChars}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value));
                if (Number.isFinite(n)) setAppSettings({ smartCompact: { ...appSettings.smartCompact, inputChars: Math.max(100, n) } });
              }}
              className="w-20 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1.5 text-sm text-[var(--color-text)]"
            />
            characters
          </label>
        </div>
        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Drop results of repeated calls"
            description="The same file read twice keeps only the newer read."
            checked={appSettings.smartCompact.dedupe}
            onChange={(v) => setAppSettings({ smartCompact: { ...appSettings.smartCompact, dedupe: v } })}
          />
          <ToggleRow
            label="Strip old thinking"
            description="Inline reasoning from compacted answers is left out, whatever the zone's setting."
            checked={appSettings.smartCompact.stripThinking}
            onChange={(v) => setAppSettings({ smartCompact: { ...appSettings.smartCompact, stripThinking: v } })}
          />
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
        <h3 className="mb-1 text-sm font-medium">Closing the window</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Agents and scheduled runs keep working while the window is hidden. Click the tray icon to
          bring it back; quit from the tray icon's menu.
        </p>
        <ToggleRow
          label="Close to the tray"
          description="Off makes the close button quit MultiZone, stopping anything still running."
          checked={appSettings.closeToTray}
          onChange={(v) => setAppSettings({ closeToTray: v })}
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
