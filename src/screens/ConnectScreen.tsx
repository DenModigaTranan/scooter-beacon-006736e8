import { useEffect } from "react";
import { motion } from "framer-motion";
import { Bluetooth, Loader2, RefreshCw, Signal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useScooter } from "@/hooks/use-scooter";
import { StatusBadge } from "@/components/StatusBadge";
import { PairedScooters } from "@/components/PairedScooters";

function rssiBars(rssi: number) {
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

export function ConnectScreen() {
  const { state, devices, scan, connect, isNative, errorMessage, selected, handshake } = useScooter();

  useEffect(() => {
    if (state === "idle" && devices.length === 0) scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <div className="max-w-md w-full mx-auto px-5 pt-10 pb-32 flex-1">
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
          <div className="flex flex-col items-center text-center mb-10">
            <div className="relative mb-5">
              <div className="absolute inset-0 rounded-full bg-primary/20 blur-2xl" />
              <div className="relative w-20 h-20 rounded-full bg-gradient-mint flex items-center justify-center pulse-ring">
                <Bluetooth className="w-9 h-9 text-primary-foreground" />
              </div>
            </div>
            <h1 className="mono text-2xl font-bold tracking-tight text-shadow-glow">SCOOTFLASH</h1>
            <p className="mt-2 text-sm text-muted-foreground max-w-[260px]">
              Bluetooth flasher & live diagnostics for Xiaomi M365 family scooters.
            </p>
            {!isNative && (
              <div className="chip chip-warn mt-4">PREVIEW — mock devices</div>
            )}
          </div>

          <PairedScooters
            busy={state === "connecting" || state === "scanning"}
            connectingId={state === "connecting" ? selected?.deviceId ?? null : null}
            state={state}
            activeDeviceId={selected?.deviceId ?? null}
            handshakeOk={handshake?.ok ?? null ? !!handshake?.ok : undefined}
            errorMessage={errorMessage}
            onReconnect={(deviceId, name) =>
              connect({ deviceId, name, rssi: -127 })
            }
          />

          <div className="flex items-center justify-between mb-3">
            <div className="mono text-[11px] tracking-[0.22em] uppercase text-muted-foreground">Nearby</div>
            <div className="flex items-center gap-2">
              <StatusBadge state={state} />
              <button
                onClick={scan}
                disabled={state === "scanning" || state === "connecting"}
                className="text-muted-foreground hover:text-primary-glow disabled:opacity-50 transition-colors"
                aria-label="Rescan"
              >
                <RefreshCw className={state === "scanning" ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
              </button>
            </div>
          </div>

          <div className="space-y-2.5">
            {devices.length === 0 && state !== "scanning" && (
              <div className="panel p-6 text-center text-sm text-muted-foreground">
                No scooters found. Make sure your scooter is on and within range.
              </div>
            )}

            {state === "scanning" && devices.length === 0 && (
              <div className="panel p-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Scanning…
              </div>
            )}

            {devices.map((d) => {
              const bars = rssiBars(d.rssi);
              return (
                <motion.button
                  key={d.deviceId}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => connect(d)}
                  disabled={state === "connecting"}
                  className="w-full panel hover:panel-glow transition-all p-4 flex items-center justify-between text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center shrink-0">
                      <Bluetooth className="w-5 h-5 text-primary-glow" />
                    </div>
                    <div className="min-w-0">
                      <div className="mono text-sm truncate">{d.name}</div>
                      <div className="mono text-[10px] text-muted-foreground tracking-widest">
                        {d.deviceId.slice(0, 17).toUpperCase()}
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

          {errorMessage && (
            <div className="mt-4 panel p-3 border-destructive/40 text-destructive text-xs mono">
              {errorMessage}
            </div>
          )}

          <div className="mt-8 panel p-4 text-xs text-muted-foreground leading-relaxed">
            <span className="chip mb-2">Tip</span>
            <p className="mt-2">
              Power on your scooter, then tap a device above to pair. Keep it within
              ~5 m for stable BLE — and never flash with battery below 50%.
            </p>
          </div>

          <div className="mt-6 flex justify-center">
            <Button onClick={scan} disabled={state === "scanning"} size="lg" className="bg-gradient-mint text-primary-foreground shadow-mint hover:opacity-90 mono tracking-widest">
              {state === "scanning" ? "SCANNING…" : "SCAN AGAIN"}
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
