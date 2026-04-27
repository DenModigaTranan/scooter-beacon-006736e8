import { useState } from "react";
import { useScooter } from "@/hooks/use-scooter";
import { ConnectScreen } from "@/screens/ConnectScreen";
import { DashboardScreen } from "@/screens/DashboardScreen";
import { InfoScreen } from "@/screens/InfoScreen";
import { FlashScreen } from "@/screens/FlashScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { DisclaimerScreen, useDisclaimerAccepted } from "@/screens/DisclaimerScreen";
import { HeaderBar, TabBar, type TabKey } from "@/components/AppShell";
import { StatusBadge } from "@/components/StatusBadge";

const titles: Record<TabKey, string> = {
  dashboard: "Dashboard",
  info: "Scooter Info",
  flash: "Flash Firmware",
  settings: "Settings",
};

const Index = () => {
  const { accepted, accept } = useDisclaimerAccepted();
  const { state } = useScooter();
  const [tab, setTab] = useState<TabKey>("dashboard");

  if (!accepted) return <DisclaimerScreen onAccept={accept} />;
  if (state !== "connected") return <ConnectScreen />;

  return (
    <div className="min-h-screen pb-20">
      <HeaderBar title={titles[tab]} right={<StatusBadge state={state} />} />
      <main className="max-w-md mx-auto">
        {tab === "dashboard" && <DashboardScreen />}
        {tab === "info" && <InfoScreen />}
        {tab === "flash" && <FlashScreen />}
        {tab === "settings" && <SettingsScreen />}
      </main>
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
};

export default Index;
