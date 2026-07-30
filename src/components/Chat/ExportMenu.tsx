import { useState } from "react";
import { Download, FileText, FileType, Loader2 } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import {
  exportChatMarkdown,
  exportChatPdf,
  type ExportChatData,
  type ExportZoneInfo,
} from "@/lib/export";

/** Header entry point for exporting the current chat as Markdown or PDF (0.7.1). */
export function ExportMenu({ chatId }: { chatId: string }) {
  const chats = useApp((s) => s.chats);
  const zones = useApp((s) => s.zones);
  const projects = useApp((s) => s.projects);
  const tagsByChat = useApp((s) => s.tagsByChat);
  const theme = useApp((s) => s.theme);
  const fontFamily = useApp((s) => s.appSettings.fontFamily);
  const pdfExportDetail = useApp((s) => s.appSettings.pdfExportDetail);
  const pdfExportTheme = useApp((s) => s.appSettings.pdfExportTheme);

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<null | "md" | "pdf">(null);

  async function gather(): Promise<ExportChatData | null> {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return null;
    const messages = await api.getMessages(chatId);
    const primaryZone = chat.zoneId ? zones.find((z) => z.id === chat.zoneId) ?? null : null;
    const project = chat.projectId ? projects.find((p) => p.id === chat.projectId) ?? null : null;
    const zonesById: Record<string, ExportZoneInfo> = {};
    for (const z of zones) zonesById[z.id] = { name: z.name, accentColor: z.accentColor };
    return {
      chat,
      messages,
      zoneName: primaryZone?.name ?? null,
      zoneModel: primaryZone?.model ?? null,
      projectName: project?.name ?? null,
      tagNames: (tagsByChat[chatId] ?? []).map((t) => t.name),
      zonesById,
    };
  }

  async function run(kind: "md" | "pdf") {
    setBusy(kind);
    try {
      const data = await gather();
      if (!data) return;
      if (kind === "md") await exportChatMarkdown(data);
      // Awaited: the PDF renders every diagram and plot before the print dialog
      // opens, so the button stays busy for as long as that takes. Detail and
      // theme come from Settings → PDF export.
      else
        await exportChatPdf(
          data,
          {
            mode: pdfExportTheme === "app" ? theme.mode : pdfExportTheme,
            accent: theme.accent,
            fontFamily,
          },
          { detail: pdfExportDetail },
        );
    } catch (e) {
      console.error("chat export failed", e);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Export this chat"
        className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
        Export
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 min-w-[190px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
            <button
              onClick={() => run("md")}
              disabled={!!busy}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)] disabled:opacity-50"
            >
              <FileText size={13} className="text-[var(--color-text-muted)]" />
              Export as Markdown
            </button>
            <button
              onClick={() => run("pdf")}
              disabled={!!busy}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)] disabled:opacity-50"
            >
              <FileType size={13} className="text-[var(--color-text-muted)]" />
              Export as PDF
            </button>
          </div>
        </>
      )}
    </div>
  );
}
