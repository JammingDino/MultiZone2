import { useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { ChatPanel } from "./components/Chat/ChatPanel";
import { BackgroundEffect } from "./components/BackgroundEffect";
import { TitleBar } from "./components/TitleBar";
import { Onboarding } from "./components/Onboarding/Onboarding";
import { useApp } from "./store/app";
import { seedCuratedLibrary } from "./lib/zoneLibrary";

export default function App() {
  const providersLoaded = useApp((s) => s.providersLoaded);
  const providers = useApp((s) => s.providers);
  const defaultProviderId = useApp((s) => s.appSettings.defaultProviderId);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const appSettingsLoaded = useApp((s) => s.appSettingsLoaded);
  const seededLibrary = useApp((s) => s.appSettings.seededLibrary);
  // Guard against concurrent invocations of the one-time seeder.
  const seedingRef = useRef(false);

  // Once providers exist, make sure a quick-chat provider is selected. Keeps
  // existing installs (upgrading past this feature) working without a trip
  // through onboarding.
  useEffect(() => {
    if (providersLoaded && providers.length > 0 && !defaultProviderId) {
      setAppSettings({ defaultProviderId: providers[0].id });
    }
  }, [providersLoaded, providers, defaultProviderId, setAppSettings]);

  // One-time seeding of the curated zone library onto disk. The curated presets
  // are presented in the Zone Library for the user to install — they are no
  // longer auto-created as live zones. Provider-independent, so it runs as soon
  // as settings load; the seedingRef guard prevents concurrent runs.
  useEffect(() => {
    if (!appSettingsLoaded || seededLibrary || seedingRef.current) return;
    seedingRef.current = true;
    (async () => {
      try {
        await seedCuratedLibrary();
        await setAppSettings({ seededLibrary: true });
      } finally {
        seedingRef.current = false;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appSettingsLoaded, seededLibrary]);

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
        </div>
      </div>
    </div>
  );
}
