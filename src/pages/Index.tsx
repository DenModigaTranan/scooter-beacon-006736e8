import { useState } from "react";
import { useScooter } from "@/hooks/use-scooter";
import { ConnectScreen } from "@/screens/ConnectScreen";
import { DashboardScreen } from "@/screens/DashboardScreen";
import { InfoScreen } from "@/screens/InfoScreen";
import { FlashScreen } from "@/screens/FlashScreen";
import { CatalogScreen } from "@/screens/CatalogScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { DisclaimerScreen, useDisclaimerAccepted } from "@/screens/DisclaimerScreen";
import { ProfileSelectScreen } from "@/screens/ProfileSelectScreen";
import { GenericBleScreen } from "@/screens/GenericBleScreen";
import { HeaderBar, TabBar, type TabKey } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { ProfileBanner } from "@/components/ProfileBanner";
import { getProfileMeta, useProfile } from "@/lib/profile";

const titles: Record<TabKey, string> = {
  dashboard: "Dashboard",
  info: "Scooter Info",
  catalog: "Firmware Catalog",
  flash: "Flash Firmware",
  settings: "Settings",
};

const Index = () => {
  const { accepted, accept } = useDisclaimerAccepted();
  const { state } = useScooter();
  const [profile] = useProfile();
  const [tab, setTab] = useState<TabKey>("dashboard");
  // Local force-render trigger after picking a profile (the hook also picks it
  // up, but this guarantees the gate releases immediately on the same tick).
  const [, setProfileTick] = useState(0);

  if (!accepted) return <DisclaimerScreen onAccept={accept} />;
  if (!profile) return <ProfileSelectScreen onContinue={() => setProfileTick((t) => t + 1)} />;
  if (state !== "connected") return <ConnectScreen />;

  const profileLabel = getProfileMeta(profile).shortLabel;

  return (
    <div className="min-h-screen pb-20">
      <HeaderBar
        title={titles[tab]}
        profileLabel={profileLabel}
        right={<StatusBadge state={state} />}
      />
      <main className="max-w-md mx-auto">
        <ProfileBanner />
        {tab === "dashboard" && <DashboardScreen />}
        {tab === "info" && <InfoScreen />}
        {tab === "catalog" && <CatalogScreen onPickToFlash={() => setTab("flash")} />}
        {tab === "flash" && <FlashScreen />}
        {tab === "settings" && <SettingsScreen />}
      </main>
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
};

export default Index;
