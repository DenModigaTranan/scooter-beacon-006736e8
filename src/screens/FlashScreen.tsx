import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle, Cpu, FileUp, Loader2, ShieldCheck, Zap, ChevronRight,
  Check, X, BatteryWarning, Wifi, WifiOff, Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useScooter } from "@/hooks/use-scooter";
import { usePhoneBattery } from "@/hooks/use-phone-battery";
import { fetchCatalog, type FirmwareEntry } from "@/lib/m365/catalog";
import { scooter, FlashAbortError } from "@/lib/m365/scooter-service";
import { useScooterStore } from "@/store/scooter-store";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { FlashStepList, type Phase, type PhaseId, type PhaseState } from "@/components/FlashStepList";
import { FlashLogConsole } from "@/components/FlashLogConsole";
import { formatBytes, formatDuration, formatRate } from "@/lib/format";
import { recordPairedFlash } from "@/lib/paired-profiles";

type Target = "DRV" | "BMS" | "BLE";
type Step = 1 | 2 | 3 | 4 | 5;

/** Minimum scooter battery required to flash. */
const MIN_SCOOTER_BATTERY_PCT = 50;
/** Minimum phone battery required to flash (when reported by the OS). */
const MIN_PHONE_BATTERY_PCT = 30;
/** How long the START FLASH dialog must "arm" before the user can confirm. */
const ARM_COUNTDOWN_S = 3;

