import { Bluetooth, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearProfile, getProfileMeta, useProfile } from "@/lib/profile";
import { toast } from "sonner";

/**
 * Single "active scooter" panel. The profile is now picked automatically
 * by the unified auto-detect scan screen, so this no longer offers the
 * old multi-protocol dropdown — instead it just shows what was detected
 * and lets the user kick off a fresh scan.
 */
export function ProfilePicker() {
  const [profile] = useProfile();
  const meta = profile ? getProfileMeta(profile) : null;

  const onReset = () => {
    clearProfile();
    toast("Re-scanning Bluetooth…");
  };

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-3">
        <Bluetooth className="w-4 h-4 text-primary-glow" />
        <div className="mono text-[11px] tracking-[0.2em] uppercase">Active scooter</div>
      </div>

      <div className="mono text-sm text-foreground">
        {meta?.label ?? "—"}
      </div>
      <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
        {meta?.description ?? "No scooter detected yet."}
      </p>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onReset}
        className="mono tracking-widest mt-3 w-full"
      >
        <RefreshCw className="w-3.5 h-3.5 mr-2" /> RE-DETECT SCOOTER
      </Button>
    </div>
  );
}
