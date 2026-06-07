import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Maximize2 } from "lucide-react";
import { useApp } from "@/store/app";

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const accent = useApp((s) => s.theme.accent);
  // Create the window handle once and keep it stable across renders
  const appWindow = useRef(getCurrentWindow()).current;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setMaximized).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setMaximized).catch(() => {});
      })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 w-full shrink-0 items-center select-none"
      style={{ background: "var(--color-panel)", borderBottom: "1px solid var(--color-border)" }}
    >
      <div className="h-full w-1 shrink-0" style={{ background: accent }} />
      <div
        data-tauri-drag-region
        className="flex flex-1 items-center gap-2 px-3 text-xs font-semibold tracking-wide"
        style={{ color: "var(--color-text-muted)" }}
      >
        <span className="pointer-events-none flex items-center gap-2">
          <span style={{ color: accent }} className="font-bold">Multi</span>
          <span>Zone</span>
        </span>
      </div>
      <div className="flex h-full items-stretch">
        <WinBtn title="Minimize" onClick={() => { appWindow.minimize().catch(() => {}); }}>
          <Minus size={12} />
        </WinBtn>
        <WinBtn
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => { (maximized ? appWindow.unmaximize() : appWindow.maximize()).catch(() => {}); }}
        >
          {maximized ? <Square size={11} /> : <Maximize2 size={11} />}
        </WinBtn>
        <WinBtn title="Close" onClick={() => { appWindow.close().catch(() => {}); }} danger>
          <X size={12} />
        </WinBtn>
      </div>
    </div>
  );
}

function WinBtn({
  title, onClick, danger, children,
}: {
  title: string; onClick: () => void; danger?: boolean; children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const bg = hovered ? (danger ? "var(--color-danger)" : "var(--color-panel-hover)") : "transparent";
  const color = hovered && danger ? "white" : "var(--color-text-muted)";

  return (
    <button
      title={title}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ background: bg, color, border: "none", outline: "none", filter: "none" }}
      className="flex h-full w-10 items-center justify-center transition-colors"
    >
      {children}
    </button>
  );
}
