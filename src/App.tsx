import { useEffect, useRef } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { ChatPanel } from "./components/Chat/ChatPanel";
import { BackgroundEffect } from "./components/BackgroundEffect";
import { TitleBar } from "./components/TitleBar";
import { Onboarding } from "./components/Onboarding/Onboarding";
import { useApp } from "./store/app";
import { seedDefaultZones } from "./lib/defaultZones";
import * as api from "./lib/tauri";

export default function App() {
  const providersLoaded = useApp((s) => s.providersLoaded);
  const providers = useApp((s) => s.providers);
  const defaultProviderId = useApp((s) => s.appSettings.defaultProviderId);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const appSettingsLoaded = useApp((s) => s.appSettingsLoaded);
  const seededStarterZones = useApp((s) => s.appSettings.seededStarterZones);
  const refreshZones = useApp((s) => s.refreshZones);
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

  // One-time starter-zone seeding for existing installs (new users get them via
  // onboarding, which sets the flag itself). Only seeds when the user has no
  // zones and a quick-chat model is available; never re-runs and never sets a
  // default zone — that stays a user choice in Settings.
  //
  // `zones` is intentionally excluded from deps: we fetch from the API directly
  // to avoid acting on stale store state (zones may not have loaded yet when
  // this effect first fires). The seedingRef guard prevents concurrent runs.
  useEffect(() => {
    if (!providersLoaded || !appSettingsLoaded || seededStarterZones || seedingRef.current) return;
    const quick = providers.find((p) => p.id === (defaultProviderId ?? providers[0]?.id)) ?? null;
    const model = quick?.defaultModel?.trim();
    if (!quick || !model) return;
    seedingRef.current = true;
    (async () => {
      try {
        const existingZones = await api.listZones();
        if (existingZones.length === 0) {
          await seedDefaultZones(quick.id, model);
          await refreshZones();
        }
        await setAppSettings({ seededStarterZones: true });
      } finally {
        seedingRef.current = false;
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providersLoaded, appSettingsLoaded, seededStarterZones, providers, defaultProviderId]);

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
