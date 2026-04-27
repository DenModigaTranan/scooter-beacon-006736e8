/**
 * NinebotScreen — Ninebot-specific landing route.
 *
 * Composes <GenericBleScreen /> for the scan/connect/retry surface so every
 * orchestration improvement on the generic flow flows through here, then
 * layers a Ninebot-only telemetry section on top. Telemetry is driven by
 * `useNinebotLiveTelemetry`, which watches the shared `genericBle` singleton
 * for an active connection to a peripheral exposing the Ninebot custom GATT
 * service. When one appears, it spins up a `NinebotSession` to run the
 * 3-phase auth handshake and the register-poll loop; when the connection
 * drops, it tears the session back down. The hook is the *only* place that
 * mutates session lifecycle, so the rest of this file can stay declarative.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Battery, Gauge, Lock, Route as RouteIcon, Zap, Info, Loader2, ShieldCheck, AlertTriangle } from "lucide-react";
import { GenericBleScreen } from "@/screens/GenericBleScreen";
import { NinebotSupportedModels } from "@/components/NinebotSupportedModels";
import { genericBle } from "@/lib/generic-ble";
import { NB_GATT, formatTelemetryField, type NinebotTelemetry } from "@/lib/ninebot/protocol";
import { NinebotSession, type NinebotSessionStatus } from "@/lib/ninebot/session";
import { cn } from "@/lib/utils";

interface TelemetryTile {
  icon: typeof Battery;
  label: string;
  field: keyof NinebotTelemetry;
  unit?: string;
  hint: string;
}

const TILES: readonly TelemetryTile[] = [
  { icon: Battery,   label: "Battery",  field: "batteryPct", unit: "%",    hint: "state of charge" },
  { icon: Gauge,     label: "Speed",    field: "speedKmh",   unit: "km/h", hint: "live wheel speed" },
  { icon: Zap,       label: "Mode",     field: "mode",                     hint: "drive / eco / sport" },
  { icon: RouteIcon, label: "Odometer", field: "odometerKm", unit: "km",   hint: "lifetime distance" },
  { icon: Lock,      label: "Lock",     field: "locked",                   hint: "secured / unlocked" },
];

/**
 * How often we poll `genericBle.getConnectedId()` and the discovered
 * service list to learn whether a Ninebot is currently connected. We
 * deliberately don't subscribe to a connection event because the
 * connection lifecycle is owned by `GenericBleScreen` — keeping this
 * pull-based decouples the two screens entirely.
 */
const CONNECTION_POLL_MS = 600;

/**
 * Watches the shared BLE singleton and runs a Ninebot session against any
 * connected peripheral whose GATT layout includes the Ninebot service.
 * Returns the latest decoded telemetry plus a status string suitable for
 * the "auth handshake" / "live" badge above the tiles.
 */
function useNinebotLiveTelemetry(): {
  telemetry: NinebotTelemetry;
  status: NinebotSessionStatus;
  detail: string | null;
  /** True when we believe a Ninebot is on the other end of the link. */
  hasNinebot: boolean;
} {
  const [telemetry, setTelemetry] = useState<NinebotTelemetry>({});
  const [status, setStatus] = useState<NinebotSessionStatus>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const [hasNinebot, setHasNinebot] = useState(false);
  // Tracks the deviceId we've already started a session for, so the poll
  // loop doesn't churn through start()/stop() on every tick.
  const activeIdRef = useRef<string | null>(null);
  const sessionRef = useRef<NinebotSession | null>(null);

  useEffect(() => {
    let cancelled = false;

    /**
     * Inspect the current GATT layout once. We can only ask about
     * services *after* discovery has completed; while a connection is
     * still spinning up, `discoverServices()` returns [] and we'll
     * naturally retry on the next tick.
     */
    const checkAndSync = async () => {
      const connectedId = genericBle.getConnectedId();
      if (!connectedId) {
        if (activeIdRef.current) await teardown();
        if (!cancelled) {
          setHasNinebot(false);
          setStatus("idle");
          setDetail(null);
          setTelemetry({});
        }
        return;
      }
      // Don't re-discover if we're already tracking this device.
      if (activeIdRef.current === connectedId) return;
      let services: { uuid: string }[] = [];
      try { services = await genericBle.discoverServices(); } catch { services = []; }
      const hasService = services.some(
        (s) => s.uuid.toLowerCase() === NB_GATT.SERVICE.toLowerCase(),
      );
      if (cancelled) return;
      setHasNinebot(hasService);
      if (!hasService) return;
      // New Ninebot session — tear down any prior one (defensive — the
      // teardown above should've already fired) and spin a fresh one.
      await teardown();
      activeIdRef.current = connectedId;
      const session = new NinebotSession({
        onStatus: (s, d) => {
          if (cancelled) return;
          setStatus(s);
          setDetail(d ?? null);
        },
        onTelemetry: (t) => {
          if (cancelled) return;
          // Snapshot — the session reuses its internal object across
          // pushes, so spreading here protects us from later mutation.
          setTelemetry({ ...t });
        },
      });
      sessionRef.current = session;
      try { await session.start(); } catch { /* status already updated */ }
    };

    const teardown = async () => {
      const s = sessionRef.current;
      sessionRef.current = null;
      activeIdRef.current = null;
      if (s) { try { await s.stop(); } catch { /* swallow */ } }
    };

    // Run immediately on mount, then on a slow poll. CONNECTION_POLL_MS
    // is intentionally generous — once a session is up the poll loop
    // returns early on every tick, so the cost is negligible.
    void checkAndSync();
    const id = setInterval(() => { void checkAndSync(); }, CONNECTION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      void teardown();
    };
  }, []);

  return { telemetry, status, detail, hasNinebot };
}

