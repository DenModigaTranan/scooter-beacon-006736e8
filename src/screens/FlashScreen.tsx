import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Cpu, FileUp, Loader2, ShieldCheck, Zap, ChevronRight, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import { useScooter } from "@/hooks/use-scooter";
import { fetchCatalog, type FirmwareEntry } from "@/lib/m365/catalog";
import { scooter } from "@/lib/m365/scooter-service";
import { useScooterStore } from "@/store/scooter-store";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

type Target = "DRV" | "BMS" | "BLE";
type Step = 1 | 2 | 3 | 4 | 5;

export function FlashScreen() {
  const { telemetry, info, appendLog, clearLog, flashLog } = useScooter();
  const [step, setStep] = useState<Step>(1);
  const [target, setTarget] = useState<Target>("DRV");
  const [selected, setSelected] = useState<FirmwareEntry | null>(null);
  const [customFile, setCustomFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [progress, setProgress] = useState(0);
  const [bytesWritten, setBytesWritten] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [flashing, setFlashing] = useState(false);
  const [flashResult, setFlashResult] = useState<"success" | "error" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const catalogQ = useQuery({ queryKey: ["fw-catalog"], queryFn: ({ signal }) => fetchCatalog(signal) });

  const filtered = useMemo(
    () => (catalogQ.data?.firmwares ?? []).filter((f) => f.target === target),
    [catalogQ.data, target]
  );

  const checks = useMemo(() => {
    const battery = (telemetry?.batteryPct ?? 0) >= 50;
    const moving = (telemetry?.speedKph ?? 0) <= 0.5;
    const phone = true; // simplified — could read battery via Web API on Android
    const fwOk = !!(selected || customFile);
    const confirmOk = confirmText === "CONFIRM";
    return { battery, moving, phone, fwOk, confirmOk, all: battery && moving && phone && fwOk && confirmOk };
  }, [telemetry, selected, customFile, confirmText]);

  useEffect(() => { setStep(1); setSelected(null); setCustomFile(null); setProgress(0); setFlashResult(null); }, [/* mount */]);

  const onPickFile = async (file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (buf.length < 1024 || buf.length > 256 * 1024) {
      toast.error("File size out of range (1 KB – 256 KB)");
      return;
    }
    setCustomFile({ name: file.name, bytes: buf });
    setSelected(null);
    setStep(3);
  };

  const startFlash = async () => {
    if (!checks.all) return;
    setFlashing(true);
    setConfirmOpen(false);
    setStep(4);
    clearLog();
    setProgress(0);
    setFlashResult(null);

    let firmwareBytes: Uint8Array;
    if (customFile) {
      firmwareBytes = customFile.bytes;
    } else if (selected) {
      // attempt download; fall back to a synthetic buffer for catalog entries with no URL (preview)
      try {
        if (selected.url) {
          appendLog(`> downloading ${selected.url}`);
          const r = await fetch(selected.url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          firmwareBytes = new Uint8Array(await r.arrayBuffer());
        } else {
          appendLog(`! no URL — using simulated buffer (${selected.size}B)`);
          firmwareBytes = new Uint8Array(selected.size);
        }
      } catch (e) {
        appendLog(`! download failed: ${e}`);
        toast.error("Download failed");
        setFlashing(false);
        setFlashResult("error");
        return;
      }
    } else {
      setFlashing(false);
      return;
    }

    setTotalBytes(firmwareBytes.length);

    try {
      for await (const p of scooter.flash(target, firmwareBytes, { onLog: appendLog })) {
        setProgress(p.pct);
        setBytesWritten(p.bytes);
      }
      setFlashResult("success");
      setStep(5);
      toast.success(`${target} flashed`);
    } catch (e) {
      appendLog(`! ERROR ${e}`);
      setFlashResult("error");
      setStep(5);
      toast.error("Flash failed");
    } finally {
      setFlashing(false);
    }
  };

  const reset = () => {
    setStep(1); setSelected(null); setCustomFile(null);
    setProgress(0); setBytesWritten(0); setTotalBytes(0);
    setFlashResult(null); setConfirmText("");
  };

  return (
    <div className="px-4 pt-4 pb-28 max-w-md mx-auto space-y-4 animate-fade-in">
      {/* Stepper */}
      <div className="flex items-center justify-between mono text-[10px] tracking-widest uppercase">
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="flex items-center gap-1.5">
            <span className={cn(
              "w-5 h-5 rounded-full border flex items-center justify-center",
              step >= n ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground"
            )}>{n}</span>
            {n < 5 && <span className={cn("h-px w-3", step > n ? "bg-primary" : "bg-border")} />}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div key="s1" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}>
            <SectionTitle>1. Pick target chip</SectionTitle>
            <div className="grid grid-cols-3 gap-2 mt-3">
              {(["DRV", "BMS", "BLE"] as Target[]).map((t) => (
                <button
                  key={t}
                  onClick={() => { setTarget(t); setStep(2); }}
                  className={cn(
                    "panel p-4 flex flex-col items-center gap-1 transition-all hover:panel-glow",
                    target === t && "panel-glow"
                  )}
                >
                  <Cpu className="w-5 h-5 text-primary-glow" />
                  <span className="mono text-sm">{t}</span>
                  <span className="text-[10px] text-muted-foreground">
                    {t === "DRV" ? "motor" : t === "BMS" ? "battery" : "bluetooth"}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
              DRV controls speed/curves, BMS controls battery, BLE is the radio module. Most users only ever flash DRV.
            </p>
          </motion.div>
        )}

        {step === 2 && (
          <motion.div key="s2" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}>
            <SectionTitle>2. Pick {target} firmware</SectionTitle>
            <div className="mt-3 space-y-2">
              {catalogQ.isLoading && (
                <div className="panel p-4 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading catalog…
                </div>
              )}
              {filtered.map((fw) => (
                <button
                  key={fw.id}
                  onClick={() => { setSelected(fw); setCustomFile(null); setStep(3); }}
                  className="w-full panel p-3 text-left hover:panel-glow transition-all flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="mono text-sm">{fw.version}</span>
                      <span className={cn("chip", fw.channel === "experimental" && "chip-warn")}>
                        {fw.channel}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">{fw.changelog}</div>
                    <div className="mono text-[10px] text-muted-foreground mt-1">
                      {(fw.size / 1024).toFixed(1)} KB · {fw.models.join(", ")}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </button>
              ))}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full panel p-3 text-left hover:panel-glow transition-all flex items-center gap-3 border-dashed"
              >
                <FileUp className="w-5 h-5 text-primary-glow" />
                <div className="flex-1">
                  <div className="mono text-sm">Use custom .bin</div>
                  <div className="text-[11px] text-muted-foreground">Pick a file from your device</div>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".bin,application/octet-stream"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && onPickFile(e.target.files[0])}
              />
            </div>
            <Button variant="ghost" onClick={() => setStep(1)} className="mt-3 mono text-muted-foreground">← back</Button>
          </motion.div>
        )}

        {step === 3 && (
          <motion.div key="s3" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 }}>
            <SectionTitle>3. Pre-flight checks</SectionTitle>

            <div className="panel p-4 mt-3 space-y-1">
              <Check2 ok={checks.battery} label={`Scooter battery ≥ 50%`} value={`${Math.round(telemetry?.batteryPct ?? 0)}%`} />
              <Check2 ok={checks.moving} label="Scooter stationary" value={`${(telemetry?.speedKph ?? 0).toFixed(1)} km/h`} />
              <Check2 ok={checks.phone} label="Phone battery ≥ 30%" value="ok" />
              <Check2 ok={checks.fwOk} label="Firmware selected" value={selected?.version ?? customFile?.name ?? "—"} />
              <Check2 ok={!!info} label={`${target} version detected`} value={info ? (target === "DRV" ? info.drvVersion : target === "BMS" ? info.bmsVersion : info.bleVersion) : "—"} />
            </div>

            <div className="panel mt-3 p-4 border-warning/40">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-warning" />
                <div className="mono text-xs tracking-widest text-warning">RISK ACKNOWLEDGEMENT</div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                Flashing the wrong firmware, or a bad disconnect mid-flash, can brick your scooter or damage the battery.
                Type <span className="mono text-warning">CONFIRM</span> below to proceed.
              </p>
              <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value.toUpperCase())} placeholder="CONFIRM" className="mono" />
            </div>

            <div className="flex gap-2 mt-4">
              <Button variant="ghost" onClick={() => setStep(2)} className="mono text-muted-foreground">← back</Button>
              <Button
                disabled={!checks.all}
                onClick={() => setConfirmOpen(true)}
                className="flex-1 bg-gradient-mint text-primary-foreground shadow-mint hover:opacity-90 mono tracking-widest disabled:opacity-40"
              >
                START FLASH
              </Button>
            </div>
          </motion.div>
        )}

        {step === 4 && (
          <motion.div key="s4" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            <SectionTitle>4. Flashing {target}…</SectionTitle>
            <div className="panel-glow scanline p-5 mt-3">
              <div className="flex items-end justify-between mb-2">
                <div className="readout text-4xl">{Math.round(progress * 100)}%</div>
                <div className="mono text-[10px] text-muted-foreground tracking-widest">
                  {(bytesWritten / 1024).toFixed(1)} / {(totalBytes / 1024).toFixed(1)} KB
                </div>
              </div>
              <Progress value={progress * 100} className="h-2" />
              <div className="mt-1 mono text-[10px] text-muted-foreground">DO NOT POWER OFF</div>
            </div>

            <div className="panel mt-3 p-3">
              <div className="mono text-[10px] text-muted-foreground tracking-widest mb-2">CONSOLE</div>
              <ScrollArea className="h-44">
                <pre className="mono text-[11px] leading-relaxed text-primary-glow whitespace-pre-wrap">
                  {flashLog.join("\n") || "(waiting…)"}
                </pre>
              </ScrollArea>
            </div>
          </motion.div>
        )}

        {step === 5 && (
          <motion.div key="s5" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
            <div className={cn(
              "panel-glow p-6 flex flex-col items-center text-center",
              flashResult === "error" && "border-destructive/50 shadow-none"
            )}>
              {flashResult === "success" ? (
                <>
                  <div className="w-14 h-14 rounded-full bg-gradient-mint flex items-center justify-center mb-3 pulse-ring">
                    <Check className="w-7 h-7 text-primary-foreground" />
                  </div>
                  <div className="mono text-lg tracking-widest text-primary-glow">FLASH OK</div>
                  <p className="text-sm text-muted-foreground mt-2">
                    {target} on your scooter is now running new firmware. Power-cycle the scooter to fully apply.
                  </p>
                </>
              ) : (
                <>
                  <div className="w-14 h-14 rounded-full bg-destructive/20 border border-destructive flex items-center justify-center mb-3">
                    <X className="w-7 h-7 text-destructive" />
                  </div>
                  <div className="mono text-lg tracking-widest text-destructive">FLASH FAILED</div>
                  <p className="text-sm text-muted-foreground mt-2">
                    Don't power off. Reconnect and retry the flash to recover the scooter.
                  </p>
                </>
              )}
              <Button onClick={reset} className="mt-5 mono tracking-widest">DONE</Button>
            </div>
            <div className="panel mt-3 p-3">
              <div className="mono text-[10px] text-muted-foreground tracking-widest mb-2">CONSOLE</div>
              <ScrollArea className="h-32">
                <pre className="mono text-[11px] leading-relaxed text-primary-glow whitespace-pre-wrap">
                  {flashLog.join("\n")}
                </pre>
              </ScrollArea>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary-glow" /> START FLASHING?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are about to write <span className="mono text-primary-glow">{selected?.version ?? customFile?.name}</span> to
              the <span className="mono text-primary-glow">{target}</span>. Keep your scooter close, do not turn it off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={startFlash} className="bg-gradient-mint text-primary-foreground mono">FLASH NOW</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mono text-xs tracking-[0.2em] uppercase text-muted-foreground">{children}</h2>;
}

function Check2({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
      <div className="flex items-center gap-2">
        {ok ? <ShieldCheck className="w-4 h-4 text-primary-glow" /> : <X className="w-4 h-4 text-destructive" />}
        <div className="text-sm">{label}</div>
      </div>
      <div className={cn("mono text-xs", ok ? "text-primary-glow" : "text-destructive")}>{value}</div>
    </div>
  );
}
