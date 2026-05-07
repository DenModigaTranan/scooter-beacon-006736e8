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
import NinebotScreen from "@/screens/NinebotScreen";
import { HeaderBar, TabBar, type TabKey } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";
import { ProfileBanner } from "@/components/ProfileBanner";
import { CompatibilityBadge } from "@/components/CompatibilityBadge";
import { getProfileMeta, isNinebotCompatible, useProfile } from "@/lib/profile";

const titles: Record<TabKey, string> = {
  dashboard: "Dashboard",
  info: "Scooter Info",
  catalog: "Firmware Catalog",
  flash: "Flash Firmware",
  settings: "Settings",
};

const Index = () => {
  const { accepted, accept } = useDisclaimerAccepted();
  const { state, selected } = useScooter();
  const [profile] = useProfile();
  const [tab, setTab] = useState<TabKey>("dashboard");
  // Local force-render trigger after picking a profile (the hook also picks it
  // up, but this guarantees the gate releases immediately on the same tick).
  const [, setProfileTick] = useState(0);

  if (!accepted) return <DisclaimerScreen onAccept={accept} />;
  if (!profile) return <ProfileSelectScreen onContinue={() => setProfileTick((t) => t + 1)} />;

  // Generic BLE profile uses its own dedicated scanner UI — it never goes
  // through the M365-specific ConnectScreen / tabbed dashboard since there's
  // no protocol-level info to read.
  if (profile === "generic-ble") {
    const profileLabel = getProfileMeta(profile).shortLabel;
    return (
      <div className="min-h-screen pb-6">
        <HeaderBar title="Generic BLE" profileLabel={profileLabel} />
        <main className="max-w-md mx-auto">
          <GenericBleScreen />
        </main>
      </div>
    );
  }

  // Ninebot, E-wheels and EWA all share the Ninebot BLE stack — route them
  // through the dedicated Ninebot screen which owns its own scan/connect flow.
  if (isNinebotCompatible(profile)) {
    const profileLabel = getProfileMeta(profile).shortLabel;
    return (
      <div className="min-h-screen pb-6">
        <HeaderBar title={`${profileLabel} Scooter`} profileLabel={profileLabel} />
        <main className="max-w-md mx-auto">
          <NinebotScreen />
        </main>
      </div>
    );
  }

  if (state !== "connected") return <ConnectScreen />;

  const profileLabel = getProfileMeta(profile).shortLabel;

  return (
    <div className="min-h-screen pb-20">
      <HeaderBar
        title={titles[tab]}
        profileLabel={profileLabel}
        right={
          <div className="flex items-center gap-1.5">
            <CompatibilityBadge profile={profile} deviceName={selected?.name} serviceUuids={selected?.serviceUuids} gattServiceUuids={selected?.gattServiceUuids} manufacturerIds={selected?.manufacturerIds} />
            <StatusBadge state={state} />
          </div>
        }
      />
      <main className="max-w-md mx-auto">
        <ProfileBanner />
        <div className="px-4 pt-4 max-w-md mx-auto">
          <CompatibilityBadge profile={profile} deviceName={selected?.name} serviceUuids={selected?.serviceUuids} gattServiceUuids={selected?.gattServiceUuids} manufacturerIds={selected?.manufacturerIds} variant="full" />
        </div>
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