export function FlashScreen() {
  const { telemetry, info, appendLog, clearLog, flashLog, rerunHandshake, state: connState, refreshInfo } = useScooter();
  const selectedDevice = useScooterStore((s) => s.selected);
  const pendingFlash = useScooterStore((s) => s.pendingFlash);
  const setPendingFlash = useScooterStore((s) => s.setPendingFlash);
  const handshake = useScooterStore((s) => s.handshake);
  const phoneBattery = usePhoneBattery();

  const [step, setStep] = useState<Step>(1);
  const [target, setTarget] = useState<Target>("DRV");
  const [selected, setSelected] = useState<FirmwareEntry | null>(null);
  const [customFile, setCustomFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [riskAck, setRiskAck] = useState(false);
  /**
   * Extra acknowledgement required when the handshake resolved against a
   * clone variant (non-strict M365 GATT layout). Reset whenever the
   * handshake snapshot changes so the user must re-tick after a re-handshake.
   */
  const [cloneAck, setCloneAck] = useState(false);
  const [progress, setProgress] = useState(0);
  const [bytesWritten, setBytesWritten] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [flashing, setFlashing] = useState(false);
  const [flashStatus, setFlashStatus] = useState<string>("idle");
  const [safeToAbort, setSafeToAbort] = useState(true);
  const [flashResult, setFlashResult] = useState<"success" | "error" | "aborted-safe" | "aborted-unsafe" | null>(null);
  const [flashError, setFlashError] = useState<string>("");
  const [retryingHandshake, setRetryingHandshake] = useState(false);

  // Per-phase status for the live progress checklist + final summary.
  const [phaseStates, setPhaseStates] = useState<Record<PhaseId, PhaseState>>({
    download: "pending", arm: "pending", write: "pending", verify: "pending", done: "pending",
  });
  // Real-time clock source so elapsed/ETA/throughput re-render every ~250ms.
  const [now, setNow] = useState<number>(() => Date.now());
  const startedAtRef = useRef<number | null>(null);
  const writeStartedAtRef = useRef<number | null>(null);
  const finishedAtRef = useRef<number | null>(null);

  // Confirmation dialogs
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [armCountdown, setArmCountdown] = useState(ARM_COUNTDOWN_S);
  const [abortOpen, setAbortOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Mirror reactive state into refs so the safety guard sees the latest
  // values without re-creating the callback on every yield.
  const telemetryRef = useRef(telemetry);
  const phoneBatteryRef = useRef(phoneBattery);
  const connStateRef = useRef(connState);
  useEffect(() => { telemetryRef.current = telemetry; }, [telemetry]);
  useEffect(() => { phoneBatteryRef.current = phoneBattery; }, [phoneBattery]);
  useEffect(() => { connStateRef.current = connState; }, [connState]);

  // Tick a clock while the live progress view is on screen so elapsed/ETA
  // re-render even when no flash event has fired in the last second.
  useEffect(() => {
    if (step !== 4) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [step]);

  // Derived live readouts: elapsed, throughput (chunks/sec window), ETA.
  const liveStats = useMemo(() => {
    const startedAt = startedAtRef.current ?? now;
    const elapsedMs = Math.max(0, now - startedAt);
    const writeStartedAt = writeStartedAtRef.current;
    let rate = 0; // bytes/sec, computed only over the writing window
    let etaMs = 0;
    if (writeStartedAt && bytesWritten > 0) {
      const writeElapsed = Math.max(1, now - writeStartedAt);
      rate = (bytesWritten / writeElapsed) * 1000;
      const remaining = Math.max(0, totalBytes - bytesWritten);
      etaMs = rate > 0 ? (remaining / rate) * 1000 : 0;
    }
    return { elapsedMs, rate, etaMs };
  }, [now, bytesWritten, totalBytes]);

  // Build the phase list shown on screen 4 / 5.
  const phases: Phase[] = useMemo(() => {
    const downloadDetail = customFile
      ? `${customFile.name} · ${formatBytes(customFile.bytes.length)}`
      : selected?.url
        ? `${selected.version} · ${formatBytes(downloadedBytes || selected.size)}`
        : selected
          ? `${selected.version} (catalog)`
          : "—";
    const writeDetail = totalBytes > 0
      ? `${formatBytes(bytesWritten)} / ${formatBytes(totalBytes)} · ${formatRate(liveStats.rate)}`
      : "—";
    return [
      { id: "download", label: "Fetch firmware", state: phaseStates.download, detail: downloadDetail },
      { id: "arm",      label: `Arm ${target} update mode`, state: phaseStates.arm },
      { id: "write",    label: "Write firmware chunks", state: phaseStates.write, detail: writeDetail },
      { id: "verify",   label: "Finalize & verify", state: phaseStates.verify },
      { id: "done",     label: "Complete", state: phaseStates.done },
    ];
  }, [phaseStates, target, customFile, selected, downloadedBytes, totalBytes, bytesWritten, liveStats.rate]);

  const catalogQ = useQuery({ queryKey: ["fw-catalog"], queryFn: ({ signal }) => fetchCatalog(signal) });

  const filtered = useMemo(
    () => (catalogQ.data?.firmwares ?? []).filter((f) => f.target === target),
    [catalogQ.data, target]
  );

  // ─── Pre-flight checks ─────────────────────────────────────────────
  const checks = useMemo(() => {
    const connected = connState === "connected";
    const handshakeOk = !!handshake?.ok;
    const battery = (telemetry?.batteryPct ?? 0) >= MIN_SCOOTER_BATTERY_PCT;
    const moving = (telemetry?.speedKph ?? 0) <= 0.5;
    // If the API isn't available we don't block — but if it IS available we
    // require ≥ MIN_PHONE_BATTERY_PCT so a dying phone can't drop the BLE link
    // mid-flash.
    const phone = phoneBattery.unsupported || phoneBattery.charging === true || (phoneBattery.pct ?? 0) >= MIN_PHONE_BATTERY_PCT;
    const fwOk = !!(selected || customFile);
    const confirmOk = confirmText === "CONFIRM";
    const versionDetected = !!info;
    // Clone-tolerant gating: if the handshake resolved against a non-strict
    // GATT variant, require an additional ack on top of the base risk ack.
    // This keeps the safety bar HIGHER for clones, not lower.
    const cloneOk = !handshake?.cloneMode || cloneAck;
    const all = connected && handshakeOk && battery && moving && phone && fwOk && confirmOk && versionDetected && riskAck && cloneOk;
    return { connected, handshakeOk, battery, moving, phone, fwOk, confirmOk, versionDetected, cloneOk, all };
  }, [connState, handshake, telemetry, phoneBattery, selected, customFile, confirmText, info, riskAck, cloneAck]);

  // Reset the clone-mode ack any time the handshake snapshot changes so the
  // user can't accidentally inherit a previous tick after a re-handshake or
  // after switching to a different device.
  useEffect(() => { setCloneAck(false); }, [handshake?.at, handshake?.variantId]);

  // ─── Safety guard called by scooter.flash() before every chunk ─────
  const safetyCheck = (): string | null => {
    if (connStateRef.current !== "connected") return "BLE connection lost";
    const t = telemetryRef.current;
    if (!t) return "lost telemetry stream";
    if (t.batteryPct < MIN_SCOOTER_BATTERY_PCT - 5) return `scooter battery dropped to ${Math.round(t.batteryPct)}%`;
    if (t.speedKph > 1) return `scooter started moving (${t.speedKph.toFixed(1)} km/h)`;
    const pb = phoneBatteryRef.current;
    if (!pb.unsupported && pb.charging === false && (pb.pct ?? 100) < 15) {
      return `phone battery critical (${pb.pct}%)`;
    }
    return null;
  };

  // ─── Pending firmware from catalog ────────────────────────────────
  useEffect(() => {
    if (!pendingFlash) return;
    setTarget(pendingFlash.target);
    setSelected(pendingFlash);
    setCustomFile(null);
    setStep(3);
    setPendingFlash(null);
  }, [pendingFlash, setPendingFlash]);

  // ─── Block accidental tab-close / refresh during a flash ──────────
  useEffect(() => {
    if (!flashing) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "Flash in progress — leaving will brick the scooter.";
      return e.returnValue;
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [flashing]);

  // ─── Arm countdown for the START FLASH dialog ─────────────────────
  useEffect(() => {
    if (!confirmOpen) { setArmCountdown(ARM_COUNTDOWN_S); return; }
    setArmCountdown(ARM_COUNTDOWN_S);
    const t = setInterval(() => {
      setArmCountdown((n) => (n > 0 ? n - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [confirmOpen]);

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

  const onRetryHandshake = async () => {
    setRetryingHandshake(true);
    try { await rerunHandshake(); } finally { setRetryingHandshake(false); }
  };

  const requestAbort = () => {
    if (!flashing) return;
    setAbortOpen(true);
  };

  const confirmAbort = () => {
    abortRef.current?.abort();
    appendLog("! ABORT requested by user");
    setAbortOpen(false);
  };

  // ─── Main flash flow ──────────────────────────────────────────────
  const startFlash = async () => {
    if (!checks.all) return;
    setConfirmOpen(false);
    setFlashing(true);
    setStep(4);
    clearLog();
    setProgress(0);
    setBytesWritten(0);
    setDownloadedBytes(0);
    setSafeToAbort(true);
    setFlashStatus("preparing");
    setFlashResult(null);
    setFlashError("");
    setPhaseStates({
      download: "active", arm: "pending", write: "pending", verify: "pending", done: "pending",
    });

    const startedAt = Date.now();
    startedAtRef.current = startedAt;
    writeStartedAtRef.current = null;
    finishedAtRef.current = null;
    setNow(startedAt);

    const ac = new AbortController();
    abortRef.current = ac;

    let firmwareBytes: Uint8Array;
    if (customFile) {
      appendLog(`> using local file: ${customFile.name} (${formatBytes(customFile.bytes.length)})`);
      firmwareBytes = customFile.bytes;
      setDownloadedBytes(customFile.bytes.length);
    } else if (selected) {
      try {
        if (selected.url) {
          appendLog(`> downloading ${selected.url}`);
          const r = await fetch(selected.url, { signal: ac.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          firmwareBytes = new Uint8Array(await r.arrayBuffer());
          setDownloadedBytes(firmwareBytes.length);
          appendLog(`> downloaded ${formatBytes(firmwareBytes.length)}`);
        } else {
          appendLog(`! no URL — using simulated buffer (${selected.size}B)`);
          firmwareBytes = new Uint8Array(selected.size);
          setDownloadedBytes(firmwareBytes.length);
        }
      } catch (e) {
        finishedAtRef.current = Date.now();
        if (ac.signal.aborted) {
          appendLog(`! aborted before flash`);
          setPhaseStates((s) => ({ ...s, download: "fail" }));
          setFlashResult("aborted-safe");
          setFlashError("Aborted before any data was written.");
        } else {
          appendLog(`! download failed: ${e}`);
          setPhaseStates((s) => ({ ...s, download: "fail" }));
          toast.error("Download failed");
          setFlashResult("error");
          setFlashError(String(e));
        }
        setFlashing(false);
        setStep(5);
        return;
      }
    } else {
      setFlashing(false);
      return;
    }

    setTotalBytes(firmwareBytes.length);
    setPhaseStates((s) => ({ ...s, download: "ok", arm: "active" }));

    try {
      for await (const p of scooter.flash(target, firmwareBytes, {
        onLog: appendLog,
        signal: ac.signal,
        preflightCheck: safetyCheck,
      })) {
        setProgress(p.pct);
        setBytesWritten(p.bytes);
        setFlashStatus(p.status);
        setSafeToAbort(p.safeToAbort);

        // Map service-level status → phase checklist.
        if (p.status === "arming") {
          setPhaseStates((s) => ({ ...s, arm: "active" }));
        } else if (p.status === "writing") {
          if (writeStartedAtRef.current === null) writeStartedAtRef.current = Date.now();
          setPhaseStates((s) => ({ ...s, arm: "ok", write: "active" }));
        } else if (p.status === "done") {
          // service emits one final "done" yield AFTER FINALIZE — treat as
          // verify+done in one go (the FINALIZE write happened just before).
          setPhaseStates((s) => ({ ...s, write: "ok", verify: "ok", done: "ok" }));
        }
      }
      finishedAtRef.current = Date.now();
      setFlashResult("success");
      setStep(5);
      toast.success(`${target} flashed`);
      // Persist outcome against the paired profile so the user sees what
      // they last flashed when they re-connect.
      if (selectedDevice) {
        const label = customFile?.name ?? selected?.version ?? "unknown";
        recordPairedFlash(selectedDevice.deviceId, {
          target, label, size: firmwareBytes.length, at: Date.now(), result: "success",
        });
      }
      // Refresh info so the paired-profile snapshot picks up new fw versions
      // on the next upsert (and the UI shows them immediately).
      refreshInfo().catch(() => {});
    } catch (e) {
      finishedAtRef.current = Date.now();
      if (e instanceof FlashAbortError) {
        appendLog(`! ABORT (${e.phase}): ${e.message}`);
        // Mark whichever phase was active as failed; leave earlier phases ok.
        setPhaseStates((s) => {
          const next = { ...s };
          (Object.keys(next) as PhaseId[]).forEach((id) => {
            if (next[id] === "active") next[id] = "fail";
          });
          return next;
        });
        const r = e.phase === "safe" ? "aborted-safe" : "aborted-unsafe";
        setFlashResult(r);
        setFlashError(e.message);
        if (e.phase === "safe") toast(`Flash aborted safely`);
        else toast.error(`Flash aborted mid-write — REFLASH IMMEDIATELY`);
        if (selectedDevice) {
          recordPairedFlash(selectedDevice.deviceId, {
            target,
            label: customFile?.name ?? selected?.version ?? "unknown",
            size: bytesWritten,
            at: Date.now(),
            result: r,
          });
        }
      } else {
        appendLog(`! ERROR ${e}`);
        setPhaseStates((s) => {
          const next = { ...s };
          (Object.keys(next) as PhaseId[]).forEach((id) => {
            if (next[id] === "active") next[id] = "fail";
          });
          return next;
        });
        setFlashResult("error");
        setFlashError(String(e));
        toast.error("Flash failed");
        if (selectedDevice) {
          recordPairedFlash(selectedDevice.deviceId, {
            target,
            label: customFile?.name ?? selected?.version ?? "unknown",
            size: bytesWritten,
            at: Date.now(),
            result: "error",
          });
        }
      }
      setStep(5);
    } finally {
      setFlashing(false);
      abortRef.current = null;
    }
  };

  const reset = () => {
    setStep(1); setSelected(null); setCustomFile(null);
    setProgress(0); setBytesWritten(0); setTotalBytes(0); setDownloadedBytes(0);
    setFlashResult(null); setConfirmText(""); setRiskAck(false);
    setFlashStatus("idle"); setFlashError("");
    setPhaseStates({
      download: "pending", arm: "pending", write: "pending", verify: "pending", done: "pending",
    });
    startedAtRef.current = null;
    writeStartedAtRef.current = null;
    finishedAtRef.current = null;
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
              <Check2
                ok={checks.connected}
                icon={checks.connected ? <Wifi className="w-4 h-4 text-primary-glow" /> : <WifiOff className="w-4 h-4 text-destructive" />}
                label="BLE connected"
                value={connState}
              />
              <Check2
                ok={checks.handshakeOk}
                label="M365 protocol handshake"
                value={
                  handshake
                    ? handshake.ok
                      ? handshake.cloneMode
                        ? `clone-tolerant (${handshake.variantId})`
                        : "validated (strict)"
                      : handshake.reason
                    : "pending"
                }
              />
              <Check2
                ok={checks.battery}
                label={`Scooter battery ≥ ${MIN_SCOOTER_BATTERY_PCT}%`}
                value={`${Math.round(telemetry?.batteryPct ?? 0)}%`}
              />
              <Check2
                ok={checks.moving}
                label="Scooter stationary"
                value={`${(telemetry?.speedKph ?? 0).toFixed(1)} km/h`}
              />
              <Check2
                ok={checks.phone}
                icon={checks.phone ? undefined : <BatteryWarning className="w-4 h-4 text-destructive" />}
                label={`Phone battery ≥ ${MIN_PHONE_BATTERY_PCT}%`}
                value={
                  phoneBattery.unsupported
                    ? "n/a"
                    : `${phoneBattery.pct ?? "—"}%${phoneBattery.charging ? " ⚡" : ""}`
                }
              />
              <Check2 ok={checks.fwOk} label="Firmware selected" value={selected?.version ?? customFile?.name ?? "—"} />
              <Check2
                ok={checks.versionDetected}
                label={`${target} version detected`}
                value={info ? (target === "DRV" ? info.drvVersion : target === "BMS" ? info.bmsVersion : info.bleVersion) : "—"}
              />
            </div>

            {!checks.handshakeOk && (
              <div className="panel mt-3 p-3 border-destructive/40 flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground leading-relaxed">
                  Flashing is disabled until the device passes the M365 GATT handshake.
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRetryHandshake}
                  disabled={retryingHandshake}
                  className="mono shrink-0"
                >
                  {retryingHandshake ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "RETRY"}
                </Button>
              </div>
            )}

            {handshake?.ok && handshake.cloneMode && (
              <div className="panel mt-3 p-4 border-warning/40">
                <div className="flex items-center gap-2 mb-2">
                  <AlertTriangle className="w-4 h-4 text-warning" />
                  <div className="mono text-xs tracking-widest text-warning">
                    CLONE-TOLERANT HANDSHAKE
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed mb-2">
                  This device does not expose the strict Xiaomi M365 GATT layout.
                  The handshake matched a community-known variant
                  {" "}<span className="mono text-warning">{handshake.variantId}</span>{" "}
                  and the protocol probe succeeded, so the device speaks M365 framing —
                  but flashing aftermarket / clone hardware is best-effort and
                  may behave differently than a genuine scooter.
                </p>
                {handshake.warnings.length > 0 && (
                  <ul className="mb-3 space-y-1">
                    {handshake.warnings.map((w) => (
                      <li key={w} className="text-[11px] mono text-warning/90 leading-snug">
                        • {w}
                      </li>
                    ))}
                  </ul>
                )}
                {handshake.resolved && (
                  <div className="mb-3 panel p-2 bg-background/40">
                    <div className="text-[10px] mono uppercase tracking-widest text-muted-foreground mb-1">
                      Resolved GATT
                    </div>
                    <div className="text-[11px] mono text-foreground/80 break-all leading-relaxed">
                      svc {handshake.resolved.service.slice(0, 8)}…<br />
                      rx&nbsp; {handshake.resolved.rx.slice(0, 8)}…<br />
                      tx&nbsp; {handshake.resolved.tx.slice(0, 8)}…
                    </div>
                  </div>
                )}
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={cloneAck}
                    onChange={(e) => setCloneAck(e.target.checked)}
                    className="mt-0.5 accent-warning"
                  />
                  <span className="text-xs text-muted-foreground leading-relaxed">
                    I understand this is a clone / non-genuine device and accept the elevated brick risk.
                  </span>
                </label>
              </div>
            )}

            <div className="panel mt-3 p-4 border-warning/40">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-warning" />
                <div className="mono text-xs tracking-widest text-warning">RISK ACKNOWLEDGEMENT</div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                Flashing the wrong firmware, or a bad disconnect mid-flash, can brick your scooter or damage the battery.
                Type <span className="mono text-warning">CONFIRM</span> below and tick the box to proceed.
              </p>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
                placeholder="CONFIRM"
                className="mono"
              />
              <label className="mt-3 flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={riskAck}
                  onChange={(e) => setRiskAck(e.target.checked)}
                  className="mt-0.5 accent-warning"
                />
                <span className="text-xs text-muted-foreground leading-relaxed">
                  I understand this can permanently damage my scooter and accept full responsibility.
                </span>
              </label>
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

            {/* Headline progress: % + bytes + elapsed/rate/ETA */}
            <div className="panel-glow scanline p-5 mt-3">
              <div className="flex items-end justify-between mb-2">
                <div className="readout text-4xl">{Math.round(progress * 100)}%</div>
                <div className="text-right">
                  <div className="mono text-[10px] text-muted-foreground tracking-widest">
                    {formatBytes(bytesWritten)} / {formatBytes(totalBytes)}
                  </div>
                  <div className="mono text-[10px] text-muted-foreground tracking-widest mt-0.5">
                    {formatRate(liveStats.rate)}
                    {liveStats.etaMs > 0 && phaseStates.write === "active" && ` · ETA ${formatDuration(liveStats.etaMs)}`}
                  </div>
                </div>
              </div>
              <Progress value={progress * 100} className="h-2" />
              <div className="mt-1 flex items-center justify-between mono text-[10px] text-muted-foreground">
                <span>{flashStatus.toUpperCase()} · {formatDuration(liveStats.elapsedMs)}</span>
                <span className={safeToAbort ? "text-primary-glow" : "text-warning"}>
                  {safeToAbort ? "SAFE TO ABORT" : "DO NOT POWER OFF"}
                </span>
              </div>
            </div>

            {/* Per-step checklist */}
            <div className="mt-3">
              <FlashStepList phases={phases} />
            </div>

            {/* Live safety strip — re-renders every telemetry tick. */}
            <div className="panel mt-3 p-3 grid grid-cols-3 gap-2 text-center">
              <Mini label="SCOOT" value={`${Math.round(telemetry?.batteryPct ?? 0)}%`} warn={(telemetry?.batteryPct ?? 0) < MIN_SCOOTER_BATTERY_PCT - 5} />
              <Mini label="PHONE" value={phoneBattery.unsupported ? "n/a" : `${phoneBattery.pct ?? "—"}%`} warn={!phoneBattery.unsupported && phoneBattery.charging === false && (phoneBattery.pct ?? 100) < 15} />
              <Mini label="LINK" value={connState === "connected" ? "OK" : "LOST"} warn={connState !== "connected"} />
            </div>

            <Button
              variant="outline"
              onClick={requestAbort}
              disabled={!flashing}
              className={cn(
                "w-full mt-3 mono tracking-widest",
                safeToAbort
                  ? "border-warning/50 text-warning hover:bg-warning/10"
                  : "border-destructive/50 text-destructive hover:bg-destructive/10"
              )}
            >
              <Square className="w-4 h-4 mr-2" />
              {safeToAbort ? "ABORT (SAFE)" : "ABORT (UNSAFE)"}
            </Button>

            <div className="mt-3">
              <FlashLogConsole lines={flashLog} height="h-44" />
            </div>
          </motion.div>
        )}

        {step === 5 && (
          <motion.div key="s5" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}>
            <ResultCard
              result={flashResult}
              target={target}
              error={flashError}
              elapsedMs={
                startedAtRef.current
                  ? (finishedAtRef.current ?? Date.now()) - startedAtRef.current
                  : 0
              }
              bytesWritten={bytesWritten}
              totalBytes={totalBytes}
              onDone={reset}
            />

            {/* Final phase summary so the user can see exactly which step failed. */}
            <div className="mt-3">
              <FlashStepList phases={phases} />
            </div>

            <div className="mt-3">
              <FlashLogConsole lines={flashLog} height="h-32" follow={false} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── START FLASH confirmation, with arm countdown ── */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest flex items-center gap-2">
              <Zap className="w-5 h-5 text-primary-glow" /> START FLASHING?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You are about to write <span className="mono text-primary-glow">{selected?.version ?? customFile?.name}</span> to
              the <span className="mono text-primary-glow">{target}</span>.
              <br />Keep your scooter close. Do not turn it off. Do not lock your phone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={startFlash}
              disabled={armCountdown > 0}
              className="bg-gradient-mint text-primary-foreground mono disabled:opacity-50"
            >
              {armCountdown > 0 ? `ARMING… ${armCountdown}s` : "FLASH NOW"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── ABORT confirmation, escalates messaging based on phase ── */}
      <AlertDialog open={abortOpen} onOpenChange={setAbortOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className={cn("mono tracking-widest flex items-center gap-2", safeToAbort ? "text-warning" : "text-destructive")}>
              <AlertTriangle className="w-5 h-5" /> ABORT FLASH?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {safeToAbort ? (
                <>No bytes have been written yet. Aborting now is safe — the scooter will be untouched.</>
              ) : (
                <>
                  <span className="text-destructive font-semibold">
                    Flashing is in progress. Aborting NOW will leave your scooter with partial firmware
                    and it will not boot until reflashed.
                  </span>{" "}
                  Only abort if you have no choice.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep flashing</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAbort}
              className={cn(
                "mono",
                safeToAbort
                  ? "bg-warning text-warning-foreground"
                  : "bg-destructive text-destructive-foreground"
              )}
            >
              {safeToAbort ? "ABORT SAFELY" : "ABORT ANYWAY"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mono text-xs tracking-[0.2em] uppercase text-muted-foreground">{children}</h2>;
}

function Check2({ ok, label, value, icon }: { ok: boolean; label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
      <div className="flex items-center gap-2">
        {icon ?? (ok ? <ShieldCheck className="w-4 h-4 text-primary-glow" /> : <X className="w-4 h-4 text-destructive" />)}
        <div className="text-sm">{label}</div>
      </div>
      <div className={cn("mono text-xs", ok ? "text-primary-glow" : "text-destructive")}>{value}</div>
    </div>
  );
}

function Mini({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={cn("rounded-md border p-2", warn ? "border-destructive/50 bg-destructive/5" : "border-border")}>
      <div className="mono text-[9px] tracking-widest text-muted-foreground">{label}</div>
      <div className={cn("mono text-sm mt-0.5", warn ? "text-destructive" : "text-primary-glow")}>{value}</div>
    </div>
  );
}

function ResultCard({
  result, target, error, elapsedMs, bytesWritten, totalBytes, onDone,
}: {
  result: "success" | "error" | "aborted-safe" | "aborted-unsafe" | null;
  target: Target;
  error: string;
  elapsedMs: number;
  bytesWritten: number;
  totalBytes: number;
  onDone: () => void;
}) {
  const summary = (
    <div className="mt-3 grid grid-cols-3 gap-2 w-full text-center">
      <SummaryStat label="Written" value={`${formatBytes(bytesWritten)}${totalBytes ? ` / ${formatBytes(totalBytes)}` : ""}`} />
      <SummaryStat label="Elapsed" value={formatDuration(elapsedMs)} />
      <SummaryStat label="Target" value={target} />
    </div>
  );

  if (result === "success") {
    return (
      <div className="panel-glow p-6 flex flex-col items-center text-center">
        <div className="w-14 h-14 rounded-full bg-gradient-mint flex items-center justify-center mb-3 pulse-ring">
          <Check className="w-7 h-7 text-primary-foreground" />
        </div>
        <div className="mono text-lg tracking-widest text-primary-glow">FLASH OK</div>
        <p className="text-sm text-muted-foreground mt-2">
          {target} on your scooter is now running new firmware. Power-cycle the scooter to fully apply.
        </p>
        {summary}
        <Button onClick={onDone} className="mt-5 mono tracking-widest">DONE</Button>
      </div>
    );
  }
  if (result === "aborted-safe") {
    return (
      <div className="panel-glow p-6 flex flex-col items-center text-center border-warning/50 shadow-none">
        <div className="w-14 h-14 rounded-full bg-warning/20 border border-warning flex items-center justify-center mb-3">
          <Square className="w-7 h-7 text-warning" />
        </div>
        <div className="mono text-lg tracking-widest text-warning">ABORTED — SAFE</div>
        <p className="text-sm text-muted-foreground mt-2">
          No data was written to the scooter. {error && <span className="block mt-1 text-xs">Reason: {error}</span>}
        </p>
        {summary}
        <Button onClick={onDone} className="mt-5 mono tracking-widest">DONE</Button>
      </div>
    );
  }
  if (result === "aborted-unsafe") {
    return (
      <div className="panel-glow p-6 flex flex-col items-center text-center border-destructive/60 shadow-none">
        <div className="w-14 h-14 rounded-full bg-destructive/20 border border-destructive flex items-center justify-center mb-3">
          <AlertTriangle className="w-7 h-7 text-destructive" />
        </div>
        <div className="mono text-lg tracking-widest text-destructive">PARTIAL FLASH</div>
        <p className="text-sm text-muted-foreground mt-2">
          The flash was interrupted mid-write. <span className="text-destructive font-semibold">Do NOT power off the scooter.</span>{" "}
          Stay connected and reflash {target} immediately.
        </p>
        {error && <p className="text-[11px] text-muted-foreground mt-2">Reason: {error}</p>}
        {summary}
        <Button onClick={onDone} className="mt-5 mono tracking-widest">REFLASH</Button>
      </div>
    );
  }
  // error
  return (
    <div className="panel-glow p-6 flex flex-col items-center text-center border-destructive/50 shadow-none">
      <div className="w-14 h-14 rounded-full bg-destructive/20 border border-destructive flex items-center justify-center mb-3">
        <X className="w-7 h-7 text-destructive" />
      </div>
      <div className="mono text-lg tracking-widest text-destructive">FLASH FAILED</div>
      <p className="text-sm text-muted-foreground mt-2">
        Don't power off. Reconnect and retry the flash to recover the scooter.
      </p>
      {error && <p className="text-[11px] text-muted-foreground mt-2">Reason: {error}</p>}
      {summary}
      <Button onClick={onDone} className="mt-5 mono tracking-widest">DONE</Button>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-2">
      <div className="mono text-[9px] tracking-widest text-muted-foreground">{label}</div>
      <div className="mono text-xs mt-0.5 truncate">{value}</div>
    </div>
  );
}
