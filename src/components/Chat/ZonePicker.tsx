import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check, Plus, Layers } from "lucide-react";
import { useApp } from "@/store/app";
import { getZoneIcon } from "@/lib/zoneIcons";

interface Props {
  chatId: string;
  currentZoneId: string | null;
}

export function ZonePicker({ chatId, currentZoneId }: Props) {
  const zones = useApp((s) => s.zones);
  const setChatZone = useApp((s) => s.setChatZone);
  const openZoneEditor = useApp((s) => s.openZoneEditor);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = zones.find((z) => z.id === currentZoneId) ?? null;
  const CurrentIcon = getZoneIcon(current?.icon);
  const currentColor = current?.accentColor ?? null;

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

  async function pick(zoneId: string) {
    setOpen(false);
    if (zoneId !== currentZoneId) {
      await setChatZone(chatId, zoneId);
    }
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded border border-transparent px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-border)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
        title="Change zone"
      >
        {current ? (
          <span
            className="flex h-4 w-4 items-center justify-center rounded"
            style={{ background: currentColor ?? "var(--color-accent)" }}
          >
            <CurrentIcon size={10} color="white" />
          </span>
        ) : (
          <Layers size={12} />
        )}
        <span>{current ? `${current.name} · ${current.model}` : "Choose a zone"}</span>
        <ChevronDown size={12} />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 min-w-[260px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg">
          {zones.length === 0 && (
            <div className="px-3 py-2 text-xs text-[var(--color-text-muted)]">No zones yet.</div>
          )}
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
                  <div>{z.name}</div>
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
