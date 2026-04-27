import { Button } from "@/components/ui/button";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";

const KEY = "scootflash:disclaimer-accepted-v1";

export function useDisclaimerAccepted() {
  const [accepted, setAccepted] = useState<boolean>(() =>
    typeof localStorage !== "undefined" && localStorage.getItem(KEY) === "1"
  );
  const accept = () => { localStorage.setItem(KEY, "1"); setAccepted(true); };
  return { accepted, accept };
}

export function DisclaimerScreen({ onAccept }: { onAccept: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-10">
      <div className="max-w-md w-full panel-glow p-6 animate-fade-in">
        <div className="flex items-center gap-2 mb-4">
          <ShieldAlert className="w-5 h-5 text-warning" />
          <h2 className="mono text-sm tracking-[0.2em] uppercase text-warning">Read this first</h2>
        </div>

        <h1 className="text-xl font-semibold mb-3">ScootFlash uses raw BLE access to your scooter.</h1>

        <ul className="space-y-2.5 text-sm text-muted-foreground leading-relaxed mb-5">
          <li>• Flashing wrong firmware can <span className="text-destructive">brick your scooter</span> or damage the battery.</li>
          <li>• Modifying firmware may make your scooter <span className="text-destructive">illegal on public roads</span>.</li>
          <li>• Your scooter's warranty will likely be voided.</li>
          <li>• Always flash with battery <span className="text-primary-glow">≥ 50%</span> and the scooter stationary.</li>
          <li>• Never power off the scooter or close the app while flashing.</li>
        </ul>

        <Button onClick={onAccept} className="w-full bg-gradient-mint text-primary-foreground shadow-mint mono tracking-widest">
          I UNDERSTAND, CONTINUE
        </Button>
      </div>
    </div>
  );
}
