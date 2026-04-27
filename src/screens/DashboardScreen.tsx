import { motion } from "framer-motion";
import { useScooter } from "@/hooks/use-scooter";
import { Readout } from "@/components/Readout";
import { Activity, Battery, Gauge, Thermometer, Zap } from "lucide-react";

export function DashboardScreen() {
  const { telemetry, info } = useScooter();
  const t = telemetry;

  return (
    <div className="px-4 pt-4 pb-28 max-w-md mx-auto space-y-3 animate-fade-in">
      {/* Big speed card */}
      <motion.div layout className="panel-glow scanline p-6 flex flex-col items-center relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-glow pointer-events-none" />
        <div className="mono text-[10px] tracking-[0.3em] text-muted-foreground uppercase">Speed</div>
        <div className="readout text-7xl md:text-8xl mt-1 tabular-nums">
          {t ? t.speedKph.toFixed(1) : "--.-"}
        </div>
        <div className="mono text-xs text-muted-foreground mt-1">km/h</div>

        <div className="mt-5 w-full grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="mono text-[9px] text-muted-foreground tracking-widest">MODE</div>
            <div className="mono text-sm uppercase text-primary-glow">{t?.ridingMode ?? "—"}</div>
          </div>
          <div>
            <div className="mono text-[9px] text-muted-foreground tracking-widest">TRIP</div>
            <div className="mono text-sm text-foreground">{t ? `${t.tripKm.toFixed(2)}` : "—"}</div>
          </div>
          <div>
            <div className="mono text-[9px] text-muted-foreground tracking-widest">TOTAL</div>
            <div className="mono text-sm text-foreground">{t ? `${t.totalKm.toFixed(0)}` : "—"}</div>
          </div>
        </div>
      </motion.div>

      <div className="grid grid-cols-2 gap-3">
        <Readout
          label="Battery"
          value={t ? Math.round(t.batteryPct) : "--"}
          unit="%"
          tone={t && t.batteryPct < 25 ? "danger" : t && t.batteryPct < 50 ? "warn" : "default"}
        />
        <Readout label="Voltage" value={t ? t.voltage.toFixed(2) : "--.--"} unit="V" />
        <Readout label="Current" value={t ? t.currentA.toFixed(1) : "--.-"} unit="A" />
        <Readout
          label="Motor"
          value={t ? t.motorTempC.toFixed(0) : "--"}
          unit="°C"
          tone={t && t.motorTempC > 70 ? "danger" : t && t.motorTempC > 55 ? "warn" : "default"}
        />
      </div>

      {/* Battery bar */}
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 mono text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
            <Battery className="w-3.5 h-3.5" /> Battery health
          </div>
          <div className="mono text-xs text-foreground">
            {t ? `${Math.round(t.batteryPct)}%` : "—"}
          </div>
        </div>
        <div className="h-2.5 rounded-full bg-muted overflow-hidden">
          <motion.div
            className="h-full bg-gradient-mint"
            initial={{ width: 0 }}
            animate={{ width: `${t?.batteryPct ?? 0}%` }}
            transition={{ duration: 0.6 }}
          />
        </div>
      </div>

      <div className="panel p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 mono text-[10px] tracking-[0.2em] uppercase text-muted-foreground">
            <Activity className="w-3.5 h-3.5" /> Live link
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-primary-glow animate-blink" />
            <span className="mono text-[10px] tracking-widest text-primary-glow">STREAMING</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 mt-3 text-center text-xs">
          <div className="flex flex-col items-center gap-1">
            <Gauge className="w-4 h-4 text-muted-foreground" />
            <span className="mono text-muted-foreground">600 ms</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Zap className="w-4 h-4 text-muted-foreground" />
            <span className="mono text-muted-foreground">FE95</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Thermometer className="w-4 h-4 text-muted-foreground" />
            <span className="mono text-muted-foreground">{info?.drvVersion ?? "—"}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
