import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Plus, Layers, Zap, Brain, Loader2, Crown } from "lucide-react";
import { useApp } from "@/store/app";
import { getZoneIcon } from "@/lib/zoneIcons";

type RoutingState =
  | { status: "routing" }
  | { status: "done"; zoneId: string; zoneName: string }
  | null;

interface Props {
  chatId: string;
  currentZoneId: string | null;
  smartRouting: boolean;
  routingState?: RoutingState;
}

export function ZonePicker({ chatId, currentZoneId, smartRouting, routingState }: Props) {
  const zones = useApp((s) => s.zones);
  const setChatZone = useApp((s) => s.setChatZone);
  const setChatSmart = useApp((s) => s.setChatSmart);
  const openZoneEditor = useApp((s) => s.openZoneEditor);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = zones.find((z) => z.id === currentZoneId) ?? null;
  const CurrentIcon = getZoneIcon(current?.icon);
  const currentColor = current?.accentColor ?? null;

  // The zone the router picked last turn (null while idle or routing).
  const routedZone =
    smartRouting && routingState?.status === "done"
      ? (zones.find((z) => z.id === routingState.zoneId) ?? null)
      : null;
  const RoutedIcon = getZoneIcon(routedZone?.icon);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  async function pick(zoneId: string | null) {
    setOpen(false);
    if (zoneId !== currentZoneId || smartRouting) {
      await setChatZone(chatId, zoneId);
    }
  }

  async function pickSmart() {
    setOpen(false);
    if (!smartRouting) {
      await setChatSmart(chatId, true);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded border border-transparent px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
        title="Change zone"
      >
        {smartRouting && routingState?.status === "routing" ? (
          <Loader2 size={12} className="animate-spin text-[var(--color-accent)]" />
        ) : routedZone ? (
          // Show the routed zone's own icon + color so it's visually distinct
          <span
            className="flex h-4 w-4 items-center justify-center rounded"
            style={{ background: routedZone.accentColor ?? "var(--color-accent)" }}
          >
            <RoutedIcon size={10} color="white" />
          </span>
        ) : smartRouting ? (
          <Brain size={12} className="text-[var(--color-accent)]" />
        ) : current ? (
          <span
            className="flex h-4 w-4 items-center justify-center rounded"
            style={{ background: currentColor ?? "var(--color-accent)" }}
          >
            <CurrentIcon size={10} color="white" />
          </span>
        ) : (
          <Zap size={12} className="text-[var(--color-accent)]" />
        )}
        <span>
          {smartRouting && routingState?.status === "routing"
            ? "Routing…"
            : routedZone
              ? `Smart → ${routedZone.name}`
              : smartRouting
                ? "Smart chat"
                : current
                  ? `${current.name} · ${current.model}`
                  : "Quick chat"}
        </span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 min-w-[260px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
          <button
            onClick={() => pick(null)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
          >
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--color-panel-hover)]">
              <Zap size={11} className="text-[var(--color-accent)]" />
            </div>
            <div className="flex-1">
              <div>Quick chat</div>
              <div className="text-xs text-[var(--color-text-muted)]">No zone · default model</div>
            </div>
            {!smartRouting && currentZoneId === null && <Check size={12} className="text-[var(--color-accent)]" />}
          </button>
          <button
            onClick={pickSmart}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
          >
            <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[var(--color-panel-hover)]">
              <Brain size={11} className="text-[var(--color-accent)]" />
            </div>
            <div className="flex-1">
              <div>Smart chat</div>
              <div className="text-xs text-[var(--color-text-muted)]">Router picks the best zone per message</div>
            </div>
            {smartRouting && <Check size={12} className="text-[var(--color-accent)]" />}
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          {zones.map((z) => {
            const active = z.id === currentZoneId;
            const ZoneIcon = getZoneIcon(z.icon);
            const color = z.accentColor ?? "var(--color-accent)";
            return (
              <button
                key={z.id}
                onClick={() => pick(z.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
              >
                <div
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
                  style={{ background: color }}
                >
                  <ZoneIcon size={11} color="white" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-1">
                    {z.name}
                    {z.isLeader && <Crown size={11} className="text-amber-500" />}
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">{z.model}</div>
                </div>
                {active && (
                  <Check size={12} className="text-[var(--color-accent)]" />
                )}
              </button>
            );
          })}
          <div className="my-1 border-t border-[var(--color-border)]" />
          <button
            onClick={() => {
              setOpen(false);
              openZoneEditor(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
          >
            <Plus size={12} />
            New zone…
          </button>
          {current && (
            <button
              onClick={() => {
                setOpen(false);
                openZoneEditor(current.id);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-panel-hover)] hover:text-[var(--color-text)]"
            >
              <Layers size={12} />
              Edit "{current.name}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}
