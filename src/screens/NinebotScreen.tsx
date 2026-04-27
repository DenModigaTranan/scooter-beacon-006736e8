/**
 * NinebotScreen — Ninebot-specific landing route.
 *
 * Scope of this screen:
 *   • Reuse the existing Generic BLE scan/connect/retry orchestration as-is
 *     by composing <GenericBleScreen /> directly. We deliberately do NOT
 *     fork or re-implement that flow — every retry, backoff, log, and
 *     failure-classification improvement made on the generic screen
 *     applies here automatically.
 *   • Surface Ninebot-specific context above the scanner: a brief
 *     explainer of how detection works, plus a row of telemetry tiles
 *     that *will* light up once a Ninebot is connected and the
 *     authentication + decode pipeline lands.
 *
 * Telemetry status today:
 *   The Segway-Ninebot BLE protocol gates almost every register read
 *   (battery %, speed, mode, odometer, lock state) behind a 3-phase
 *   authentication handshake (PRE_COMM → SET_PWD → AUTH) and AES-128
 *   framing. That work is intentionally out of scope for this route.
 *   The tiles render as "—" placeholders with a "pending decode" hint
 *   so the layout is locked in and ready for the protocol layer to drop
 *   real values in without any UI churn.
 */

import { useMemo } from "react";
import { Battery, Gauge, Lock, Route as RouteIcon, Zap, Info } from "lucide-react";
import { GenericBleScreen } from "@/screens/GenericBleScreen";
import { NinebotSupportedModels } from "@/components/NinebotSupportedModels";
import { cn } from "@/lib/utils";

interface TelemetryTile {
  icon: typeof Battery;
  label: string;
  value: string;
  unit?: string;
  hint: string;
}

/**
 * Static placeholder set. Once the Ninebot decoder lands, this becomes a
 * derived value driven by notify-characteristic state. Kept in a hook-shaped
 * function so the wiring point is obvious to the next reader.
 */
function useNinebotTelemetry(): TelemetryTile[] {
  return useMemo(
    () => [
      { icon: Battery,   label: "Battery",   value: "—",   unit: "%",   hint: "awaiting auth handshake" },
      { icon: Gauge,     label: "Speed",     value: "—",   unit: "km/h", hint: "awaiting auth handshake" },
      { icon: Zap,       label: "Mode",      value: "—",                hint: "drive / eco / sport" },
      { icon: RouteIcon, label: "Odometer",  value: "—",   unit: "km",  hint: "lifetime distance" },
      { icon: Lock,      label: "Lock",      value: "—",                hint: "secured / unlocked" },
    ],
    [],
  );
}

export default function NinebotScreen() {
  const tiles = useNinebotTelemetry();
  return (
    <div className="min-h-screen pb-6">
      <main className="max-w-md mx-auto px-4 pt-4 space-y-4">
        {/* Header — keeps the route self-identifying without depending on
            the parent shell, since this route is reachable as a deep link
            (/ninebot) outside the profile-aware Index shell. */}
        <header className="space-y-1">
          <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
            Profile
          </div>
          <h1 className="mono text-xl tracking-wider">Ninebot</h1>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Scan, connect, and retry use the same flow as Generic BLE. Devices
            advertising the Ninebot signature are tagged in the list below.
          </p>
        </header>

        {/* Telemetry tiles — placeholder layout. See file header for why
            these are stubbed today. */}
        <section
          aria-label="Ninebot telemetry"
          className="panel p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
              Telemetry
            </div>
            <div
              className="inline-flex items-center gap-1 mono text-[9px] tracking-widest uppercase text-muted-foreground"
              title="Live values appear once the Ninebot auth handshake and decoder are wired in."
            >
              <Info className="w-3 h-3" aria-hidden />
              Pending decode
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {tiles.map((t) => {
              const Icon = t.icon;
              return (
                <div
                  key={t.label}
                  className={cn(
                    "rounded-md border border-border bg-secondary/40 px-2.5 py-2",
                    "flex items-start gap-2",
                  )}
                  title={t.hint}
                >
                  <Icon className="w-4 h-4 text-primary-glow mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="mono text-[9px] tracking-widest uppercase text-muted-foreground truncate">
                      {t.label}
                    </div>
                    <div className="mono text-sm">
                      {t.value}
                      {t.unit && <span className="text-[10px] text-muted-foreground ml-1">{t.unit}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* The actual scan/connect/retry surface — composed verbatim so
            every improvement to the generic flow flows through here. */}
        <GenericBleScreen />

        {/* Reference panel: every model the registry recognises and what
            each one can do once connected. Read-only; the registry is
            the single source of truth. */}
        <NinebotSupportedModels />
      </main>
    </div>
  );
}
