import { useEffect, useMemo, useRef, useState } from "react";
import { Send, ChevronDown, Zap, Check, Layers, Settings as SettingsIcon, Loader2, Brain, Paperclip, Folder, Tag, X } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { getZoneIcon } from "@/lib/zoneIcons";
import type { InputPart } from "@/lib/types";
import { renderPdfToJpegs, extractPdfText } from "@/lib/pdf";
import {
  type PendingAttachment,
  AttachmentChip,
  AttachmentPreview,
  readFileAsDataUrl,
} from "@/components/Chat/InputBar";

type Mode = { type: "quick" } | { type: "smart" } | { type: "zone"; id: string };

/**
 * The landing view shown when no chat is open. A greeting + a single composer
 * that starts a new chat on send. By default it runs a "Quick chat" (no zone —
 * fast, approximate answers from the default model); an optional dropdown lets
 * the user pick a specific zone instead.
 */
export function HomeScreen() {
  const zones = useApp((s) => s.zones);
  const providers = useApp((s) => s.providers);
  const projects = useApp((s) => s.projects);
  const tags = useApp((s) => s.tags);
  const defaultProviderId = useApp((s) => s.appSettings.defaultProviderId);
  const baseZoneId = useApp((s) => s.appSettings.baseZoneId);
  const sendKey = useApp((s) => s.appSettings.sendKey);
  const pdfMode = useApp((s) => s.appSettings.pdfMode);
  const refreshChats = useApp((s) => s.refreshChats);
  const setActiveChat = useApp((s) => s.setActiveChat);
  const setChatSmart = useApp((s) => s.setChatSmart);
  const addChatTag = useApp((s) => s.addChatTag);
  const openSettings = useApp((s) => s.openSettings);
  const openZoneEditor = useApp((s) => s.openZoneEditor);
  const newChatProjectId = useApp((s) => s.newChatProjectId);
  const setNewChatProjectId = useApp((s) => s.setNewChatProjectId);

  // The base zone for Quick Chat (if configured), or legacy provider fallback.
  const baseZone = zones.find((z) => z.id === baseZoneId) ?? null;
  const quickProvider =
    providers.find((p) => p.id === (defaultProviderId ?? providers[0]?.id)) ?? null;
  const quickModel = quickProvider?.defaultModel?.trim() || null;
  // Quick Chat is available if a base zone is set, or a provider with a default model exists.
  const quickAvailable = !!(baseZone ?? quickModel);

  const [mode, setMode] = useState<Mode>(() => {
    if (quickAvailable) return { type: "quick" };
    if (zones[0]) return { type: "zone", id: zones[0].id };
    return { type: "quick" };
  });
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewAtt = pending.find((a) => a.id === previewId) ?? null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Consume the pre-selected project from sidebar "new chat in project".
  useEffect(() => {
    if (newChatProjectId) {
      setSelectedProjectId(newChatProjectId);
      setNewChatProjectId(null);
    }
  }, [newChatProjectId, setNewChatProjectId]);

  const selectedZone =
    mode.type === "zone" ? zones.find((z) => z.id === mode.id) ?? null : null;

  const quickSelectedButUnavailable =
    (mode.type === "quick" || mode.type === "smart") && !quickAvailable;
  const smartWithNoZones = mode.type === "smart" && zones.length === 0 && quickAvailable;
  const canSend = (text.trim().length > 0 || pending.length > 0) && !sending && !quickSelectedButUnavailable;

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return "Working late?";
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  async function handleFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    for (const file of list) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const id = crypto.randomUUID();

      if (ext === "pdf") {
        const stub: PendingAttachment = {
          id,
          fileName: file.name,
          fileType: "pdf",
          payload: pdfMode === "text" ? "" : [],
          progress: { page: 0, total: 0 },
        };
        setPending((p) => [...p, stub]);
        try {
          if (pdfMode === "text") {
            const extracted = await extractPdfText(file, (pr) => {
              setPending((p) => p.map((a) => (a.id === id ? { ...a, progress: pr } : a)));
            });
            setPending((p) =>
              p.map((a) => (a.id === id ? { ...a, payload: extracted, progress: undefined } : a)),
            );
          } else {
            const pages = await renderPdfToJpegs(file, (pr) => {
              setPending((p) => p.map((a) => (a.id === id ? { ...a, progress: pr } : a)));
            });
            setPending((p) =>
              p.map((a) => (a.id === id ? { ...a, payload: pages, progress: undefined } : a)),
            );
          }
        } catch (e) {
          console.error(e);
          setPending((p) => p.filter((a) => a.id !== id));
        }
      } else if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
        const dataUrl = await readFileAsDataUrl(file);
        setPending((p) => [
          ...p,
          { id, fileName: file.name, fileType: "image", payload: dataUrl },
        ]);
      } else if (["txt", "md", "csv", "json", "rs", "ts", "js", "py", "log"].includes(ext)) {
        const content = await file.text();
        setPending((p) => [
          ...p,
          { id, fileName: file.name, fileType: "text", payload: content },
        ]);
      } else {
        setPending((p) => [
          ...p,
          { id, fileName: file.name, fileType: "other", payload: "" },
        ]);
      }
    }
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter((it) => it.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const dataUrl = await readFileAsDataUrl(file);
      const fileName = file.name && file.name !== "image.png" ? file.name : `pasted-${Date.now()}.png`;
      setPending((p) => [
        ...p,
        { id: crypto.randomUUID(), fileName, fileType: "image", payload: dataUrl },
      ]);
    }
  }

  async function start() {
    if (!canSend) return;
    setSending(true);

    // Build parts synchronously RIGHT NOW before any awaits. This is the
    // safest point: the component is still mounted, all state is current, and
    // no React re-renders have occurred since the user clicked Send.
    const currentText = text;
    const currentPending = pending;
    const currentMode = mode;

    const parts: InputPart[] = [];
    const visibleTextParts: string[] = [];
    if (currentText.trim()) visibleTextParts.push(currentText.trim());
    for (const att of currentPending) {
      if (att.fileType === "text") {
        visibleTextParts.push(`File: ${att.fileName}\n\`\`\`\n${att.payload as string}\n\`\`\``);
      }
    }
    const joined = visibleTextParts.join("\n\n");
    if (joined) parts.push({ type: "text", text: joined });

    const pdfSaves: { fileName: string; pages: string[] }[] = [];
    for (const att of currentPending) {
      if (att.fileType === "image") {
        parts.push({ type: "image", data_url: att.payload as string });
      } else if (att.fileType === "pdf") {
        if (typeof att.payload === "string") {
          parts.push({ type: "hidden_text", text: `File: ${att.fileName} (PDF, extracted text)\n\`\`\`\n${att.payload}\n\`\`\`` });
        } else {
          const pages = att.payload as string[];
          parts.push({ type: "hidden_text", text: `[Attached PDF: ${att.fileName} — ${pages.length} pages follow as images]` });
          for (const dataUrl of pages) {
            parts.push({ type: "hidden_image", data_url: dataUrl });
          }
          pdfSaves.push({ fileName: att.fileName, pages });
        }
      }
    }

    const currentProjectId = selectedProjectId;
    const currentTagIds = new Set(selectedTagIds);

    // Quick mode uses the base zone if one is configured, otherwise null (legacy provider path).
    const zoneId =
      currentMode.type === "zone"
        ? currentMode.id
        : currentMode.type === "quick"
        ? (baseZoneId ?? null)
        : null;
    try {
      const chat = await api.createChat(zoneId, currentProjectId);
      if (currentMode.type === "smart") {
        await setChatSmart(chat.id, true);
      }
      // Assign selected tags (fire-and-forget; non-critical).
      for (const tagId of currentTagIds) {
        addChatTag(chat.id, tagId).catch(console.error);
      }
      await refreshChats();
      await setActiveChat(chat.id);

      for (const { fileName, pages } of pdfSaves) {
        api.savePdfAttachment(chat.id, fileName, pages).catch(console.error);
      }

      setText("");
      setPending([]);
      api.sendMessage(chat.id, parts).catch(console.error);
    } catch (e) {
      console.error("failed to start chat:", e);
      setSending(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const trigger =
      sendKey === "ctrl_enter"
        ? e.key === "Enter" && (e.ctrlKey || e.metaKey)
        : e.key === "Enter" && !e.shiftKey;
    if (trigger) {
      e.preventDefault();
      start();
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="w-full max-w-2xl">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold text-[var(--color-text)]">{greeting}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Ask anything to start, or pick a zone for a tailored assistant.
          </p>
        </div>

        {/* Composer */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2 shadow-sm focus-within:border-[var(--color-accent)]">
          {pending.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1">
              {pending.map((att) => (
                <AttachmentChip
                  key={att.id}
                  attachment={att}
                  onRemove={() => setPending((p) => p.filter((a) => a.id !== att.id))}
                  onPreview={att.progress ? undefined : () => setPreviewId(att.id)}
                />
              ))}
            </div>
          )}
          {previewAtt && (
            <AttachmentPreview
              attachment={previewAtt}
              onClose={() => setPreviewId(null)}
            />
          )}
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={2}
            autoFocus
            placeholder="Send a message…"
            className="max-h-48 min-h-[52px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
          />
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            {/* Left side: attach + mode + project + tags */}
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                title="Attach file"
              >
                <Paperclip size={15} />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = "";
                }}
              />

              {/* Mode dropdown */}
              <div className="relative">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                >
                  {mode.type === "quick" ? (
                    <>
                      <Zap size={12} className="text-[var(--color-accent)]" />
                      {baseZone ? `Quick · ${baseZone.name}` : "Quick"}
                    </>
                  ) : mode.type === "smart" ? (
                    <>
                      <Brain size={12} className="text-[var(--color-accent)]" />
                      Smart
                    </>
                  ) : selectedZone ? (
                    <>
                      <span
                        className="flex h-3.5 w-3.5 items-center justify-center rounded"
                        style={{ background: selectedZone.accentColor ?? "var(--color-accent)" }}
                      >
                        {(() => {
                          const Icon = getZoneIcon(selectedZone.icon);
                          return <Icon size={9} color="white" />;
                        })()}
                      </span>
                      {selectedZone.name}
                    </>
                  ) : (
                    <>
                      <Layers size={12} /> Choose a zone
                    </>
                  )}
                  <ChevronDown size={12} />
                </button>

                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                    <div className="absolute bottom-full left-0 z-40 mb-1 max-h-72 min-w-[260px] overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
                      <button
                        onClick={() => { setMode({ type: "quick" }); setMenuOpen(false); }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
                        title="Uses the base zone (Settings → Chat) for every message — fast and consistent"
                      >
                        <Zap size={13} className="text-[var(--color-accent)]" />
                        <div className="flex-1">
                          <div>Quick</div>
                          <div className="text-xs text-[var(--color-text-muted)]">
                            {baseZone
                              ? `Base zone · ${baseZone.name}`
                              : quickAvailable
                              ? `Legacy · ${quickModel}`
                              : "No base zone set"}
                          </div>
                        </div>
                        {mode.type === "quick" && <Check size={12} className="text-[var(--color-accent)]" />}
                      </button>
                      <button
                        onClick={() => { setMode({ type: "smart" }); setMenuOpen(false); }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
                        title="A router model picks the best zone for each individual message"
                      >
                        <Brain size={13} className="text-[var(--color-accent)]" />
                        <div className="flex-1">
                          <div>Smart</div>
                          <div className="text-xs text-[var(--color-text-muted)]">
                            Router picks the best zone per message
                          </div>
                        </div>
                        {mode.type === "smart" && <Check size={12} className="text-[var(--color-accent)]" />}
                      </button>

                      {zones.length > 0 && <div className="my-1 border-t border-[var(--color-border)]" />}
                      {zones.map((z) => {
                        const ZoneIcon = getZoneIcon(z.icon);
                        const active = mode.type === "zone" && mode.id === z.id;
                        return (
                          <button
                            key={z.id}
                            onClick={() => { setMode({ type: "zone", id: z.id }); setMenuOpen(false); }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
                            title={`Use the "${z.name}" zone for every message in this chat`}
                          >
                            <span
                              className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                              style={{ background: z.accentColor ?? "var(--color-accent)" }}
                            >
                              <ZoneIcon size={11} color="white" />
                            </span>
                            <div className="flex-1">
                              <div>{z.name}</div>
                              <div className="text-xs text-[var(--color-text-muted)]">{z.model}</div>
                            </div>
                            {active && <Check size={12} className="text-[var(--color-accent)]" />}
                          </button>
                        );
                      })}

                      <div className="my-1 border-t border-[var(--color-border)]" />
                      <button
                        onClick={() => { setMenuOpen(false); openZoneEditor(null); }}
                        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
                      >
                        <Layers size={12} /> New zone…
                      </button>
                    </div>
                  </>
                )}
              </div>

              {/* Project picker */}
              {projects.length > 0 && (
                <div className="flex items-center gap-1">
                  <div className="h-3 w-px bg-[var(--color-border)]" />
                  <Folder size={11} className="text-[var(--color-text-muted)]" />
                  <select
                    value={selectedProjectId ?? ""}
                    onChange={(e) => setSelectedProjectId(e.target.value || null)}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-0.5 text-xs outline-none focus:border-[var(--color-accent)]"
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Tag picker */}
              {tags.length > 0 && (
                <div className="relative flex items-center gap-1">
                  <div className="h-3 w-px bg-[var(--color-border)]" />
                  <Tag size={11} className="text-[var(--color-text-muted)]" />
                  {Array.from(selectedTagIds).map((tid) => {
                    const t = tags.find((tg) => tg.id === tid);
                    if (!t) return null;
                    return (
                      <span
                        key={tid}
                        className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs text-white"
                        style={{ background: t.color ?? "var(--color-accent)" }}
                      >
                        {t.name}
                        <button
                          onClick={() => setSelectedTagIds((s) => { const n = new Set(s); n.delete(tid); return n; })}
                          className="opacity-70 hover:opacity-100"
                        >
                          <X size={9} />
                        </button>
                      </span>
                    );
                  })}
                  <button
                    onClick={() => setTagMenuOpen((v) => !v)}
                    className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  >
                    + Tag
                  </button>
                  {tagMenuOpen && (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setTagMenuOpen(false)} />
                      <div className="absolute bottom-full left-0 z-40 mb-1 min-w-[160px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
                        {tags.map((t) => {
                          const active = selectedTagIds.has(t.id);
                          return (
                            <button
                              key={t.id}
                              onClick={() => {
                                setSelectedTagIds((s) => {
                                  const n = new Set(s);
                                  if (active) n.delete(t.id); else n.add(t.id);
                                  return n;
                                });
                              }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-[var(--color-panel-hover)]"
                            >
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ background: t.color ?? "var(--color-accent)" }}
                              />
                              {t.name}
                              {active && <Check size={10} className="ml-auto text-[var(--color-accent)]" />}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <button
              onClick={start}
              disabled={!canSend}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              title={quickSelectedButUnavailable ? "Set a default model first" : "Send"}
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send
            </button>
          </div>
        </div>

        {quickSelectedButUnavailable && (
          <div className="mt-2 flex items-center justify-center gap-1 text-xs text-[var(--color-text-muted)]">
            {mode.type === "smart" ? "Smart chat" : "Quick chat"} needs a default model.
            <button onClick={openSettings} className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
              <SettingsIcon size={11} /> Open settings
            </button>
          </div>
        )}
        {smartWithNoZones && (
          <div className="mt-2 flex items-center justify-center gap-1 text-xs text-[var(--color-text-muted)]">
            No zones yet — Smart chat will fall back to Quick chat until you
            <button onClick={() => openZoneEditor(null)} className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline">
              create one
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
