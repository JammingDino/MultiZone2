import { useState } from "react";
import { Shield } from "lucide-react";
import { Modal } from "@/components/common/Modal";
import { Markdown } from "@/components/Renderers/Markdown";
import statement from "../../../docs/PRIVACY.md?raw";

/**
 * The privacy statement, readable inside the app and offline.
 *
 * It is bundled rather than linked, which is the only version of this that is
 * consistent with what it says: an app whose first claim is that it needs no
 * network should not require one to explain itself, and a link is also a dead
 * end for anyone reading it before the repository is public. The source of
 * truth stays [docs/PRIVACY.md](../../../docs/PRIVACY.md) — this imports that
 * exact file, so the two cannot drift.
 */
export function PrivacyStatementModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} header={<h2 className="text-sm font-medium">Privacy</h2>}>
      <div className="h-full overflow-auto px-1">
        <Markdown source={statement} fontSize="13px" plainTables />
      </div>
    </Modal>
  );
}

/**
 * The button that opens it. Used in Settings → Data and in first-run setup —
 * the two places someone forms a view about what this app does with their data.
 */
export function PrivacyStatementLink({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1 text-xs transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] ${className}`}
      >
        <Shield size={12} />
        Read the privacy statement
      </button>
      {open && <PrivacyStatementModal onClose={() => setOpen(false)} />}
    </>
  );
}
