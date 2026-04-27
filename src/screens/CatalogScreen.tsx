import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDownAZ,
  ArrowUpAZ,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Database,
  Filter,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchCatalog, getCatalogUrl, type FirmwareEntry } from "@/lib/m365/catalog";
import { useScooterStore } from "@/store/scooter-store";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Target = "DRV" | "BMS" | "BLE" | "ALL";
type Channel = "stable" | "experimental" | "ALL";
type SortKey = "newest" | "oldest" | "version";

const TARGET_OPTIONS: Target[] = ["ALL", "DRV", "BMS", "BLE"];
const CHANNEL_OPTIONS: Channel[] = ["ALL", "stable", "experimental"];
const TARGET_HINT: Record<Exclude<Target, "ALL">, string> = {
  DRV: "motor controller",
  BMS: "battery",
  BLE: "bluetooth",
};

interface CatalogScreenProps {
  /** Called when the user picks a firmware to flash — parent should switch to Flash tab. */
  onPickToFlash?: (fw: FirmwareEntry) => void;
}

export function CatalogScreen({ onPickToFlash }: CatalogScreenProps) {
  const setPendingFlash = useScooterStore((s) => s.setPendingFlash);
  const queuedId = useScooterStore((s) => s.pendingFlash?.id);

  const [target, setTarget] = useState<Target>("ALL");
  const [channel, setChannel] = useState<Channel>("ALL");
  const [model, setModel] = useState<string>("ALL");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [expanded, setExpanded] = useState<string | null>(null);

  const catalogQ = useQuery({
    queryKey: ["fw-catalog"],
    queryFn: ({ signal }) => fetchCatalog(signal),
  });

  const allFirmwares = catalogQ.data?.firmwares ?? [];

  // Build the model list from whatever is in the catalog so it stays in sync.
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    allFirmwares.forEach((fw) => fw.models.forEach((m) => set.add(m)));
    return ["ALL", ...Array.from(set).sort()];
  }, [allFirmwares]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = allFirmwares.filter((fw) => {
      if (target !== "ALL" && fw.target !== target) return false;
      if (channel !== "ALL" && fw.channel !== channel) return false;
      if (model !== "ALL" && !fw.models.includes(model)) return false;
      if (q) {
        const hay = `${fw.version} ${fw.changelog ?? ""} ${fw.models.join(" ")} ${fw.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list = [...list].sort((a, b) => {
      if (sort === "version") return b.version.localeCompare(a.version, undefined, { numeric: true });
      const da = +new Date(a.publishedAt);
      const db = +new Date(b.publishedAt);
      return sort === "newest" ? db - da : da - db;
    });
    return list;
  }, [allFirmwares, target, channel, model, query, sort]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: allFirmwares.length, DRV: 0, BMS: 0, BLE: 0 };
    allFirmwares.forEach((f) => { c[f.target] = (c[f.target] ?? 0) + 1; });
    return c;
  }, [allFirmwares]);

  const onPick = (fw: FirmwareEntry) => {
    setPendingFlash(fw);
    toast.success(`Queued ${fw.version} for flash`);
    onPickToFlash?.(fw);
  };

  const clearFilters = () => {
    setTarget("ALL");
    setChannel("ALL");
    setModel("ALL");
    setQuery("");
    setSort("newest");
  };

  const filtersActive =
    target !== "ALL" || channel !== "ALL" || model !== "ALL" || query.trim() !== "" || sort !== "newest";

  return (
    <div className="px-4 pt-4 pb-28 max-w-md mx-auto space-y-3 animate-fade-in">
      {/* Header / source */}
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-primary-glow" />
            <div className="mono text-[11px] tracking-[0.2em] uppercase">Firmware catalog</div>
          </div>
          <button
            onClick={() => catalogQ.refetch()}
            disabled={catalogQ.isFetching}
            className="text-muted-foreground hover:text-primary-glow transition-colors disabled:opacity-50"
            aria-label="Refresh catalog"
          >
            {catalogQ.isFetching ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
        <div className="mono text-[10px] text-muted-foreground truncate" title={getCatalogUrl()}>
          {getCatalogUrl()}
        </div>
        <div className="mono text-[10px] text-muted-foreground mt-1">
          {catalogQ.data
            ? `${allFirmwares.length} releases · updated ${new Date(catalogQ.data.updatedAt).toLocaleDateString()}`
            : "—"}
        </div>
      </div>

      {/* Search + sort */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search version, model, notes…"
            className="mono text-xs pl-9"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setSort((s) => (s === "newest" ? "oldest" : s === "oldest" ? "version" : "newest"))}
          aria-label="Sort"
          title={`Sort: ${sort}`}
        >
          {sort === "newest" ? (
            <CalendarClock className="w-4 h-4 text-primary-glow" />
          ) : sort === "oldest" ? (
            <ArrowUpAZ className="w-4 h-4 text-primary-glow" />
          ) : (
            <ArrowDownAZ className="w-4 h-4 text-primary-glow" />
          )}
        </Button>
      </div>

      {/* Target chips */}
      <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
        {TARGET_OPTIONS.map((t) => {
          const active = t === target;
          return (
            <button
              key={t}
              onClick={() => setTarget(t)}
              className={cn(
                "shrink-0 mono text-[10px] tracking-[0.18em] uppercase px-3 py-1.5 rounded-md border transition-all flex items-center gap-1.5",
                active
                  ? "border-primary-glow/70 bg-primary/15 text-primary-glow shadow-glow"
                  : "border-border/50 text-muted-foreground hover:border-border"
              )}
            >
              {t === "ALL" ? <Filter className="w-3 h-3" /> : <Cpu className="w-3 h-3" />}
              {t}
              <span className="text-[9px] opacity-60">{counts[t] ?? 0}</span>
            </button>
          );
        })}
      </div>

      {/* Channel + model row */}
      <div className="grid grid-cols-2 gap-2">
        <SelectChip
          label="Channel"
          value={channel}
          options={CHANNEL_OPTIONS}
          onChange={(v) => setChannel(v as Channel)}
        />
        <SelectChip
          label="Model"
          value={model}
          options={modelOptions}
          onChange={setModel}
        />
      </div>

      {filtersActive && (
        <button onClick={clearFilters} className="mono text-[10px] tracking-[0.2em] uppercase text-muted-foreground hover:text-primary-glow transition-colors flex items-center gap-1">
          <X className="w-3 h-3" /> CLEAR FILTERS
        </button>
      )}

      {/* Results */}
      <div className="space-y-2">
        {catalogQ.isLoading && (
          <div className="panel p-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading catalog…
          </div>
        )}

        {!catalogQ.isLoading && filtered.length === 0 && (
          <div className="panel p-6 text-center text-sm text-muted-foreground">
            <Filter className="w-5 h-5 mx-auto mb-2 opacity-50" />
            No firmware matches these filters.
          </div>
        )}

        {filtered.map((fw) => {
          const isOpen = expanded === fw.id;
          const isQueued = queuedId === fw.id;
          return (
            <motion.div key={fw.id} layout className={cn("panel transition-all", isOpen && "panel-glow")}>
              <button
                onClick={() => setExpanded(isOpen ? null : fw.id)}
                className="w-full p-3 text-left flex items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="chip text-[9px] tracking-[0.18em] text-primary-glow">{fw.target}</span>
                    <span className="mono text-sm text-foreground">{fw.version}</span>
                    {fw.channel === "experimental" && (
                      <span className="chip chip-warn text-[9px] tracking-[0.18em] inline-flex items-center gap-1">
                        <AlertTriangle className="w-2.5 h-2.5" /> EXP
                      </span>
                    )}
                    {isQueued && (
                      <span className="chip text-[9px] tracking-[0.18em] text-primary-glow inline-flex items-center gap-1">
                        <CheckCircle2 className="w-2.5 h-2.5" /> QUEUED
                      </span>
                    )}
                  </div>
                  <div className="mono text-[10px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1">
                      <HardDrive className="w-2.5 h-2.5" /> {(fw.size / 1024).toFixed(1)} KB
                    </span>
                    <span>·</span>
                    <span>{new Date(fw.publishedAt).toLocaleDateString()}</span>
                    <span>·</span>
                    <span className="truncate">{fw.models.join(", ")}</span>
                  </div>
                </div>
                <ChevronRight
                  className={cn("w-4 h-4 text-muted-foreground shrink-0 transition-transform mt-1", isOpen && "rotate-90")}
                />
              </button>

              {isOpen && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="px-3 pb-3 border-t border-border/40 pt-3 space-y-3"
                >
                  {fw.changelog && (
                    <ScrollArea className="max-h-32">
                      <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">{fw.changelog}</p>
                    </ScrollArea>
                  )}
                  <div className="grid grid-cols-2 gap-1.5 text-[10px] mono">
                    <Meta label="hint">{TARGET_HINT[fw.target]}</Meta>
                    <Meta label="channel">{fw.channel}</Meta>
                    <Meta label="sha256" mono>{fw.sha256}</Meta>
                    <Meta label="published">{new Date(fw.publishedAt).toLocaleDateString()}</Meta>
                  </div>
                  <Button
                    onClick={() => onPick(fw)}
                    className="w-full bg-gradient-mint text-primary-foreground shadow-mint mono tracking-widest"
                  >
                    SELECT FOR FLASH
                  </Button>
                </motion.div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function SelectChip({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="panel p-2.5">
      <div className="mono text-[9px] tracking-[0.22em] uppercase text-muted-foreground mb-1">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent mono text-xs text-foreground focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-background">
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function Meta({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[8px] tracking-[0.22em] uppercase text-muted-foreground">{label}</span>
      <span className={cn("text-foreground truncate", mono && "mono")}>{children}</span>
    </div>
  );
}
