import { useEffect } from "react";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { ChatPanel } from "./components/Chat/ChatPanel";
import { BackgroundEffect } from "./components/BackgroundEffect";
import { TitleBar } from "./components/TitleBar";
import { Onboarding } from "./components/Onboarding/Onboarding";
import { useApp } from "./store/app";
import { seedDefaultZones } from "./lib/defaultZones";

export default function App() {
  const providersLoaded = useApp((s) => s.providersLoaded);
  const providers = useApp((s) => s.providers);
  const defaultProviderId = useApp((s) => s.appSettings.defaultProviderId);
  const setAppSettings = useApp((s) => s.setAppSettings);
  const appSettingsLoaded = useApp((s) => s.appSettingsLoaded);
  const seededStarterZones = useApp((s) => s.appSettings.seededStarterZones);
  const zones = useApp((s) => s.zones);
  const refreshZones = useApp((s) => s.refreshZones);

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
  useEffect(() => {
    if (!providersLoaded || !appSettingsLoaded || seededStarterZones) return;
    const quick = providers.find((p) => p.id === (defaultProviderId ?? providers[0]?.id)) ?? null;
    const model = quick?.defaultModel?.trim();
    if (!quick || !model) return; // wait until a usable quick model exists
    (async () => {
      if (zones.length === 0) {
        await seedDefaultZones(quick.id, model);
        await refreshZones();
      }
      await setAppSettings({ seededStarterZones: true });
    })();
  }, [providersLoaded, appSettingsLoaded, seededStarterZones, providers, defaultProviderId, zones, refreshZones, setAppSettings]);

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
