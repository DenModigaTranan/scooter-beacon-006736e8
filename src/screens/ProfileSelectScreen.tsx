import { useState } from "react";
import { Bluetooth, Check, Sparkles, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PROFILES, setProfile, type ScooterProfile } from "@/lib/profile";

export function ProfileSelectScreen({ onContinue }: { onContinue: () => void }) {
  const [picked, setPicked] = useState<ScooterProfile>("xiaomi-m365");

  const onSubmit = () => {
    setProfile(picked);
    onContinue();
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-5 py-10">
      <div className="max-w-md w-full panel-glow p-6 animate-fade-in">
        <div className="flex items-center gap-2 mb-4">
          <Bluetooth className="w-5 h-5 text-primary-glow" />
          <h2 className="mono text-sm tracking-[0.2em] uppercase text-primary-glow">Choose your scooter</h2>
        </div>

        <h1 className="text-xl font-semibold mb-2">Pick a profile to start.</h1>
        <p className="text-sm text-muted-foreground mb-5 leading-relaxed">
          This selects which BLE protocol ScootFlash will use. You can change it any time from Settings.
        </p>

        <div className="space-y-2.5 mb-5">
          {PROFILES.map((p) => {
            const isPicked = p.key === picked;
            const isSoon = p.status === "coming-soon";
            return (
              <button
                key={p.key}
                onClick={() => setPicked(p.key)}
                className={cn(
                  "w-full text-left rounded-md border p-3.5 transition-all relative overflow-hidden",
                  isPicked
                    ? "border-primary-glow/70 bg-primary/10 shadow-glow"
                    : "border-border/50 bg-card/40 hover:border-border"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="mono text-sm tracking-wide text-foreground">{p.label}</span>
                      {p.status === "supported" && (
                        <span className="chip text-[9px] tracking-[0.18em] inline-flex items-center gap-1 text-primary-glow">
                          <Sparkles className="w-2.5 h-2.5" /> RECOMMENDED
                        </span>
                      )}
                      {isSoon && (
                        <span className="chip text-[9px] tracking-[0.18em] inline-flex items-center gap-1 text-warning">
                          <Clock className="w-2.5 h-2.5" /> COMING SOON
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{p.description}</p>
                  </div>
                  <div
                    className={cn(
                      "shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors",
                      isPicked ? "border-primary-glow bg-primary-glow/20" : "border-border"
                    )}
                  >
                    {isPicked && <Check className="w-3 h-3 text-primary-glow" />}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <Button
          onClick={onSubmit}
          className="w-full bg-gradient-mint text-primary-foreground shadow-mint mono tracking-widest"
        >
          CONTINUE
        </Button>
      </div>
    </div>
  );
}
