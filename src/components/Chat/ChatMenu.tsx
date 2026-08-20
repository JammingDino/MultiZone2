import { useRef, useState } from "react";
import { Download, FileText, FileType, History, Loader2, MoreHorizontal } from "lucide-react";
import { useApp } from "@/store/app";
import { CHROME_ACTIVE, CHROME_QUIET, HEADER_ICON } from "@/lib/chrome";
import { Popover } from "@/components/common/Popover";
import { useChatExport } from "@/lib/useChatExport";

/**
 * The chat's own menu — replay and export, in the place people look for them.
 *
 * Replay and the Markdown/PDF exports were each a bare icon in the header row
 * (#13): a clock glyph with no label beside eight other controls, which is not
 * where anyone looks for "let me see this run again" or "give me this
 * conversation as a file". They were also the first things squeezed off the row
 * on a narrow window. One labelled "..." with named entries instead — the
 * standard place for per-document actions — and the same entries appear on the
 * sidebar's right-click menu.
 */
export function ChatMenu({ chatId }: { chatId: string }) {
  const openReplay = useApp((s) => s.openReplay);
  const { busy, exportAs } = useChatExport(chatId);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  async function run(kind: "md" | "pdf") {
    setOpen(false);
    await exportAs(kind);
  }

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title="Chat actions — replay this session, export it"
        className={`rounded p-1.5 ${open ? CHROME_ACTIVE : CHROME_QUIET}`}
      >
        {busy ? (
          <Loader2 size={HEADER_ICON} className="animate-spin" />
        ) : (
          <MoreHorizontal size={HEADER_ICON} />
        )}
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={buttonRef}
        align="end"
        className="min-w-[230px] rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] py-1 shadow-lg"
      >
        <div>
          <button
            onClick={() => {
              setOpen(false);
              openReplay(chatId);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-hover)]"
          >
            <History size={13} className="text-[var(--color-text-muted)]" />
            View replay session
          </button>
          <div className="px-3 pb-1 pl-8 text-xs text-[var(--color-text-muted)]">
            Every tool call, approval, failure and plan decision, in order.
          </div>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <div className="flex items-center gap-2 px-3 py-1 text-xs text-[var(--color-text-muted)]">
            <Download size={11} />
            Export
          </div>
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
      </Popover>
    </>
  );
}
