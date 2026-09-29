import { useState } from "react";
import { useApp } from "@/store/app";
import { ToggleRow } from "@/components/common/Toggle";
import { sendTestNotification } from "@/lib/notify";

/**
 * When MultiZone taps you on the shoulder (0.18.3). Two toggles in the Chat
 * page until now; they get a page of their own now that there is more than
 * whether to notify — what a notice may show, and a way to check one arrives.
 */
export function NotificationsTab() {
  const settings = useApp((s) => s.appSettings);
  const set = useApp((s) => s.setAppSettings);
  const [test, setTest] = useState<"sent" | "blocked" | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-medium">Notify me when</h3>
        <p className="mb-2 text-xs text-[var(--color-text-muted)]">Only while the window is in the background.</p>
        <ToggleRow
          label="A run needs my input"
          description="Approvals, questions and plans."
          checked={settings.notifyWhenWaiting}
          onChange={(v) => set({ notifyWhenWaiting: v })}
        />
        <ToggleRow
          label="A run finishes"
          description="An answer, an error, or a stop at a limit."
          checked={settings.notifyWhenFinished}
          onChange={(v) => set({ notifyWhenFinished: v })}
        />
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">How</h3>
        <ToggleRow
          label="Show previews"
          description="The chat's name and the answer's first line."
          checked={settings.notifyPreview}
          onChange={(v) => set({ notifyPreview: v })}
        />
        <ToggleRow
          label="Flash the taskbar"
          checked={settings.notifyFlashTaskbar}
          onChange={(v) => set({ notifyFlashTaskbar: v })}
        />
      </section>
      <section className="flex items-center gap-3">
        <button
          onClick={async () => setTest((await sendTestNotification()) ? "sent" : "blocked")}
          className="rounded border border-[var(--color-border)] px-3 py-1.5 text-xs hover:border-[var(--color-accent)]"
        >
          Send a test
        </button>
        {test === "sent" && <span className="text-xs text-[var(--color-text-muted)]">Sent — it should appear now.</span>}
        {test === "blocked" && (
          <span className="text-xs text-[var(--color-danger)]">Blocked by the system. Allow MultiZone in its notification settings.</span>
        )}
      </section>
    </div>
  );
}
