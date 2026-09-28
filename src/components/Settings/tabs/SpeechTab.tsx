import { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, FileUp, Mic, AudioLines } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { ToggleRow } from "@/components/common/Toggle";
import type { Provider } from "@/lib/types";
import { PRIMARY_ACTION } from "@/lib/chrome";
import { errorText } from "@/lib/errors";
import { SettingSelect, SliderRow } from "../controls";

const COMMON_TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];

export function SpeechTab() {
  return (
    <div className="flex flex-col gap-6">
      <SpeechSynthesisSettings />
      <div className="border-t border-[var(--color-border)]" />
      <VoiceCloningSettings />
      <div className="border-t border-[var(--color-border)]" />
      <ConversationModeSettings />
    </div>
  );
}

function SpeechSynthesisSettings() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const providers = useApp((s) => s.providers);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [serverVoices, setServerVoices] = useState<string[]>([]);
  const [clonedVoices, setClonedVoices] = useState<string[]>([]);

  useEffect(() => {
    if (!appSettings.ttsProviderId) { setProviderModels([]); return; }
    let cancelled = false;
    api.fetchModels(appSettings.ttsProviderId)
      .then((m) => { if (!cancelled) setProviderModels(m); })
      .catch(() => { if (!cancelled) setProviderModels([]); });
    return () => { cancelled = true; };
  }, [appSettings.ttsProviderId]);

  // Voices advertised by the provider itself (a local shim's /audio/voices),
  // merged with the OpenAI names as datalist suggestions.
  useEffect(() => {
    if (!appSettings.ttsProviderId || !appSettings.ttsModel) { setServerVoices([]); return; }
    let cancelled = false;
    api.listTtsVoices()
      .then((v) => { if (!cancelled) setServerVoices(v); })
      .catch(() => { if (!cancelled) setServerVoices([]); });
    return () => { cancelled = true; };
  }, [appSettings.ttsProviderId, appSettings.ttsModel]);

  useEffect(() => {
    let cancelled = false;
    api.listClonedVoices()
      .then((v) => { if (!cancelled) setClonedVoices(v.map((c) => c.name)); })
      .catch(() => { if (!cancelled) setClonedVoices([]); });
    return () => { cancelled = true; };
  }, [appSettings.ttsVoice]);

  const voiceOptions = Array.from(new Set([...clonedVoices, ...serverVoices, ...COMMON_TTS_VOICES]));

  return (
    <>
      <section>
        <h3 className="mb-1 text-sm font-medium">Speech (read aloud)</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Any provider with an OpenAI-compatible <span className="font-mono">/audio/speech</span>{" "}
          endpoint, including a local one.
        </p>
        {providers.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No providers configured yet — add one in the Providers tab, then choose it here.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--color-text-muted)]">Provider</p>
            <SettingSelect
              value={appSettings.ttsProviderId ?? ""}
              onChange={(v) => setAppSettings({ ttsProviderId: v || null, ttsModel: "" })}
            >
              <option value="">— choose a provider —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </SettingSelect>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Model</p>
            <ModelCombobox
              value={appSettings.ttsModel}
              onChange={(v) => setAppSettings({ ttsModel: v })}
              options={providerModels}
              placeholder="e.g. tts-1"
              className="input"
            />
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Voice</p>
            <input
              type="text"
              list="tts-voice-options"
              value={appSettings.ttsVoice}
              onChange={(e) => setAppSettings({ ttsVoice: e.target.value.trim() })}
              placeholder="e.g. alloy"
              spellCheck={false}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <datalist id="tts-voice-options">
              {voiceOptions.map((v) => <option key={v} value={v} />)}
            </datalist>
            {serverVoices.length > 0 && (
              <p className="text-[11px] text-[var(--color-text-muted)]">
                Voices from this provider: {serverVoices.map((v) => (
                  <button
                    key={v}
                    onClick={() => setAppSettings({ ttsVoice: v })}
                    className={`mr-1 rounded px-1.5 py-0.5 ${appSettings.ttsVoice === v ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]" : "hover:bg-[var(--color-panel-hover)]"}`}
                  >
                    {v}
                  </button>
                ))}
              </p>
            )}
            <p className="text-[11px] text-[var(--color-text-muted)]">A zone can set its own voice.</p>
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Speed</h3>
        <SliderRow
          label="Playback speed"
          value={Math.round(appSettings.ttsRate * 100)}
          min={50}
          max={200}
          step={5}
          display={`${appSettings.ttsRate.toFixed(2)}×`}
          onChange={(v) => setAppSettings({ ttsRate: v / 100 })}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Summarize long responses</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">Speak a short summary of long answers.</p>
        <ToggleRow
          label="Auto-summarize before speaking"
          checked={appSettings.ttsAutoSummarize}
          onChange={(v) => setAppSettings({ ttsAutoSummarize: v })}
        />
        {appSettings.ttsAutoSummarize && (
          <div className="mt-2">
            <SliderRow
              label="Summarize above"
              value={appSettings.ttsSummarizeThreshold}
              min={300}
              max={4000}
              step={100}
              display={`${appSettings.ttsSummarizeThreshold} chars`}
              onChange={(v) => setAppSettings({ ttsSummarizeThreshold: v })}
            />
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Auto-speak</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">Reads answers aloud as they arrive.</p>
        <ToggleRow
          label="Speak responses automatically"
          checked={appSettings.ttsAutoSpeak}
          onChange={(v) => setAppSettings({ ttsAutoSpeak: v })}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Prefetch</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">Sentences prepared ahead. Higher means fewer gaps.</p>
        <SliderRow
          label="Sentences ahead"
          value={appSettings.ttsPrefetch}
          min={1}
          max={8}
          step={1}
          display={appSettings.ttsPrefetch === 1 ? "1 (sequential)" : `${appSettings.ttsPrefetch}`}
          onChange={(v) => setAppSettings({ ttsPrefetch: v })}
        />
      </section>
    </>
  );
}

