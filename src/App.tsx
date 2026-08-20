import { useEffect, useRef } from "react";
import { downloadDir } from "@tauri-apps/api/path";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { ChatPanel } from "./components/Chat/ChatPanel";
import { BackgroundEffect } from "./components/BackgroundEffect";
import { BootSplash } from "./components/BootSplash";
import { TitleBar } from "./components/TitleBar";
import { Onboarding } from "./components/Onboarding/Onboarding";
import { NoProviderBanner } from "./components/Onboarding/NoProviderBanner";
import { ImportSettingsDialog } from "./components/Settings/ImportSettingsDialog";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { ShortcutsHelpModal } from "./components/common/ShortcutsHelpModal";
import { CommandPalette } from "@/components/CommandPalette";
import { useApp } from "./store/app";
import { useGlobalShortcuts } from "./lib/useGlobalShortcuts";
import { usePdfReadBridge } from "./lib/usePdfReadBridge";
import { seedCuratedLibrary, CURATED_LIBRARY_VERSION } from "./lib/zoneLibrary";
import { seedDefaultZones } from "./lib/defaultZones";
import { seedDefaultSkills, SKILL_SEED_VERSION } from "./lib/defaultSkills";
import { resolveBaseProvider } from "./lib/baseZone";
import * as api from "./lib/tauri";
import { installPerfHandle, mark, markInteractive } from "./lib/perf";

export default function App() {
  const providersLoaded = useApp((s) => s.providersLoaded);
  const providers = useApp((s) => s.providers);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const appSettingsLoaded = useApp((s) => s.appSettingsLoaded);
  const libraryCuratedVersion = useApp((s) => s.appSettings.libraryCuratedVersion);
  const seededStarterZones = useApp((s) => s.appSettings.seededStarterZones);
  const seededSkills = useApp((s) => s.appSettings.seededSkills);
  const seededSkillsVersion = useApp((s) => s.appSettings.seededSkillsVersion);
  const defaultDirectory = useApp((s) => s.appSettings.defaultDirectory);
  const onboardingSkipped = useApp((s) => s.appSettings.onboardingSkipped);
  const accent = useApp((s) => s.theme.accent);
  const refreshZones = useApp((s) => s.refreshZones);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const shortcutsHelpOpen = useApp((s) => s.shortcutsHelpOpen);
  const closeShortcutsHelp = useApp((s) => s.closeShortcutsHelp);

  // Launch marks, off unless `localStorage.mzPerf = "1"` — see lib/perf.ts. The
  // 1.0.0 performance item wants a number, and this is where the number starts.
  useEffect(() => {
    installPerfHandle();
    mark("app mounted");
  }, []);
  // "Interactive" is providers *and* settings resolved: before both, the window
  // is drawn but every control in it is still guessing.
  useEffect(() => {
    if (providersLoaded && appSettingsLoaded) markInteractive();
  }, [providersLoaded, appSettingsLoaded]);

  // App-wide keyboard shortcuts (new chat, settings, sidebar, navigation, …).
  useGlobalShortcuts();
  // Answers `read_file`'s PDF page requests — the rasterizer is PDF.js, and it
  // lives in the window (see lib/usePdfReadBridge.ts).
  usePdfReadBridge();
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

  // Seed the built-in skill templates, so the Skills panel starts populated.
  // Provider-independent. Runs on first launch, and again whenever the shipped
  // set grows past what this install has seen — otherwise a skill added in a
  // later version would only ever reach brand-new installs.
  useEffect(() => {
    if (!appSettingsLoaded || skillsRef.current) return;
    if (seededSkills && seededSkillsVersion >= SKILL_SEED_VERSION) return;
    skillsRef.current = true;
    (async () => {
      try {
        const existing = await api.listSkills();
        // On a genuine first run into a catalog the user has already filled
        // themselves, stay out of it — they built that list deliberately. A
        // later top-up is a different matter: the install has accepted the
        // built-ins before, so the ones added since are filled in by name.
        const theirs = !seededSkills && existing.length > 0;
        if (!theirs && (await seedDefaultSkills(existing.map((s) => s.name))) > 0) {
          await refreshSkills();
        }
        await setAppSettings({ seededSkills: true, seededSkillsVersion: SKILL_SEED_VERSION });
      } finally {
        skillsRef.current = false;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettingsLoaded, seededSkills, seededSkillsVersion]);

  // First-run setup, until a provider exists or the user waves it away. Skipping
  // swaps the overlay for a banner rather than leaving the state unexplained —
  // see `onboardingSkipped`. Both wait on appSettingsLoaded so a skip recorded
  // last session doesn't flash the overlay on the way in.
  const ready = providersLoaded && appSettingsLoaded;
  const noProvider = ready && providers.length === 0;
  const showOnboarding = noProvider && !onboardingSkipped;
  const showNoProviderBanner = noProvider && onboardingSkipped;

  return (
    <div className="h-screen w-screen overflow-hidden text-[var(--color-text)]">
      <BackgroundEffect />
      <div className="relative z-10 flex h-full w-full flex-col">
        <TitleBar />
        {showNoProviderBanner && <NoProviderBanner />}
        {/* Onboarding overlays only the content area so the title bar stays
            draggable/resizable while it's up. */}
        <div className="relative flex flex-1 overflow-hidden">
          <Sidebar />
          <ChatPanel />
          {showOnboarding && <Onboarding />}
          {shortcutsHelpOpen && <ShortcutsHelpModal onClose={closeShortcutsHelp} />}
          {/* Above the panels but inside the content area, so the title bar
              stays draggable while it is up (same reasoning as onboarding). */}
          <CommandPalette />
        </div>
      </div>
      {/* App-wide so the confirmation can sit above onboarding as well as the
          chat — a settings file may be dropped or picked from either. */}
      <ImportSettingsDialog />
      {/* Checks for a new release shortly after launch and only appears if it
          finds one — see UpdatePrompt for why the failures stay quiet. */}
      <UpdatePrompt />
      {/* Last child, and above everything: it covers the window while the first
          frame settles. */}
      <BootSplash />
    </div>
  );
}
