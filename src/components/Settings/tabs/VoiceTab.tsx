import { useEffect, useState } from "react";
import { useApp } from "@/store/app";
import * as api from "@/lib/tauri";
import { ModelCombobox } from "@/components/common/ModelCombobox";
import { isRemote } from "@/lib/remote/transport";
import { Toggle, ToggleRow } from "@/components/common/Toggle";
import type { Provider } from "@/lib/types";
import { reportError } from "@/lib/reportError";
import { OptionCards, SettingSelect, SliderRow } from "../controls";
import { LocalDictation, LOCAL_STT_PROVIDER } from "../LocalDictation";

export function VoiceTab() {
  const appSettings = useApp((s) => s.appSettings);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const providers = useApp((s) => s.providers);
  const voiceInputDevices = useApp((s) => s.voiceInputDevices);
  const refreshVoiceInputDevices = useApp((s) => s.refreshVoiceInputDevices);
  const [providerModels, setProviderModels] = useState<string[]>([]);

  useEffect(() => {
    if (!appSettings.sttProviderId || appSettings.sttProviderId === LOCAL_STT_PROVIDER) { setProviderModels([]); return; }
    let cancelled = false;
    api.fetchModels(appSettings.sttProviderId)
      .then((m) => { if (!cancelled) setProviderModels(m); })
      .catch(() => { if (!cancelled) setProviderModels([]); });
    return () => { cancelled = true; };
  }, [appSettings.sttProviderId]);

  useEffect(() => {
    refreshVoiceInputDevices().catch(reportError("Couldn't list microphones"));
  }, [refreshVoiceInputDevices]);

  const local = appSettings.sttProviderId === LOCAL_STT_PROVIDER;

  return (
    <div className="flex flex-col gap-6">
      {/* The download and the server live on the desktop, so a phone
          driving it remotely cannot set this up from here. */}
      {!isRemote() && <LocalDictation />}

      <section>
        <h3 className="mb-1 text-sm font-medium">Dictation provider</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Any provider with an OpenAI-compatible <span className="font-mono">/audio/transcriptions</span>{" "}
          endpoint — including a local whisper server, which keeps recordings on this machine.
        </p>
        {local ? (
          <p className="text-xs text-[var(--color-text-muted)]">
            Using this computer (see above).{" "}
            <button
              onClick={() => setAppSettings({ sttProviderId: null, sttModel: "" })}
              className="underline hover:text-[var(--color-text)]"
            >
              Use a provider instead
            </button>
          </p>
        ) : providers.length === 0 ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            No providers configured yet — add one in the Providers tab, then choose it here.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--color-text-muted)]">Provider</p>
            <SettingSelect
              value={appSettings.sttProviderId ?? ""}
              onChange={(v) => setAppSettings({ sttProviderId: v || null, sttModel: "" })}
            >
              <option value="">— choose a provider —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </SettingSelect>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Model</p>
            <ModelCombobox
              value={appSettings.sttModel}
              onChange={(v) => setAppSettings({ sttModel: v })}
              options={providerModels}
              placeholder="e.g. whisper-1"
              className="input"
            />
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Audio uploads</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">Audio dropped into the composer is transcribed for models that can't hear.</p>
        {(!appSettings.sttProviderId || !appSettings.sttModel) && (
          <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
            Audio uploads need the transcription provider above configured first.
          </p>
        )}

        <p className="mb-2 text-xs text-[var(--color-text-muted)]">When a transcript is ready</p>
        <OptionCards
          value={appSettings.sttUploadMode}
          onChange={(sttUploadMode) => setAppSettings({ sttUploadMode })}
          options={[
            ["quick", "Use it", "Put the transcript straight into the message box"],
            ["review", "Review first", "Read and correct it on the chip before sending"],
          ]}
        />

        <p className="mb-2 mt-4 text-xs text-[var(--color-text-muted)]">How it reaches the model</p>
        <OptionCards
          value={appSettings.sttUploadInjection}
          onChange={(sttUploadInjection) => setAppSettings({ sttUploadInjection })}
          options={[
            ["message", "As my message", "The transcript becomes the text you send"],
            ["context", "As an attachment", "Model reads it as context; the message box stays yours"],
          ]}
        />

        <div className="mt-4">
          <ToggleRow
            label="Include timestamps and language"
            description="Timings and detected language, where supported."
            checked={appSettings.sttUploadMetadata}
            onChange={(sttUploadMetadata) => setAppSettings({ sttUploadMetadata })}
          />
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <SliderRow
            label="Maximum file size"
            value={appSettings.sttUploadMaxMb}
            min={1}
            max={200}
            step={1}
            display={`${appSettings.sttUploadMaxMb} MB`}
            onChange={(sttUploadMaxMb) => setAppSettings({ sttUploadMaxMb })}
          />
          <SliderRow
            label="Maximum duration"
            value={appSettings.sttUploadMaxMinutes}
            min={0}
            max={480}
            step={5}
            display={
              appSettings.sttUploadMaxMinutes === 0
                ? "no limit"
                : `${appSettings.sttUploadMaxMinutes} min`
            }
            onChange={(sttUploadMaxMinutes) => setAppSettings({ sttUploadMaxMinutes })}
          />
        </div>
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">OpenAI's limit is 25 MB.</p>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Language</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">e.g. <span className="font-mono">en</span>. Empty auto-detects.</p>
        <input
          type="text"
          value={appSettings.sttLanguage}
          onChange={(e) => setAppSettings({ sttLanguage: e.target.value.trim() })}
          placeholder="auto-detect"
          spellCheck={false}
          className="w-32 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Input device</h3>
        {isRemote() ? (
          /* The list is the *desktop's* microphones, and a phone does not use
             them: it records here and sends the audio over for your computer to
             transcribe with the provider above. Offering the choice anyway
             would be a picker that changes nothing. */
          <p className="text-xs text-[var(--color-text-muted)]">Recorded here, converted on your computer (needs ffmpeg).</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-[var(--color-text-muted)]">
              Microphone used for dictation.
            </p>
            <SettingSelect
              value={appSettings.sttInputDevice ?? ""}
              onChange={(v) => setAppSettings({ sttInputDevice: v || null })}
            >
              <option value="">System default</option>
              {voiceInputDevices.map((d) => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </SettingSelect>
          </>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Activation mode</h3>
        <OptionCards
          value={appSettings.sttActivationMode}
          onChange={(sttActivationMode) => setAppSettings({ sttActivationMode })}
          options={[
            ["toggle", "Toggle", "Click to start, click again to stop"],
            ["hold", "Hold", "Press and hold to record (push-to-talk)"],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Insertion mode</h3>
        <OptionCards
          value={appSettings.sttInsertionMode}
          onChange={(sttInsertionMode) => setAppSettings({ sttInsertionMode })}
          options={[
            ["cursor", "At cursor", "Insert the transcript at the cursor position"],
            ["replace", "Replace field", "Replace the entire input field with the transcript"],
          ]}
        />
      </section>

      <section>
        <h3 className="mb-1 text-sm font-medium">Live transcription</h3>
        <p className="mb-3 text-xs text-[var(--color-text-muted)]">
          Re-transcribes the recording on an interval. Each pass is a full request — free against
          a local server, billed per call against a hosted one.
          {isRemote() && (
            /* The desktop re-transcribes the utterance so far every couple of
               seconds. Doing that from a phone means re-uploading the whole
               recording on every tick, so the phone does not — and a switch
               that is on while nothing happens is worse than one that explains
               itself. */
            <>
              {" "}
              <span className="text-[var(--color-text)]">
                This device does not do this: it would re-upload the whole recording on every
                pass. The setting below applies when you dictate on the computer itself.
              </span>
            </>
          )}
        </p>
        <ToggleRow
          label="Show words while speaking"
          checked={appSettings.sttLivePartialMs > 0}
          onChange={(v) => setAppSettings({ sttLivePartialMs: v ? 1500 : 0 })}
        />
        {appSettings.sttLivePartialMs > 0 && (
          <div className="mt-2">
            <SliderRow
              label="Refresh interval"
              value={appSettings.sttLivePartialMs}
              min={500}
              max={5000}
              step={250}
              display={`${appSettings.sttLivePartialMs}ms`}
              onChange={(v) => setAppSettings({ sttLivePartialMs: v })}
            />
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-3 text-sm font-medium">Auto-send on silence</h3>
        <ToggleRow
          label="Auto-send after silence"
          checked={appSettings.sttAutoSendSilenceMs > 0}
          onChange={(v) => setAppSettings({ sttAutoSendSilenceMs: v ? 1200 : 0 })}
        />
        {appSettings.sttAutoSendSilenceMs > 0 && (
          <div className="mt-2">
            <SliderRow
              label="Silence threshold"
              value={appSettings.sttAutoSendSilenceMs}
              min={500}
              max={3000}
              step={100}
              display={`${appSettings.sttAutoSendSilenceMs}ms`}
              onChange={(v) => setAppSettings({ sttAutoSendSilenceMs: v })}
            />
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Text-to-speech (0.8.1) ───────────────────────────────────────────────────
