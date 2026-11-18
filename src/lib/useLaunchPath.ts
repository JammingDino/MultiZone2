import { useEffect } from "react";
import * as api from "@/lib/tauri";
import { useApp } from "@/store/app";
import { reportError } from "@/lib/reportError";
import { baseName, queueOutcome } from "@/components/Chat/GrantChip";

/**
 * Open a chat on the path the app was launched on (0.19.3) — `multizone.exe
 * <path>`, the Explorer "Open in MultiZone" verbs, or a second launch while the
 * app sits in the tray. See `src-tauri/src/launch.rs` for how the path arrives.
 *
 * The path is pulled rather than pushed: once on mount, and again whenever a
 * second launch nudges with `open-path`, so a path parked before this listener
 * existed is still found.
 *
 * Where it opens follows smart project detection: inside a known project, a
 * chat in that project (the project already covers it, so nothing is granted);
 * anywhere else, a chat with the path granted — which for a folder makes it the
 * chat's working directory. Nothing is sent.
 */
export function useLaunchPath(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    const pull = async () => {
      if (busy) return;
      busy = true;
      try {
        // Drain: two launches in quick succession park the later one.
        for (let path = await api.takePendingLaunch(); path; path = await api.takePendingLaunch()) {
          await openChatOnPath(path).catch(reportError(`Couldn't open a chat on ${baseName(path)}`));
        }
      } finally {
        busy = false;
      }
    };
    void pull();
    const un = api.onOpenPath(() => void pull());
    return () => { void un.then((u) => u()); };
  }, [enabled]);
}

export async function openChatOnPath(path: string): Promise<string> {
  const ctx = await api.pathContext(path);
  const st = useApp.getState();
  // The match is the backend's, so it holds even if the sidebar's project list
  // has not loaded yet; the store is only asked for the default zone.
  const projectId = ctx.project?.projectId ?? null;
  const project = projectId ? st.projects.find((p) => p.id === projectId) ?? null : null;
  // A project with a default zone answers with it (`create_chat` fills it in
  // when no zone is given); otherwise the Quick-chat zone, as the Home screen
  // would.
  const zoneId = project?.defaultZoneId ? null : st.appSettings.baseZoneId ?? null;
  const chat = await api.createChat(zoneId, projectId);
  if (!projectId) await api.grantChatPath(chat.id, ctx.path, "launch");

  // What to say when the chat appears: where in the project it was opened
  // from, or that this folder could be a project of its own.
  let notice: string | null = null;
  if (ctx.project && !ctx.project.exact) {
    const rel = ctx.path.slice(ctx.project.directory.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "");
    notice = `Opened from ${rel || baseName(ctx.path)} in ${ctx.project.name}.`;
  }
  const offers = !projectId && ctx.looksLikeProject && ctx.isDir ? [{ ...ctx, granted: true }] : [];
  if (notice || offers.length) queueOutcome(chat.id, notice, offers);

  await st.refreshChats();
  // Mid-turn, the new chat opens beside the running one rather than taking
  // its place.
  const busy = !!(st.activeChatId && st.streamingByChat[st.activeChatId]);
  await st.setActiveChat(chat.id, busy ? "tab" : "here");
  useApp.getState().focusComposer();
  return chat.id;
}