/**
 * Status pill copy + icon for the badge above the telemetry grid. Mapping
 * lives next to the JSX that uses it so adding a new status state is a
 * single-spot edit.
 */
function statusBadge(status: NinebotSessionStatus, hasNinebot: boolean):
  { label: string; icon: typeof Loader2; cls: string; spin?: boolean } {
  if (!hasNinebot) {
    return { label: "No Ninebot connected", icon: Info, cls: "text-muted-foreground" };
  }
  switch (status) {
    case "subscribing":
      return { label: "Opening notify pipe", icon: Loader2, cls: "text-muted-foreground", spin: true };
    case "authenticating":
      return { label: "Auth handshake", icon: Loader2, cls: "text-warning", spin: true };
    case "polling":
      return { label: "Live", icon: ShieldCheck, cls: "text-primary-glow" };
    case "error":
      return { label: "Auth failed", icon: AlertTriangle, cls: "text-destructive" };
    case "stopped":
      return { label: "Disconnected", icon: Info, cls: "text-muted-foreground" };
    default:
      return { label: "Pending decode", icon: Info, cls: "text-muted-foreground" };
  }
}

export default function NinebotScreen() {
  const { telemetry, status, detail, hasNinebot } = useNinebotLiveTelemetry();
  const badge = useMemo(() => statusBadge(status, hasNinebot), [status, hasNinebot]);

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

        {/* Telemetry tiles — driven by the live session hook. */}
        <section
          aria-label="Ninebot telemetry"
          className="panel p-3 space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
              Telemetry
            </div>
            <div
              className={cn(
                "inline-flex items-center gap-1 mono text-[9px] tracking-widest uppercase",
                badge.cls,
              )}
              title={detail ?? undefined}
            >
              <badge.icon className={cn("w-3 h-3", badge.spin && "animate-spin")} aria-hidden />
              {badge.label}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {TILES.map((t) => {
              const Icon = t.icon;
              const value = formatTelemetryField(telemetry, t.field);
              const isLive = status === "polling" && value !== "—";
              return (
                <div
                  key={t.label}
                  className={cn(
                    "rounded-md border border-border bg-secondary/40 px-2.5 py-2",
                    "flex items-start gap-2 transition-colors",
                    isLive && "border-primary-glow/40 bg-primary-glow/5",
                  )}
                  title={t.hint}
                >
                  <Icon className="w-4 h-4 text-primary-glow mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="mono text-[9px] tracking-widest uppercase text-muted-foreground truncate">
                      {t.label}
                    </div>
                    <div className="mono text-sm">
                      {value}
                      {t.unit && value !== "—" && (
                        <span className="text-[10px] text-muted-foreground ml-1">{t.unit}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Surface auth-failure detail inline so the user doesn't have to
              dig through the connection log to learn why tiles are blank. */}
          {status === "error" && detail && (
            <div className="mono text-[10px] text-destructive/80 pt-1 border-t border-destructive/20">
              {detail}
            </div>
          )}
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
