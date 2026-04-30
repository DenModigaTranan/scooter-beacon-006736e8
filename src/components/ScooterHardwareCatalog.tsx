/**
 * ScooterHardwareCatalog — read-only reference panel for BMS packs and
 * motherboards (controllers / ESCs) across the M365 / Xiaomi / Ninebot /
 * Segway lineup.
 *
 * Sibling of `NinebotSupportedModels`: where that panel describes whole
 * vehicles, this one describes the two subsystems Scooter Beacon talks to
 * (the battery's BMS MCU and the main DRV mainboard). Pure rendering of
 * `src/lib/scooter-hardware.ts` — no I/O.
 */

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown, Search, X, Battery, Cpu, Tag, Bolt, Zap, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BMS_MODULES,
  MOTHERBOARDS,
  type BmsModule,
  type Motherboard,
  type ScooterHardwareFamily,
  type DataConfidence,
} from "@/lib/scooter-hardware";

const FAMILY_LABEL: Record<ScooterHardwareFamily, { label: string; order: number }> = {
  "xiaomi-m365":  { label: "Xiaomi M365 / 1S / Pro / Mi 3", order: 1 },
  "xiaomi-mi":    { label: "Xiaomi Mi 4 family",            order: 2 },
  "ninebot-es":   { label: "Ninebot ES",                    order: 3 },
  "ninebot-max":  { label: "Ninebot Max / G30 / G2",        order: 4 },
  "ninebot-f":    { label: "Ninebot F / F2 / F65",          order: 5 },
  "ninebot-e":    { label: "Ninebot E22 / E25 / E45",       order: 6 },
  "ninebot-g":    { label: "Ninebot GT super-scooters",     order: 7 },
  "ninebot-d":    { label: "Ninebot D-series",              order: 8 },
  // Other brands — alphabetical-ish, after the Xiaomi/Ninebot block.
  "apollo":         { label: "Apollo",                       order: 20 },
  "atomi":          { label: "Atomi",                        order: 21 },
  "augment":        { label: "NIU KQi",                      order: 22 },
  "bird":           { label: "Bird",                         order: 23 },
  "cityblitz":      { label: "CityBlitz",                    order: 24 },
  "currus":         { label: "Currus",                       order: 25 },
  "dualtron":       { label: "Dualtron / Minimotors",        order: 26 },
  "egret":          { label: "Egret",                        order: 27 },
  "emove":          { label: "EMOVE (Voro Motors)",          order: 28 },
  "evolv":          { label: "EVOLV",                        order: 29 },
  "fluidfreeride":  { label: "Fluid Freeride",               order: 30 },
  "gotrax":         { label: "Gotrax",                       order: 31 },
  "hiboy":          { label: "Hiboy",                        order: 32 },
  "inokim":         { label: "Inokim",                       order: 33 },
  "iscooter":       { label: "iScooter",                     order: 34 },
  "joyor":          { label: "Joyor",                        order: 35 },
  "kaabo":          { label: "Kaabo",                        order: 36 },
  "levy":           { label: "Levy",                         order: 37 },
  "lime":           { label: "Lime (fleet, reference)",      order: 38 },
  "nanrobot":       { label: "Nanrobot",                     order: 39 },
  "okai":           { label: "OKAI",                         order: 40 },
  "pure":           { label: "Pure Electric",                order: 41 },
  "razor":          { label: "Razor / EcoSmart",             order: 42 },
  "smacircle":      { label: "Smacircle / foldables",        order: 43 },
  "speedway":       { label: "Speedway (Minimotors)",        order: 44 },
  "turboant":       { label: "Turboant",                     order: 45 },
  "unagi":          { label: "Unagi",                        order: 46 },
  "varla":          { label: "Varla",                        order: 47 },
  "vsett":          { label: "VSETT",                        order: 48 },
  "wegoboard":      { label: "Wegoboard",                    order: 49 },
  "yadea":          { label: "Yadea",                        order: 50 },
  "yume":           { label: "Yume",                         order: 51 },
  "zero":           { label: "Zero (Ecorider)",              order: 52 },
  "clone":          { label: "Generic / clones",             order: 99 },
};

const CONFIDENCE_TONE: Record<DataConfidence, string> = {
  documented: "text-primary border-primary/30 bg-primary/5",
  community:  "text-warning border-warning/30 bg-warning/5",
  inferred:   "text-muted-foreground border-border bg-secondary/40",
};

type Tab = "bms" | "mb";

