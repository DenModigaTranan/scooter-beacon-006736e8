/**
 * Unified auto-detect entry screen.
 *
 * Replaces the old "pick a profile" dropdown. Scans every nearby BLE
 * peripheral (no service-UUID filter), classifies each one with
 * `detectProfile`, and lets the user tap the device they want to use.
 *
 * Tapping a device persists the detected profile via `setProfile()` —
 * after which `<Index>` re-renders and routes to the protocol-specific
 * screen (M365 ConnectScreen, NinebotScreen, or GenericBleScreen) which
 * owns the actual GATT connection flow.
 *
 * The user can re-enter this screen any time via Settings → "Re-detect
 * scooter".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Bluetooth, Loader2, RefreshCw, Signal, Sparkles } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { setProfile, getProfileMeta, type ScooterProfile } from "@/lib/profile";
import { detectProfile, detectChipLabel } from "@/lib/profile-detect";
import { genericBle, type GenericDevice } from "@/lib/generic-ble";

const SCAN_MS = 6000;

function rssiBars(rssi: number) {
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

interface SeenDevice extends GenericDevice {
  detection: ReturnType<typeof detectProfile>;
}

export function ProfileSelectScreen({ onContinue }: { onContinue: () => void }) {
  const [devices, setDevices] = useState<Map<string, SeenDevice>>(new Map());
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runIdRef = useRef(0);

  const runScan = async () => {
    const myRun = ++runIdRef.current;
    setError(null);
    setScanning(true);
    setDevices(new Map());
    try {
      await genericBle.scan((d) => {
        // Ignore late callbacks from a superseded scan.
        if (myRun !== runIdRef.current) return;
        setDevices((prev) => {
          const next = new Map(prev);
          const detection = detectProfile({
            name: d.name,
            serviceUuids: d.serviceUuids,
            manufacturerIds: d.manufacturerIds,
          });
          next.set(d.deviceId, { ...d, detection });
          return next;
        });
      }, SCAN_MS);
    } catch (e) {
      if (myRun === runIdRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (myRun === runIdRef.current) setScanning(false);
    }
  };

  useEffect(() => {
    runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sort: highest detection confidence first, then RSSI.
  const sorted = useMemo(() => {
    const order = { high: 3, medium: 2, low: 1 } as const;
    return Array.from(devices.values()).sort((a, b) => {
      const c = order[b.detection.confidence] - order[a.detection.confidence];
      if (c !== 0) return c;
      return b.rssi - a.rssi;
    });
  }, [devices]);

  const onPick = (d: SeenDevice) => {
    setProfile(d.detection.profile);
    onContinue();
  };

  const onPickProfileManually = (p: ScooterProfile) => {
    setProfile(p);
    onContinue();
  };

  return (
    <div className="min-h-screen flex flex-col">
      <div className="max-w-md w-full mx-auto px-5 pt-10 pb-32 flex-1">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <div className="flex flex-col items-center text-center mb-8">
            <div className="relative mb-5">
              <div className="absolute inset-0 rounded-full bg-primary/20 blur-2xl" />
              <div className="relative w-20 h-20 rounded-full bg-gradient-mint flex items-center justify-center pulse-ring">
                <Bluetooth className="w-9 h-9 text-primary-foreground" />
              </div>
            </div>
            <h1 className="mono text-2xl font-bold tracking-tight text-shadow-glow">SCOOTFLASH</h1>
            <p className="mt-2 text-sm text-muted-foreground max-w-[280px]">
              Scanning for every nearby scooter over Bluetooth. Tap one to start —
              we'll auto-pick the right protocol.
            </p>
          </div>

          <div className="flex items-center justify-between mb-3">
            <div className="mono text-[11px] tracking-[0.22em] uppercase text-muted-foreground">
              Nearby
            </div>
            <button
              onClick={runScan}
              disabled={scanning}
              className="text-muted-foreground hover:text-primary-glow disabled:opacity-50 transition-colors"
              aria-label="Rescan"
            >
              <RefreshCw className={scanning ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
            </button>
          </div>

          <div className="space-y-2.5">
            {sorted.length === 0 && scanning && (
              <div className="panel p-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Scanning all Bluetooth devices…
              </div>
            )}
            {sorted.length === 0 && !scanning && (
              <div className="panel p-6 text-center text-sm text-muted-foreground">
                No devices found. Make sure your scooter is powered on and nearby,
                then rescan.
              </div>
            )}

            {sorted.map((d) => {
              const bars = rssiBars(d.rssi);
              const meta = getProfileMeta(d.detection.profile);
              const conf = d.detection.confidence;
              return (
                <motion.button
                  key={d.deviceId}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => onPick(d)}
                  className="w-full panel hover:panel-glow transition-all p-4 flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center shrink-0">
                      <Bluetooth className="w-5 h-5 text-primary-glow" />
                    </div>
                    <div className="min-w-0">
                      <div className="mono text-sm truncate flex items-center gap-2">
                        <span className="truncate">{d.name}</span>
                        <span
                          className={cn(
                            "chip text-[9px] tracking-[0.18em] shrink-0",
                            conf === "high" ? "text-primary-glow" : "text-muted-foreground",
                          )}
                        >
                          {detectChipLabel(d.detection)}
                        </span>
                      </div>
                      <div className="mono text-[10px] text-muted-foreground tracking-widest">
                        → {meta.label}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Signal className="w-3.5 h-3.5 text-muted-foreground" />
                    <div className="flex items-end gap-0.5 h-4">
                      {[1, 2, 3, 4].map((i) => (
                        <div
                          key={i}
                          className={`w-1 rounded-sm ${i <= bars ? "bg-primary-glow" : "bg-muted"}`}
                          style={{ height: `${i * 25}%` }}
                        />
                      ))}
                    </div>
                  </div>
                </motion.button>
              );
            })}
          </div>

          {error && (
            <div className="mt-4 panel p-3 border-destructive/40 text-destructive text-xs mono">
              {error}
            </div>
          )}

          <div className="mt-6 flex justify-center">
            <Button
              onClick={runScan}
              disabled={scanning}
              size="lg"
              className="bg-gradient-mint text-primary-foreground shadow-mint hover:opacity-90 mono tracking-widest"
            >
              {scanning ? "SCANNING…" : "SCAN AGAIN"}
            </Button>
          </div>

          <div className="mt-8 panel p-4">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-3.5 h-3.5 text-primary-glow" />
              <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
                Skip auto-detect
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-3">
              Don't see your scooter, or want to force a specific protocol?
              Pick one manually:
            </p>
            <div className="grid grid-cols-2 gap-2">
              {(["xiaomi-m365", "ninebot", "ewheels", "ewa", "generic-ble"] as ScooterProfile[]).map(
                (p) => (
                  <button
                    key={p}
                    onClick={() => onPickProfileManually(p)}
                    className="panel p-2 text-left hover:panel-glow transition-all"
                  >
                    <div className="mono text-[11px] truncate">
                      {getProfileMeta(p).shortLabel}
                    </div>
                  </button>
                ),
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
