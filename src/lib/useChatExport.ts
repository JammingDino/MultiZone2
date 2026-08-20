import { useCallback, useState } from "react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import {
  exportChatMarkdown,
  exportChatPdf,
  type ExportChatData,
  type ExportSubchat,
  type ExportZoneInfo,
} from "@/lib/export";

export type ExportKind = "md" | "pdf";

/**
 * Exporting one chat, without the menu that used to own it.
 *
 * The gather-and-write logic lived inside the header's Export dropdown, which
 * made that dropdown the only place in the app a chat could be exported from
 * (#13). It is a hook now so the chat menu and the sidebar's right-click menu
 * can both offer it and mean the same thing.
 */
export function useChatExport(chatId: string) {
  const chats = useApp((s) => s.chats);
  const zones = useApp((s) => s.zones);
  const projects = useApp((s) => s.projects);
  const tagsByChat = useApp((s) => s.tagsByChat);
  const theme = useApp((s) => s.theme);
  const fontFamily = useApp((s) => s.appSettings.fontFamily);
  const pdfExportDetail = useApp((s) => s.appSettings.pdfExportDetail);
  const pdfExportTheme = useApp((s) => s.appSettings.pdfExportTheme);
  const pdfExportSessionLog = useApp((s) => s.appSettings.pdfExportSessionLog);
  const exportSubchats = useApp((s) => s.appSettings.exportSubchats);

  const [busy, setBusy] = useState<ExportKind | null>(null);

  /**
   * Every sub-agent conversation descended from this chat, with its transcript
   * (0.9.11). The tree command already walks nesting, so one call covers the
   * whole family however deep it goes; the transcripts are fetched in parallel
   * because a Code Team run has seven of them.
   */
  const gatherSubchats = useCallback(async (): Promise<ExportSubchat[]> => {
    if (!exportSubchats) return [];
    const nodes = await api.getSubchatTree(chatId);
    return Promise.all(
      nodes.map(async (n) => ({
        id: n.id,
        parentChatId: n.parentChatId,
        title: n.title,
        zoneId: n.zoneId,
        initiatedByZoneId: n.initiatedByZoneId,
        messages: await api.getMessages(n.id),
        createdAt: n.createdAt,
      })),
    );
  }, [chatId, exportSubchats]);

  const gather = useCallback(async (): Promise<ExportChatData | null> => {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) return null;
    const [messages, subchats, events] = await Promise.all([
      api.getMessages(chatId),
      gatherSubchats().catch((e) => {
        // A missing sub-agent tree is not a reason to refuse the export — the
        // primary conversation is still the thing being asked for.
        console.error("subchat export gather failed", e);
        return [] as ExportSubchat[];
      }),
      // The event log is an appendix, not the document: a chat that predates it
      // (or a read that fails) exports exactly as it did before.
      api.listSessionEvents(chatId).catch((e) => {
        console.error("session log gather failed", e);
        return [];
      }),
    ]);
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
      subchats,
      events,
    };
  }, [chatId, chats, gatherSubchats, projects, tagsByChat, zones]);

  const exportAs = useCallback(
    async (kind: ExportKind) => {
      setBusy(kind);
      try {
        const data = await gather();
        if (!data) return;
        if (kind === "md") await exportChatMarkdown(data);
        // Awaited: the PDF renders every diagram and plot before the print
        // dialog opens, so the caller stays busy for as long as that takes.
        // Detail and theme come from Settings → PDF export.
        else
          await exportChatPdf(
            data,
            {
              mode: pdfExportTheme === "app" ? theme.mode : pdfExportTheme,
              accent: theme.accent,
              fontFamily,
            },
            { detail: pdfExportDetail, sessionLog: pdfExportSessionLog },
          );
      } catch (e) {
        console.error("chat export failed", e);
      } finally {
        setBusy(null);
      }
    },
    [gather, fontFamily, pdfExportDetail, pdfExportSessionLog, pdfExportTheme, theme],
  );

  return { busy, exportAs };
}
