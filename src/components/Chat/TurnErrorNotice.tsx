import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, RotateCw, Settings as SettingsIcon, X } from "lucide-react";
import { useApp } from "@/store/app";
import { CHROME_QUIET } from "@/lib/chrome";

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
      {errors.map((e, i) => (
        <ErrorCard
          key={i}
          message={e.message}
          zoneName={e.zoneId ? zones.find((z) => z.id === e.zoneId)?.name ?? "A perspective zone" : null}
          onDismiss={() => dismiss(chatId)}
          onOpenSettings={openSettings}
        />
      ))}
    </div>
  );
}

/** Turn a raw provider/transport error into something worth reading. */
function explain(raw: string): { headline: string; hint: string; action: "settings" | "retry" } {
  const s = raw.toLowerCase();

  if (s.includes("401") || s.includes("unauthorized") || s.includes("invalid_api_key") || s.includes("invalid api key")) {
    return {
      headline: "The provider rejected your API key",
      hint: "Check the key for this provider in Settings → Providers.",
      action: "settings",
    };
  }
  if (s.includes("403") || s.includes("forbidden")) {
    return {
      headline: "The provider refused the request",
      hint: "The key may lack access to this model, or the account may be restricted.",
      action: "settings",
    };
  }
  if (s.includes("429") || s.includes("rate limit") || s.includes("quota")) {
    return {
      headline: "Rate limited or out of quota",
      hint: "The provider is asking you to slow down, or the account is out of credit. Wait a moment and try again.",
      action: "retry",
    };
  }
  if (s.includes("404") || s.includes("model_not_found") || s.includes("does not exist")) {
    return {
      headline: "That model isn't available on this provider",
      hint: "The zone's model name may be wrong, or the provider may not serve it. Check the zone's model in Settings.",
      action: "settings",
    };
  }
  if (s.includes("context length") || s.includes("context_length") || s.includes("too many tokens") || s.includes("maximum context")) {
    return {
      headline: "The conversation is too long for this model",
      hint: "Start a new chat, or switch to a model with a larger context window.",
      action: "settings",
    };
  }
  if (
    s.includes("connection refused") || s.includes("dns") || s.includes("timed out") ||
    s.includes("timeout") || s.includes("unreachable") || s.includes("error sending request") ||
    s.includes("tcp connect") || s.includes("network")
  ) {
    return {
      headline: "Couldn't reach the provider",
      hint: "Check the base URL, and that the server is running if it's a local one like Ollama or LM Studio.",
      action: "retry",
    };
  }
  if (s.includes("no provider") || s.includes("no default model") || s.includes("not configured")) {
    return {
      headline: "This chat has no model configured",
      hint: "Pick a provider and model for this zone in Settings.",
      action: "settings",
    };
  }
  if (s.includes("500") || s.includes("502") || s.includes("503") || s.includes("overloaded")) {
    return {
      headline: "The provider had a server error",
      hint: "This is on their end. Trying again usually works.",
      action: "retry",
    };
  }
  return {
    headline: "The response failed",
    hint: "The provider returned an error instead of a reply.",
    action: "retry",
  };
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
  const { headline, hint, action } = explain(message);

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
                className="flex items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-xs hover:border-[var(--color-accent)]"
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