export function ScooterHardwareCatalog() {
  const [tab, setTab] = useState<Tab>("bms");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // Group + filter the active tab's catalog by hardware family.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source = tab === "bms" ? BMS_MODULES : MOTHERBOARDS;

    const matches = (item: BmsModule | Motherboard) => {
      if (!q) return true;
      const haystacks: string[] = [
        item.id, item.displayName.toLowerCase(), item.shortLabel.toLowerCase(),
        item.family, ...(item.compatibleScooterIds ?? []),
      ];
      if ("cellConfig" in item) haystacks.push(item.cellConfig, item.chemistry);
      if ("cellVendor" in item && item.cellVendor) haystacks.push(item.cellVendor.toLowerCase());
      if ("drvMcu" in item) haystacks.push(item.drvMcu, item.bleMcu);
      if (item.notes) haystacks.push(item.notes.toLowerCase());
      return haystacks.some((h) => h.includes(q));
    };

    const byFamily = new Map<ScooterHardwareFamily, (BmsModule | Motherboard)[]>();
    for (const item of source) {
      if (!matches(item)) continue;
      const arr = byFamily.get(item.family) ?? [];
      arr.push(item);
      byFamily.set(item.family, arr);
    }
    return Array.from(byFamily.entries()).sort(
      (a, b) => (FAMILY_LABEL[a[0]]?.order ?? 99) - (FAMILY_LABEL[b[0]]?.order ?? 99),
    );
  }, [tab, query]);

  const total = tab === "bms" ? BMS_MODULES.length : MOTHERBOARDS.length;
  const shown = groups.reduce((n, [, xs]) => n + xs.length, 0);

  return (
    <section
      aria-label="Scooter BMS and motherboard reference"
      className="panel p-3 space-y-3"
    >
      <header className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
            Hardware reference · BMS &amp; motherboards
          </div>
          <div className="mono text-[10px] text-muted-foreground/80 mt-0.5">
            {shown} of {total} {tab === "bms" ? "BMS packs" : "mainboards"} shown · public community data
          </div>
        </div>
        <div role="tablist" className="inline-flex rounded-md border border-border overflow-hidden">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bms"}
            onClick={() => setTab("bms")}
            className={cn(
              "mono text-[10px] tracking-widest uppercase px-2.5 py-1 inline-flex items-center gap-1",
              tab === "bms" ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Battery className="w-3 h-3" aria-hidden /> BMS
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "mb"}
            onClick={() => setTab("mb")}
            className={cn(
              "mono text-[10px] tracking-widest uppercase px-2.5 py-1 inline-flex items-center gap-1 border-l border-border",
              tab === "mb" ? "bg-foreground/10 text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Cpu className="w-3 h-3" aria-hidden /> Mainboard
          </button>
        </div>
      </header>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={tab === "bms"
            ? "Filter by pack, scooter id, chemistry, or vendor (e.g. 'LG MH1', 'g30')…"
            : "Filter by board, scooter id, MCU (e.g. 'stm32g4', 'mi3')…"}
          className={cn(
            "mono text-xs w-full h-9 rounded-md border border-input bg-background pl-8 pr-8",
            "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ring-offset-background",
          )}
          aria-label="Filter hardware catalog"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear filter"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {shown === 0 && (
        <div className="text-center text-xs text-muted-foreground py-6">
          No entries match "{query}".
        </div>
      )}

      {groups.map(([family, items]) => (
        <div key={family} className="space-y-1.5">
          <div className="mono text-[9px] tracking-[0.22em] uppercase text-muted-foreground/70 px-0.5">
            {FAMILY_LABEL[family]?.label ?? family}
          </div>
          {items.map((item) =>
            tab === "bms" ? (
              <BmsCard
                key={item.id}
                module={item as BmsModule}
                open={expanded.has(item.id)}
                onToggle={() => toggle(item.id)}
              />
            ) : (
              <MotherboardCard
                key={item.id}
                board={item as Motherboard}
                open={expanded.has(item.id)}
                onToggle={() => toggle(item.id)}
              />
            ),
          )}
        </div>
      ))}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* BMS card                                                                   */
/* -------------------------------------------------------------------------- */

function BmsCard({ module: m, open, onToggle }: { module: BmsModule; open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-foreground/[0.03] transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono text-sm truncate">{m.displayName}</span>
            <span className="chip text-[8px] tracking-widest text-muted-foreground border border-border">
              {m.shortLabel.toUpperCase()}
            </span>
            <span className={cn("chip text-[8px] tracking-widest uppercase border", CONFIDENCE_TONE[m.confidence])}>
              {m.confidence}
            </span>
          </div>
          <div className="mono text-[10px] text-muted-foreground tracking-widest mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{m.id}</span>
            <span aria-hidden>·</span>
            <span>{m.cellConfig}</span>
            <span aria-hidden>·</span>
            <span>{m.nominalVoltageV} V</span>
            <span aria-hidden>·</span>
            <span>{m.capacityAh > 0 ? `${m.capacityAh} Ah` : "?"}</span>
            <span aria-hidden>·</span>
            <span>{m.energyWh > 0 ? `${m.energyWh} Wh` : "?"}</span>
          </div>
        </div>
        <ChevronDown className={cn("w-4 h-4 text-muted-foreground shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="border-t border-border"
          >
            <div className="px-3 py-2.5 space-y-2 mono text-[11px]">
              <Row icon={<Bolt className="w-3 h-3" />} label="Chemistry" value={m.chemistry} />
              {m.cellVendor && <Row icon={<Tag className="w-3 h-3" />} label="Cell vendor" value={m.cellVendor} />}
              {m.boardId != null && (
                <Row icon={<Cpu className="w-3 h-3" />} label="Board ID" value={`0x${m.boardId.toString(16).padStart(4, "0")}`} />
              )}
              {m.serialPrefixes?.length ? (
                <Row
                  icon={<Tag className="w-3 h-3" />}
                  label="Serial prefixes"
                  value={m.serialPrefixes.map((p) => `${p}*`).join(" · ")}
                />
              ) : null}
              <Row
                icon={<Wrench className="w-3 h-3" />}
                label="Ships in"
                value={m.compatibleScooterIds.join(", ") || "—"}
              />
              {m.notes && (
                <div className="text-[10px] text-muted-foreground leading-relaxed border-t border-border pt-2">
                  <span className="text-[9px] tracking-widest uppercase text-muted-foreground/80 mr-1">Note</span>
                  {m.notes}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Motherboard card                                                           */
/* -------------------------------------------------------------------------- */

function MotherboardCard({ board: b, open, onToggle }: { board: Motherboard; open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-md border border-border bg-secondary/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-foreground/[0.03] transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono text-sm truncate">{b.displayName}</span>
            <span className="chip text-[8px] tracking-widest text-muted-foreground border border-border">
              {b.shortLabel.toUpperCase()}
            </span>
            <span className={cn("chip text-[8px] tracking-widest uppercase border", CONFIDENCE_TONE[b.confidence])}>
              {b.confidence}
            </span>
          </div>
          <div className="mono text-[10px] text-muted-foreground tracking-widest mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{b.id}</span>
            <span aria-hidden>·</span>
            <span>DRV {b.drvMcu}</span>
            <span aria-hidden>·</span>
            <span>BLE {b.bleMcu}</span>
            {b.motorPowerW != null && (<><span aria-hidden>·</span><span>{b.motorPowerW} W</span></>)}
          </div>
        </div>
        <ChevronDown className={cn("w-4 h-4 text-muted-foreground shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="border-t border-border"
          >
            <div className="px-3 py-2.5 space-y-2 mono text-[11px]">
              <Row icon={<Cpu className="w-3 h-3" />} label="DRV MCU" value={b.drvMcu} />
              <Row icon={<Cpu className="w-3 h-3" />} label="BLE MCU" value={b.bleMcu} />
              {b.boardId != null && (
                <Row icon={<Tag className="w-3 h-3" />} label="Board ID" value={`0x${b.boardId.toString(16).padStart(4, "0")}`} />
              )}
              {b.hardwareRevision && (
                <Row icon={<Wrench className="w-3 h-3" />} label="Hardware rev" value={b.hardwareRevision} />
              )}
              {b.motorPowerW != null && (
                <Row icon={<Zap className="w-3 h-3" />} label="Motor power" value={`${b.motorPowerW} W`} />
              )}
              {b.phaseCurrentA != null && (
                <Row icon={<Bolt className="w-3 h-3" />} label="Phase current" value={`${b.phaseCurrentA} A`} />
              )}
              <Row
                icon={<Wrench className="w-3 h-3" />}
                label="Ships in"
                value={b.compatibleScooterIds.join(", ") || "—"}
              />
              {b.notes && (
                <div className="text-[10px] text-muted-foreground leading-relaxed border-t border-border pt-2">
                  <span className="text-[9px] tracking-widest uppercase text-muted-foreground/80 mr-1">Note</span>
                  {b.notes}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <span className="text-[9px] tracking-widest uppercase text-muted-foreground/80 w-24 shrink-0 pt-0.5">
        {label}
      </span>
      <span className="text-foreground/90 break-all">{value}</span>
    </div>
  );
}