// ─── Voice cloning (0.8.3) ────────────────────────────────────────────────────

function VoiceCloningSettings() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const supported = appSettings.ttsSupportsCloning;

  const [name, setName] = useState("");
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [refText, setRefText] = useState("");
  const [busy, setBusy] = useState<null | "transcribing" | "creating">(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [voices, setVoices] = useState<import("@/lib/tauri").ClonedVoice[]>([]);

  const canConfigureProvider = !!appSettings.ttsProviderId && !!appSettings.ttsModel;

  const refreshVoices = () => {
    api.listClonedVoices().then(setVoices).catch(() => setVoices([]));
  };
  useEffect(() => { refreshVoices(); }, []);

  async function pickAudio() {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "flac", "webm"] }],
    });
    if (typeof picked === "string") { setAudioPath(picked); setMsg(null); }
  }

  async function autoTranscribe() {
    if (!audioPath) return;
    setBusy("transcribing"); setMsg(null);
    try {
      const text = await api.transcribeAudioFile(audioPath);
      setRefText(text);
    } catch (e) {
      setMsg({ kind: "err", text: `Transcription failed. ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function createVoice() {
    if (!name.trim() || !audioPath) return;
    setBusy("creating"); setMsg(null);
    try {
      const saved = await api.createClonedVoice(name.trim(), audioPath, refText.trim());
      setMsg({ kind: "ok", text: `Created voice "${saved}". Set it as your voice above or per-zone.` });
      setName(""); setAudioPath(null); setRefText("");
      refreshVoices();
    } catch (e) {
      setMsg({ kind: "err", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  const fileName = audioPath ? audioPath.split(/[\\/]/).pop() : null;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <AudioLines size={14} className="text-[var(--color-accent)]" />
        <h3 className="text-sm font-medium">Voice cloning</h3>
      </div>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">For local models that clone a voice from a sample, like F5-TTS.</p>
      <ToggleRow
        label="My speech model supports voice cloning"
        checked={supported}
        onChange={(v) => setAppSettings({ ttsSupportsCloning: v })}
      />

      {!supported ? null : !canConfigureProvider ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          Choose a speech provider and model above first.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-[var(--color-border)] p-3">
          <div>
            <p className="mb-1 text-xs text-[var(--color-text-muted)]">Voice name</p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. my-voice"
              spellCheck={false}
              className="input"
            />
          </div>

          <div>
            <p className="mb-1 text-xs text-[var(--color-text-muted)]">Reference sample</p>
            <div className="flex items-center gap-2">
              <button
                onClick={pickAudio}
                className="flex items-center gap-1.5 rounded border border-[var(--color-border)] px-2.5 py-1.5 text-xs hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <FileUp size={12} /> Choose audio…
              </button>
              {fileName && <span className="truncate text-xs text-[var(--color-text-muted)]">{fileName}</span>}
            </div>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              3–10 seconds of clean, single-speaker speech works best.
            </p>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <p className="text-xs text-[var(--color-text-muted)]">Sample transcript (optional)</p>
              <button
                onClick={autoTranscribe}
                disabled={!audioPath || busy !== null}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-[var(--color-accent)] hover:bg-[var(--color-panel-hover)] disabled:opacity-40"
                title="Transcribe the sample using your dictation provider"
              >
                {busy === "transcribing" ? <Loader2 size={11} className="animate-spin" /> : <Mic size={11} />}
                Auto-transcribe
              </button>
            </div>
            <textarea
              value={refText}
              onChange={(e) => setRefText(e.target.value)}
              rows={2}
              placeholder="Exact words spoken in the sample. Leave empty to let the server transcribe it."
              className="input font-normal"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={createVoice}
              disabled={!name.trim() || !audioPath || busy !== null}
              className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs ${PRIMARY_ACTION}`}
            >
              {busy === "creating" ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              Create voice
            </button>
            {msg && (
              <span className={`text-xs ${msg.kind === "ok" ? "text-emerald-500" : "text-red-500"}`}>
                {msg.text}
              </span>
            )}
          </div>

          {voices.length > 0 && (
            <div className="border-t border-[var(--color-border)] pt-2">
              <p className="mb-1 text-[11px] text-[var(--color-text-muted)]">Your cloned voices</p>
              <div className="flex flex-col gap-1">
                {voices.map((v) => (
                  <div key={v.name} className="flex items-center gap-2">
                    <button
                      onClick={() => setAppSettings({ ttsVoice: v.name })}
                      className={`rounded-full border px-2 py-0.5 text-xs ${appSettings.ttsVoice === v.name ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]" : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-accent)]"}`}
                      title="Use this voice"
                    >
                      {v.name}{appSettings.ttsVoice === v.name ? " ✓" : ""}
                    </button>
                    {v.refText && (
                      <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={v.refText}>
                        {v.refText}
                      </span>
                    )}
                    <button
                      onClick={async () => { await api.deleteClonedVoice(v.name); refreshVoices(); }}
                      className="text-[var(--color-text-muted)] hover:text-red-500"
                      title="Delete voice"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Hands-free conversation mode (0.8.2) ─────────────────────────────────────

function ConversationModeSettings() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  return (
    <section>
      <h3 className="mb-1 text-sm font-medium">Conversation mode (hands-free)</h3>
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">Hands-free: the mic reopens after each answer. Needs dictation and speech.</p>
      <ToggleRow
        label="Enable conversation mode"
        checked={appSettings.voiceConversationEnabled}
        onChange={(v) => setAppSettings({ voiceConversationEnabled: v })}
      />
    </section>
  );
}

// ─── Skills ─────────────────────────────────────────────────────────────────────
