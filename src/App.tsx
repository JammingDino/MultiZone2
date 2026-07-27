import { useEffect, useRef } from "react";
import { downloadDir } from "@tauri-apps/api/path";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { ChatPanel } from "./components/Chat/ChatPanel";
import { BackgroundEffect } from "./components/BackgroundEffect";
import { TitleBar } from "./components/TitleBar";
import { Onboarding } from "./components/Onboarding/Onboarding";
import { ShortcutsHelpModal } from "./components/common/ShortcutsHelpModal";
import { useApp } from "./store/app";
import { useGlobalShortcuts } from "./lib/useGlobalShortcuts";
import { seedCuratedLibrary, CURATED_LIBRARY_VERSION } from "./lib/zoneLibrary";
import { seedDefaultZones } from "./lib/defaultZones";
import { seedDefaultSkills } from "./lib/defaultSkills";
import { resolveBaseProvider } from "./lib/baseZone";
import * as api from "./lib/tauri";

export default function App() {
  const providersLoaded = useApp((s) => s.providersLoaded);
  const providers = useApp((s) => s.providers);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const appSettingsLoaded = useApp((s) => s.appSettingsLoaded);
  const libraryCuratedVersion = useApp((s) => s.appSettings.libraryCuratedVersion);
  const seededStarterZones = useApp((s) => s.appSettings.seededStarterZones);
  const seededSkills = useApp((s) => s.appSettings.seededSkills);
  const defaultDirectory = useApp((s) => s.appSettings.defaultDirectory);
  const refreshZones = useApp((s) => s.refreshZones);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const shortcutsHelpOpen = useApp((s) => s.shortcutsHelpOpen);
  const closeShortcutsHelp = useApp((s) => s.closeShortcutsHelp);

  // App-wide keyboard shortcuts (new chat, settings, sidebar, navigation, …).
  useGlobalShortcuts();
  // Guard against concurrent invocations of the one-time seeders.
  const libRef = useRef(false);
  const zonesRef = useRef(false);
  const skillsRef = useRef(false);
  const defaultDirRef = useRef(false);

  // Give the file tools a working directory the first time (0.9.9): Downloads,
  // which exists on every desktop and is where a user already looks for files
  // an app produced. Without it, a chat outside a project has nowhere to read
  // or write and every file tool fails until the user picks a folder. Only
  // fills a blank — a directory the user chose is never moved — and it stays
  // out of settings exports, so each install resolves its own.
  useEffect(() => {
    if (!appSettingsLoaded || defaultDirectory?.trim() || defaultDirRef.current) return;
    defaultDirRef.current = true;
    (async () => {
      try {
        await setAppSettings({ defaultDirectory: await downloadDir() });
      } catch (e) {
        // No Downloads folder (or not running in the Tauri shell) — leave it
        // blank and let the user pick one.
        console.warn("could not default the file directory", e);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettingsLoaded, defaultDirectory]);

  // Seed the curated zone library onto disk (all curated presets, including the
  // community extras). Re-runs when the shipped set version grows so existing
  // installs pick up newly added presets. Provider-independent.
  useEffect(() => {
    if (!appSettingsLoaded || libraryCuratedVersion >= CURATED_LIBRARY_VERSION || libRef.current) return;
    libRef.current = true;
    (async () => {
      try {
        await seedCuratedLibrary();
        await setAppSettings({ seededLibrary: true, libraryCuratedVersion: CURATED_LIBRARY_VERSION });
      } finally {
        libRef.current = false;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettingsLoaded, libraryCuratedVersion]);

  // One-time pre-install of the curated MultiZone zones as live zones, bound to
  // the quick-chat provider + model, so a new user lands with a useful spread of
  // assistants. Only the pre-install set is created (community extras stay in
  // the library). Skipped once done; never sets a default zone.
  useEffect(() => {
    if (!providersLoaded || !appSettingsLoaded || seededStarterZones || zonesRef.current) return;
    // Nothing is seeded yet at this point, so this is just "the first provider"
    // — the same floor Quick Chat falls back to.
    const quick = resolveBaseProvider(providers, [], null);
    const model = quick?.defaultModel?.trim();
    if (!quick || !model) return;
    zonesRef.current = true;
    (async () => {
      try {
        const existing = await api.listZones();
        if (existing.length === 0) {
          await seedDefaultZones(quick.id, model);
          await refreshZones();
        }
        await setAppSettings({ seededStarterZones: true });
      } finally {
        zonesRef.current = false;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providersLoaded, appSettingsLoaded, seededStarterZones, providers]);

  // One-time seed of the built-in skill templates, so the Skills panel starts
  // populated. Only seeds when the user has no skills yet; provider-independent.
  useEffect(() => {
    if (!appSettingsLoaded || seededSkills || skillsRef.current) return;
    skillsRef.current = true;
    (async () => {
      try {
        const existing = await api.listSkills();
        if (existing.length === 0) {
          await seedDefaultSkills();
          await refreshSkills();
        }
        await setAppSettings({ seededSkills: true });
      } finally {
        skillsRef.current = false;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettingsLoaded, seededSkills]);

  // Lock the app behind onboarding until at least one provider exists.
  const showOnboarding = providersLoaded && providers.length === 0;

  return (
    <div className="h-screen w-screen overflow-hidden text-[var(--color-text)]">
      <BackgroundEffect />
      <div className="relative z-10 flex h-full w-full flex-col">
        <TitleBar />
        {/* Onboarding overlays only the content area so the title bar stays
            draggable/resizable while it's up. */}
        <div className="relative flex flex-1 overflow-hidden">
          <Sidebar />
          <ChatPanel />
          {showOnboarding && <Onboarding />}
          {shortcutsHelpOpen && <ShortcutsHelpModal onClose={closeShortcutsHelp} />}
        </div>
      </div>
    </div>
  );
}
