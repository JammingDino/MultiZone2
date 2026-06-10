import { useMemo, useRef, useState } from "react";
import { Send, ChevronDown, Zap, Check, Layers, Settings as SettingsIcon, Loader2, Brain } from "lucide-react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { getZoneIcon } from "@/lib/zoneIcons";
import type { InputPart } from "@/lib/types";

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
  const defaultZoneId = useApp((s) => s.defaultZoneId);
  const defaultProviderId = useApp((s) => s.appSettings.defaultProviderId);
  const sendKey = useApp((s) => s.appSettings.sendKey);
  const refreshChats = useApp((s) => s.refreshChats);
  const setActiveChat = useApp((s) => s.setActiveChat);
  const setChatSmart = useApp((s) => s.setChatSmart);
  const openSettings = useApp((s) => s.openSettings);
  const openZoneEditor = useApp((s) => s.openZoneEditor);

  // The provider that answers Quick chats, and whether it actually has a model.
  const quickProvider =
    providers.find((p) => p.id === (defaultProviderId ?? providers[0]?.id)) ?? null;
  const quickModel = quickProvider?.defaultModel?.trim() || null;
  const quickAvailable = !!quickModel;

  const defaultZone = zones.find((z) => z.id === defaultZoneId) ?? null;

  // Default mode: the user's default zone if set, else Quick chat when usable,
  // else the first zone.
  const [mode, setMode] = useState<Mode>(() => {
    if (defaultZone) return { type: "zone", id: defaultZone.id };
    if (quickAvailable) return { type: "quick" };
    if (zones[0]) return { type: "zone", id: zones[0].id };
    return { type: "quick" };
  });
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const selectedZone =
    mode.type === "zone" ? zones.find((z) => z.id === mode.id) ?? null : null;

  const quickSelectedButUnavailable =
    (mode.type === "quick" || mode.type === "smart") && !quickAvailable;
  const canSend = text.trim().length > 0 && !sending && !quickSelectedButUnavailable;

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 5) return "Working late?";
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  async function start() {
    if (!canSend) return;
    setSending(true);
    const zoneId = mode.type === "zone" ? mode.id : null;
    try {
      const chat = await api.createChat(zoneId, null);
      if (mode.type === "smart") {
        await setChatSmart(chat.id, true);
      }
      await refreshChats();
      await setActiveChat(chat.id);
      const parts: InputPart[] = [{ type: "text", text: text.trim() }];
      setText("");
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
            Ask anything to start. Quick chat is fast and approximate — pick a zone for a tailored assistant.
          </p>
        </div>

        {/* Composer */}
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2 shadow-sm focus-within:border-[var(--color-accent)]">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            autoFocus
            placeholder="Send a message…"
            className="max-h-48 min-h-[52px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none"
          />
          <div className="flex items-center justify-between gap-2 px-1 pt-1">
            {/* Mode dropdown — the "optional" zone selector */}
            <div className="relative">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
              >
                {mode.type === "quick" ? (
                  <>
                    <Zap size={12} className="text-[var(--color-accent)]" />
                    Quick chat
                  </>
                ) : mode.type === "smart" ? (
                  <>
                    <Brain size={12} className="text-[var(--color-accent)]" />
                    Smart chat
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
                    >
                      <Zap size={13} className="text-[var(--color-accent)]" />
                      <div className="flex-1">
                        <div>Quick chat</div>
                        <div className="text-xs text-[var(--color-text-muted)]">
                          {quickAvailable ? `No zone · ${quickModel}` : "No default model set"}
                        </div>
                      </div>
                      {mode.type === "quick" && <Check size={12} className="text-[var(--color-accent)]" />}
                    </button>
                    <button
                      onClick={() => { setMode({ type: "smart" }); setMenuOpen(false); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
                    >
                      <Brain size={13} className="text-[var(--color-accent)]" />
                      <div className="flex-1">
                        <div>Smart chat</div>
                        <div className="text-xs text-[var(--color-text-muted)]">
                          Router picks the best zone for each message
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
      </div>
    </div>
  );
}
