import { useRef, useState } from "react";
import {
  ChevronDown,
  Database,
  Eye,
  FileText,
  FileType,
  Folder,
  FolderX,
  History,
  Loader2,
  Plus,
  SplitSquareHorizontal,
  Tag as TagIcon,
  X,
  Zap,
} from "lucide-react";
import { useApp } from "@/store/app";
import { getZoneIcon } from "@/lib/zoneIcons";
import { Popover } from "@/components/common/Popover";
import { useChatExport } from "@/lib/useChatExport";
import type { Zone } from "@/lib/types";

const EMPTY: never[] = [];

/**
 * What the chat *is* — its project, tags and perspectives — and what can be
 * done with it as a document (0.17.9).
 *
 * These were the header: a folder chip that opened a second bar of project
 * and tag controls, a "Perspectives" button with a popover, a `…` menu for
 * replay and export. Eight controls in a row that scrolled sideways on a
 * laptop, each one a popover away from doing anything. None of them is
 * something you glance at mid-conversation; they are things you set once and
 * then leave, which is what a panel section is for. The header keeps the two
 * things that are read constantly — the context ring and the zone answering.
 */
export function ChatSection({ chatId }: { chatId: string }) {
  const chat = useApp((s) => s.chats.find((c) => c.id === chatId) ?? null);
  const projects = useApp((s) => s.projects);
  const allTags = useApp((s) => s.tags);
  const zones = useApp((s) => s.zones);
  const chatTags = useApp((s) => s.tagsByChat[chatId] ?? EMPTY);
  const perspectiveZones = useApp((s) => s.chatZonesByChat[chatId] ?? EMPTY);
  const globalMode = useApp((s) => s.appSettings.perspectiveMode);

  const setChatProject = useApp((s) => s.setChatProject);
  const toggleProjectContext = useApp((s) => s.toggleProjectContext);
  const toggleKnowledge = useApp((s) => s.toggleKnowledge);
  const addChatTag = useApp((s) => s.addChatTag);
  const removeChatTag = useApp((s) => s.removeChatTag);
  const toggleChatTagContext = useApp((s) => s.toggleChatTagContext);
  const addPerspectiveZone = useApp((s) => s.addPerspectiveZone);
  const removePerspectiveZone = useApp((s) => s.removePerspectiveZone);
  const setChatPerspectiveMode = useApp((s) => s.setChatPerspectiveMode);
  const openZoneEditor = useApp((s) => s.openZoneEditor);
  const openReplay = useApp((s) => s.openReplay);
  const { busy, exportAs } = useChatExport(chatId);

  const [projectOpen, setProjectOpen] = useState(false);
  const [tagOpen, setTagOpen] = useState(false);
  const [zoneOpen, setZoneOpen] = useState(false);
  const [showInjected, setShowInjected] = useState(false);
  const projectRef = useRef<HTMLButtonElement>(null);
  const tagRef = useRef<HTMLButtonElement>(null);
  const zoneRef = useRef<HTMLButtonElement>(null);

  if (!chat) return null;

  const project = projects.find((p) => p.id === chat.projectId) ?? null;
  const ProjectIcon = project ? getZoneIcon(project.icon) : Folder;
  const projectColor = project?.accentColor ?? "var(--color-accent)";
  const projectHasSnippet = !!project?.contextSnippet?.trim();
  const projectIndexed = !!project?.kbIndexedAt;
  const unassignedTags = allTags.filter((t) => !chatTags.some((ct) => ct.tagId === t.id));
  const perspIds = new Set(perspectiveZones.map((z) => z.zoneId));
  const addableZones = zones.filter((z) => z.id !== chat.zoneId && !perspIds.has(z.id));
  const mode = chat.perspectiveMode;

  // Everything being prepended to the system prompt for this chat.
  const injected: { label: string; color: string; text: string }[] = [];
  if (chat.projectContextEnabled && project?.contextSnippet?.trim()) {
    injected.push({ label: project.name, color: projectColor, text: project.contextSnippet.trim() });
  }
  for (const ct of chatTags) {
    if (ct.contextEnabled && ct.contextSnippet?.trim()) {
      injected.push({ label: ct.name, color: ct.color ?? "var(--color-accent)", text: ct.contextSnippet.trim() });
    }
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      {/* ── Project ───────────────────────────────────────────────────── */}
      <div>
        <Label>Project</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            ref={projectRef}
            onClick={() => setProjectOpen((v) => !v)}
            title="Set the project this chat belongs to"
            className="flex max-w-full items-center gap-1.5 rounded-full border border-[var(--color-border)] py-0.5 pl-0.5 pr-2 text-[var(--color-text)] hover:border-[var(--color-accent)]"
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full" style={{ background: project ? projectColor : "var(--color-border)" }}>
              <ProjectIcon size={10} color="white" />
            </span>
            <span className="truncate">{project ? project.name : "No project"}</span>
            <ChevronDown size={11} className="shrink-0 text-[var(--color-text-muted)]" />
          </button>
          <Popover
            open={projectOpen}
            onClose={() => setProjectOpen(false)}
            anchorRef={projectRef}
            zIndex={50}
            className="min-w-[180px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
          >
            <div>
              <MenuItem
                onClick={() => { void setChatProject(chatId, null); setProjectOpen(false); }}
                active={!project}
              >
                <FolderX size={12} /> No project
              </MenuItem>
              <div className="my-1 border-t border-[var(--color-border)]" />
              {projects.length === 0 && (
                <div className="px-3 py-1.5 text-xs text-[var(--color-text-muted)]">No projects yet.</div>
              )}
              {projects.map((p) => {
                const Icon = getZoneIcon(p.icon);
                return (
                  <MenuItem
                    key={p.id}
                    onClick={() => { void setChatProject(chatId, p.id); setProjectOpen(false); }}
                    active={p.id === chat.projectId}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ background: p.accentColor ?? "var(--color-accent)" }}>
                      <Icon size={10} color="white" />
                    </span>
                    {p.name}
                  </MenuItem>
                );
              })}
            </div>
          </Popover>

          {project && (
            <>
              <Toggle
                on={chat.projectContextEnabled}
                color={projectColor}
                icon={<Zap size={9} />}
                label="Context"
                onClick={() => void toggleProjectContext(chatId, !chat.projectContextEnabled)}
                title={
                  !projectHasSnippet
                    ? "This project has no context snippet, so enabling does nothing. Add one in Manage Projects."
                    : chat.projectContextEnabled
                      ? "Project context ON — its snippet is added to the system prompt."
                      : "Project context OFF — click to inject the project's snippet."
                }
              />
              {projectIndexed && (
                <Toggle
                  on={chat.knowledgeEnabled}
                  color={projectColor}
                  icon={<Database size={9} />}
                  label="Knowledge"
                  onClick={() => void toggleKnowledge(chatId, !chat.knowledgeEnabled)}
                  title={
                    chat.knowledgeEnabled
                      ? "Knowledge ON — the assistant can search this project's indexed documents."
                      : "Knowledge OFF — click to let the assistant search this project's documents."
                  }
                />
              )}
            </>
          )}
        </div>
        {project && chat.projectContextEnabled && !projectHasSnippet && (
          <p className="mt-1 text-[10px] italic text-[var(--color-text-muted)]">no context snippet set</p>
        )}
      </div>

      {/* ── Tags ──────────────────────────────────────────────────────── */}
      <div>
        <Label>Tags</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {chatTags.map((ct) => (
            <div
              key={ct.tagId}
              className="group flex items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 transition"
              style={
                ct.contextEnabled
                  ? { background: ct.color ?? "var(--color-accent)", borderColor: "transparent", color: "white" }
                  : { borderColor: ct.color ?? "var(--color-border)" }
              }
            >
              <button
                onClick={() => void toggleChatTagContext(chatId, ct.tagId, !ct.contextEnabled)}
                title={ct.contextEnabled ? "Context ON — click to disable" : "Context OFF — click to enable"}
                className="flex items-center gap-1"
              >
                <span className="h-2 w-2 rounded-full" style={{ background: ct.contextEnabled ? "white" : (ct.color ?? "var(--color-text-muted)") }} />
                {ct.name}
              </button>
              <button
                onClick={() => void removeChatTag(chatId, ct.tagId)}
                className="rounded-full p-0.5 opacity-50 hover:opacity-100"
                title="Remove tag"
              >
                <X size={9} />
              </button>
            </div>
          ))}
          {unassignedTags.length > 0 ? (
            <>
              <button
                ref={tagRef}
                onClick={() => setTagOpen((v) => !v)}
                className="flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <TagIcon size={10} /> Add
              </button>
              <Popover
                open={tagOpen}
                onClose={() => setTagOpen(false)}
                anchorRef={tagRef}
                zIndex={50}
                className="min-w-[160px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
              >
                <div>
                  {unassignedTags.map((t) => (
                    <MenuItem key={t.id} onClick={() => { void addChatTag(chatId, t.id); setTagOpen(false); }}>
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: t.color ?? "var(--color-text-muted)" }} />
                      {t.name}
                    </MenuItem>
                  ))}
                </div>
              </Popover>
            </>
          ) : allTags.length === 0 ? (
            <span className="text-[10px] italic text-[var(--color-text-muted)]">
              no tags yet — create them in Manage Projects
            </span>
          ) : null}
        </div>
        {injected.length > 0 && (
          <div className="mt-1.5">
            <button
              onClick={() => setShowInjected((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              title="Show the context being prepended to this chat's system prompt"
            >
              <Eye size={10} />
              {showInjected ? "Hide" : "Show"} what these add to the prompt ({injected.length})
            </button>
            {showInjected && (
              <div className="mt-1.5 flex flex-col gap-1.5">
                {injected.map((item, i) => (
                  <div key={i} className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium" style={{ color: item.color }}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: item.color }} />
                      {item.label}
                    </div>
                    <div className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-[var(--color-text-muted)]">
                      {item.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Perspectives ──────────────────────────────────────────────── */}
      <div>
        <Label
          right={
            perspectiveZones.length > 0 && (
              <div className="flex overflow-hidden rounded border border-[var(--color-border)] text-[10px]">
                {(
                  [
                    { value: null, label: `Default (${globalMode})` },
                    { value: "parallel", label: "Parallel" },
                    { value: "sequential", label: "Sequential" },
                  ] as { value: "sequential" | "parallel" | null; label: string }[]
                ).map((opt) => (
                  <button
                    key={String(opt.value)}
                    onClick={() => void setChatPerspectiveMode(chatId, opt.value)}
                    className={`px-1.5 py-0.5 ${
                      mode === opt.value
                        ? "bg-[var(--color-accent)] text-white"
                        : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)]"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )
          }
        >
          Perspectives
        </Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {perspectiveZones.map((pz) => {
            const zone = zones.find((z) => z.id === pz.zoneId);
            return <ZoneChip key={pz.zoneId} zone={zone} fallback={pz.zoneId} onOpen={() => zone && openZoneEditor(zone.id)} onRemove={() => void removePerspectiveZone(chatId, pz.zoneId)} />;
          })}
          {addableZones.length > 0 && (
            <>
              <button
                ref={zoneRef}
                onClick={() => setZoneOpen((v) => !v)}
                title="Add a zone that answers alongside the primary one"
                className="flex items-center gap-1 rounded-full border border-dashed border-[var(--color-border)] px-2 py-0.5 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <SplitSquareHorizontal size={10} /> Add
              </button>
              <Popover
                open={zoneOpen}
                onClose={() => setZoneOpen(false)}
                anchorRef={zoneRef}
                zIndex={50}
                className="min-w-[200px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
              >
                <div>
                  {addableZones.map((z) => (
                    <MenuItem key={z.id} onClick={() => { void addPerspectiveZone(chatId, z.id); setZoneOpen(false); }}>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: z.accentColor ?? "var(--color-accent)" }} />
                      <span className="flex-1 truncate">{z.name}</span>
                      <Plus size={11} className="shrink-0 text-[var(--color-text-muted)]" />
                    </MenuItem>
                  ))}
                </div>
              </Popover>
            </>
          )}
          {perspectiveZones.length === 0 && (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              Add a zone to get a second answer to every message.
            </span>
          )}
        </div>
      </div>

      {/* ── Document actions ──────────────────────────────────────────── */}
      <div>
        <Label>This chat</Label>
        <div className="flex flex-wrap gap-1.5">
          <ActionButton onClick={() => openReplay(chatId)} title="Every tool call, approval, failure and plan decision, in order">
            <History size={12} /> Replay
          </ActionButton>
          <ActionButton onClick={() => void exportAs("md")} disabled={!!busy} title="Save the conversation as a Markdown file">
            {busy === "md" ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} Markdown
          </ActionButton>
          <ActionButton onClick={() => void exportAs("pdf")} disabled={!!busy} title="Save the conversation as a PDF">
            {busy === "pdf" ? <Loader2 size={12} className="animate-spin" /> : <FileType size={12} />} PDF
          </ActionButton>
        </div>
      </div>
    </div>
  );
}

function Label({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center gap-2">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">{children}</span>
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}

function MenuItem({ onClick, active, children }: { onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)] ${
        active ? "text-[var(--color-accent)]" : ""
      }`}
    >
      {children}
    </button>
  );
}

function Toggle({
  on,
  color,
  icon,
  label,
  title,
  onClick,
}: {
  on: boolean;
  color: string;
  icon: React.ReactNode;
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`flex items-center gap-1 rounded-full border px-2 py-0.5 transition ${
        on ? "border-transparent text-white" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"
      }`}
      style={on ? { background: color } : undefined}
    >
      {icon}
      {label} {on ? "on" : "off"}
    </button>
  );
}

function ZoneChip({ zone, fallback, onOpen, onRemove }: { zone: Zone | undefined; fallback: string; onOpen: () => void; onRemove: () => void }) {
  const Icon = getZoneIcon(zone?.icon);
  const color = zone?.accentColor ?? "var(--color-accent)";
  return (
    <div className="group flex items-center gap-1 rounded-full border border-[var(--color-border)] py-0.5 pl-0.5 pr-1">
      <button onClick={onOpen} title={`${zone?.name ?? fallback} — open zone details`} className="flex items-center gap-1.5 text-[var(--color-text)]">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full" style={{ background: color }}>
          <Icon size={10} color="white" />
        </span>
        <span className="max-w-[120px] truncate">{zone?.name ?? fallback}</span>
      </button>
      <button onClick={onRemove} className="rounded-full p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" title="Remove perspective">
        <X size={9} />
      </button>
    </div>
  );
}

function ActionButton({ onClick, disabled, title, children }: { onClick: () => void; disabled?: boolean; title: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2 py-1 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}
