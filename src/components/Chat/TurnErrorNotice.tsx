import { useState } from "react";
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, RotateCw, Settings as SettingsIcon, X } from "lucide-react";
import { useApp } from "@/store/app";
import { CHROME_QUIET } from "@/lib/chrome";
import { friendlyError } from "@/lib/errors";

/** A provider error nothing recognised: say what failed rather than "something". */
const TURN_FAILED = {
  headline: "The response failed",
  hint: "The provider returned an error instead of a reply.",
  action: "retry" as const,
};

/**
 * What went wrong with the last turn (1.0).
 *
 * A failed provider call — bad key, no credit, rate limit, model that doesn't
 * exist, host unreachable — never produces an assistant message, so before this
 * the turn rendered as nothing at all: you sent a message and the app just sat
 * there. The backend has always reported these; they were being dropped on the
 * floor by the store. Now each one lands here.
 *
 * Provider errors are long and JSON-ish, so the headline is a short plain-English
 * reading of it and the raw text is one click away. The offered action follows
 * the cause: a key or model problem is fixed in Settings, a network blip is
 * usually fixed by trying again.
 */
export function TurnErrorNotice({ chatId }: { chatId: string }) {
  const errors = useApp((s) => s.errorsByChat[chatId]);
  const zones = useApp((s) => s.zones);
  const dismiss = useApp((s) => s.dismissChatErrors);
  const openSettings = useApp((s) => s.openSettings);

  if (!errors || errors.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {errors.map((e, i) =>
        e.kind === "runaway" ? (
          <RunawayCard
            key={i}
            message={e.message}
            zoneName={e.zoneId ? zones.find((z) => z.id === e.zoneId)?.name ?? "A perspective zone" : null}
            onDismiss={() => dismiss(chatId)}
          />
        ) : (
          <ErrorCard
            key={i}
            message={e.message}
            zoneName={e.zoneId ? zones.find((z) => z.id === e.zoneId)?.name ?? "A perspective zone" : null}
            onDismiss={() => dismiss(chatId)}
            onOpenSettings={openSettings}
          />
        ),
      )}
    </div>
  );
}

/**
 * A run loop detection stopped (0.14.1).
 *
 * Amber rather than red, and no action offered: nothing failed, and the two
 * things an error card suggests — open settings, send it again — are both wrong
 * here. The model is still writing its account of what happened, which arrives
 * as the next message, so this card says what was noticed and gets out of the
 * way.
 */
function RunawayCard({
  message, zoneName, onDismiss,
}: {
  message: string;
  zoneName: string | null;
  onDismiss: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-px shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-amber-400">
            {zoneName ? `${zoneName} was going in circles` : "This run was going in circles"}
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{message}.</div>
          <div className="mt-1 text-xs text-[var(--color-text-muted)]">
            Tools were withdrawn for the rest of the turn — the reply below is what it made of it.
          </div>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className={`shrink-0 rounded p-1 ${CHROME_QUIET}`}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function ErrorCard({
  message, zoneName, onDismiss, onOpenSettings,
}: {
  message: string;
  zoneName: string | null;
  onDismiss: () => void;
  onOpenSettings: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const { headline, hint, action } = friendlyError(message, TURN_FAILED);

  return (
    <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5 p-3">
      <div className="flex items-start gap-2.5">
        <AlertCircle size={16} className="mt-px shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-[var(--color-danger)]">
            {zoneName ? `${zoneName}: ${headline.charAt(0).toLowerCase()}${headline.slice(1)}` : headline}
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{hint}</div>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            {action === "settings" && (
              <button
                onClick={onOpenSettings}
                className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <SettingsIcon size={12} />
                Open settings
              </button>
            )}
            {action === "retry" && (
              <span className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
                <RotateCw size={12} />
                Send the message again to retry
              </span>
            )}
            <button
              onClick={() => setShowRaw((v) => !v)}
              className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >
              {showRaw ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {showRaw ? "Hide details" : "Show details"}
            </button>
          </div>

          {showRaw && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] p-2 text-[11px] text-[var(--color-text-muted)]">
              {message}
            </pre>
          )}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className={`shrink-0 rounded p-1 ${CHROME_QUIET}`}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
