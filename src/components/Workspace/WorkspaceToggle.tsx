import { PanelRight } from "lucide-react";
import { useApp } from "@/store/app";
import { CHROME_ACTIVE, CHROME_QUIET, HEADER_ICON } from "@/lib/chrome";

/** Header button that shows or hides the workspace panel (0.17.9). */
export function WorkspaceToggle() {
  const open = useApp((s) => s.workspaceOpen);
  const setOpen = useApp((s) => s.setWorkspaceOpen);
  return (
    <button
      onClick={() => setOpen(!open)}
      title={open ? "Hide the workspace panel" : "Show the workspace panel — plan, terminals, files, context"}
      aria-pressed={open}
      className={`flex items-center gap-1 rounded px-1.5 py-1 text-xs ${open ? CHROME_ACTIVE : CHROME_QUIET}`}
    >
      <PanelRight size={HEADER_ICON} />
    </button>
  );
}
