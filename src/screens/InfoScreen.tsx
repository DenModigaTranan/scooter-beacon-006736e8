import { useEffect, useState } from "react";
import {
  Copy, Check, ShieldAlert, PenLine, Loader2, CheckCircle2, XCircle,
  RefreshCw, Cpu, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useScooter } from "@/hooks/use-scooter";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { VerifyResult, ExtendedDeviceInfo } from "@/lib/m365/scooter-service";
import { cn } from "@/lib/utils";

function Row({ label, value, copyable = true }: { label: string; value?: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false);
  const v = value ?? "—";

  const onCopy = async () => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="flex items-center justify-between gap-3 py-3 border-b border-border/40 last:border-0">
      <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 min-w-0">
        <div className="mono text-sm text-foreground truncate">{v}</div>
        {copyable && value && (
          <button onClick={onCopy} className="text-muted-foreground hover:text-primary-glow transition-colors">
            {copied ? <Check className="w-3.5 h-3.5 text-primary-glow" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

type Step = "confirm" | "writing" | "verifying" | "verified" | "mismatch";

export function InfoScreen() {
  const { info, writeSerialAndVerify, refreshInfo, refreshExtendedInfo, extendedInfo, selected } = useScooter();
  const [editingSerial, setEditingSerial] = useState(false);
  const [newSerial, setNewSerial] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [step, setStep] = useState<Step>("confirm");
  const [attempt, setAttempt] = useState(0);
  const [lastResult, setLastResult] = useState<VerifyResult | null>(null);
  const MAX_ATTEMPTS = 3;

  const [loadingExtras, setLoadingExtras] = useState(false);
  const [extrasError, setExtrasError] = useState<string | null>(null);

  // Auto-load extras the first time the screen mounts so the panel isn't
  // empty. Subsequent loads are user-triggered via the refresh button.
  useEffect(() => {
    if (extendedInfo) return;
    let cancelled = false;
    (async () => {
      setLoadingExtras(true);
      setExtrasError(null);
      try {
        await refreshExtendedInfo();
      } catch (e) {
        if (!cancelled) setExtrasError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingExtras(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRefreshExtras = async () => {
    setLoadingExtras(true);
    setExtrasError(null);
    try {
      await refreshExtendedInfo();
      toast.success("Identifiers refreshed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExtrasError(msg);
      toast.error("Refresh failed");
    } finally {
      setLoadingExtras(false);
    }
  };

  // Reset step machine when dialog closes
  useEffect(() => {
    if (!confirmOpen) {
      setStep("confirm");
      setConfirmText("");
      setLastResult(null);
      setAttempt(0);
    }
  }, [confirmOpen]);

  const runWriteVerify = async () => {
    setStep("writing");
    setAttempt((a) => a + 1);
    // Small UX delay so the user sees "WRITING…" before "VERIFYING…"
    await new Promise((r) => setTimeout(r, 250));
    setStep("verifying");
    try {
      const result = await writeSerialAndVerify(newSerial.trim(), 1);
      setLastResult(result);
      if (result.ok) {
        setStep("verified");
        toast.success("Serial verified");
      } else {
        setStep("mismatch");
      }
    } catch (e) {
      setLastResult({
        ok: false,
        written: newSerial.trim(),
        readBack: "",
        attempt: 1,
        readError: String(e),
      });
      setStep("mismatch");
    }
  };

  const onCommit = async () => {
    if (confirmText !== "CONFIRM") return;
    await runWriteVerify();
  };

  const onRetry = async () => {
    if (attempt >= MAX_ATTEMPTS) {
      toast.error("Max retries reached");
      return;
    }
    await runWriteVerify();
  };

  const closeAndFinish = () => {
    setConfirmOpen(false);
    setEditingSerial(false);
    setNewSerial("");
  };

  const writing = step === "writing" || step === "verifying";

  return (
    <div className="px-4 pt-4 pb-28 max-w-md mx-auto space-y-4 animate-fade-in">
      <div className="panel p-4">
        <div className="flex items-center justify-between mb-1">
          <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">Device</div>
          <span className="chip">{selected?.name ?? "—"}</span>
        </div>
        <div className="readout text-xl mt-1">{info?.serial ?? "—"}</div>
      </div>

      <div className="panel p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="mono text-[11px] tracking-[0.2em] uppercase">Identifiers</div>
          <button
            onClick={() => { refreshInfo(); toast.success("Re-reading…"); }}
            className="text-muted-foreground hover:text-primary-glow transition-colors"
            aria-label="Refresh identifiers"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <Row label="Serial number" value={info?.serial} />
        <Row label="DRV firmware" value={info?.drvVersion} />
        <Row label="BLE firmware" value={info?.bleVersion} />
        <Row label="BMS firmware" value={info?.bmsVersion} />
        <Row label="BMS serial" value={info?.bmsSerial} />
        <Row label="Hardware version" value={info?.hwVersion} />
        <Row label="Manufacture date" value={info?.manufactureDate} />
        <Row label="Total mileage" value={info ? `${info.totalMileageKm.toFixed(1)} km` : undefined} />
      </div>

      {/* Extended device identifiers (read on demand) */}
      <ExtendedInfoPanel
        ext={extendedInfo}
        loading={loadingExtras}
        error={extrasError}
        onRefresh={onRefreshExtras}
      />

      {/* Change serial */}
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-3">
          <PenLine className="w-4 h-4 text-primary-glow" />
          <div className="mono text-[11px] tracking-[0.2em] uppercase">Change serial</div>
        </div>
        <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
          Modifying the serial can void warranty and may break theft-protection links. Use only on scooters you own. The
          new value is written, then immediately read back to verify the device accepted it.
        </p>

        {!editingSerial ? (
          <Button variant="outline" onClick={() => setEditingSerial(true)} className="w-full mono tracking-widest border-warning/50 text-warning hover:bg-warning/10">
            EDIT SERIAL
          </Button>
        ) : (
          <div className="space-y-3">
            <Input
              value={newSerial}
              onChange={(e) => setNewSerial(e.target.value.toUpperCase())}
              maxLength={14}
              placeholder="14 chars max — A-Z 0-9 /"
              className="mono"
            />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => { setEditingSerial(false); setNewSerial(""); }}>
                Cancel
              </Button>
              <Button
                className="flex-1 bg-warning text-warning-foreground hover:opacity-90 mono"
                disabled={!newSerial.trim()}
                onClick={() => setConfirmOpen(true)}
              >
                REVIEW
              </Button>
            </div>
          </div>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!writing) setConfirmOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest flex items-center gap-2">
              {step === "confirm" && <><ShieldAlert className="w-5 h-5 text-warning" /> CONFIRM SERIAL CHANGE</>}
              {step === "writing" && <><Loader2 className="w-5 h-5 text-primary-glow animate-spin" /> WRITING…</>}
              {step === "verifying" && <><Loader2 className="w-5 h-5 text-primary-glow animate-spin" /> VERIFYING…</>}
              {step === "verified" && <><CheckCircle2 className="w-5 h-5 text-primary-glow" /> VERIFIED</>}
              {step === "mismatch" && <><XCircle className="w-5 h-5 text-destructive" /> {lastResult?.readError ? "READ FAILED" : "MISMATCH"}</>}
            </AlertDialogTitle>

            {step === "confirm" && (
              <AlertDialogDescription className="space-y-2">
                <span>This permanently overwrites the scooter serial number from</span>
                <span className="block mono text-xs text-muted-foreground">{info?.serial ?? "—"}</span>
                <span>to</span>
                <span className="block mono text-xs text-primary-glow">{newSerial || "—"}</span>
                <span>Type <span className="mono text-warning">CONFIRM</span> to proceed.</span>
              </AlertDialogDescription>
            )}

            {step === "writing" && (
              <AlertDialogDescription>
                Sending 14-byte payload to ESC reg 0x10…
              </AlertDialogDescription>
            )}

            {step === "verifying" && (
              <AlertDialogDescription>
                Re-reading ESC serial to confirm…
              </AlertDialogDescription>
            )}

            {step === "verified" && lastResult && (
              <AlertDialogDescription className="space-y-1">
                <span className="block">Read back matches the value written.</span>
                <span className="block mono text-xs text-primary-glow">{lastResult.readBack}</span>
              </AlertDialogDescription>
            )}

            {step === "mismatch" && lastResult && (
              <AlertDialogDescription className="space-y-2">
                {lastResult.readError ? (
                  <span className="block">The verifying read failed: <span className="mono text-xs text-destructive">{lastResult.readError}</span></span>
                ) : (
                  <span className="block">The device returned a different serial than what was written.</span>
                )}
                <div className="mono text-[11px] grid grid-cols-[88px_1fr] gap-y-1 mt-2 p-2 rounded border border-border/50 bg-muted/30">
                  <span className="text-muted-foreground">expected</span>
                  <span className="text-primary-glow truncate">{lastResult.written || "—"}</span>
                  <span className="text-muted-foreground">read back</span>
                  <span className="text-destructive truncate">{lastResult.readBack || "—"}</span>
                  <span className="text-muted-foreground">attempt</span>
                  <span>{attempt} / {MAX_ATTEMPTS}</span>
                </div>
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>

          {step === "confirm" && (
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value.toUpperCase())} className="mono" placeholder="CONFIRM" />
          )}

          <AlertDialogFooter>
            {step === "confirm" && (
              <>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={confirmText !== "CONFIRM"}
                  onClick={(e) => { e.preventDefault(); onCommit(); }}
                  className="bg-warning text-warning-foreground hover:opacity-90 mono"
                >
                  WRITE
                </AlertDialogAction>
              </>
            )}

            {writing && (
              <Button disabled className="mono opacity-60">
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> WORKING…
              </Button>
            )}

            {step === "verified" && (
              <AlertDialogAction
                onClick={(e) => { e.preventDefault(); closeAndFinish(); }}
                className="bg-primary text-primary-foreground hover:opacity-90 mono"
              >
                DONE
              </AlertDialogAction>
            )}

            {step === "mismatch" && (
              <>
                <AlertDialogCancel onClick={closeAndFinish}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={(e) => { e.preventDefault(); onRetry(); }}
                  disabled={attempt >= MAX_ATTEMPTS}
                  className="bg-warning text-warning-foreground hover:opacity-90 mono"
                >
                  RETRY
                </AlertDialogAction>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================================================
// Extended device identifiers panel
// ============================================================================

function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/**
 * Read-only panel showing extended identifiers pulled from the scooter on
 * demand: model id, COC region code, ESC last-fault, BLE/BMS hardware
 * revisions, BMS cycle count + state-of-health, and the BLE peripheral
 * address. The refresh button re-issues the BLE reads and shows live
 * loading + error feedback. Errors are surfaced both inline (panel chip)
 * and via toast (in the parent).
 */
function ExtendedInfoPanel({
  ext, loading, error, onRefresh,
}: {
  ext: ExtendedDeviceInfo | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void | Promise<void>;
}) {
  const errorWord = ext?.errorCode && ext.errorCode !== "0x0000" && ext.errorCode !== "—";

  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-primary-glow" />
          <div className="mono text-[11px] tracking-[0.2em] uppercase">Device identifiers</div>
        </div>
        <div className="flex items-center gap-2">
          {ext?.readAt && !loading && (
            <span className="mono text-[9px] text-muted-foreground/80 tracking-widest uppercase">
              {formatAge(ext.readAt)}
            </span>
          )}
          <button
            onClick={onRefresh}
            disabled={loading}
            className={cn(
              "text-muted-foreground hover:text-primary-glow transition-colors disabled:opacity-50",
              loading && "text-primary-glow",
            )}
            aria-label="Refresh device identifiers"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground mb-2 leading-relaxed">
        Extra metadata pulled directly from ESC, BLE, and BMS controllers. Tap
        refresh to re-read all values over BLE.
      </p>

      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
          <div className="mono text-[10px] text-destructive break-all leading-relaxed">{error}</div>
        </div>
      )}

      <Row label="Model" value={ext?.modelId} />
      <Row label="COC version" value={ext?.cocVersion} />
      <Row label="BLE address" value={ext?.bleAddress} />
      <Row label="BLE hardware" value={ext?.bleHwVersion} />
      <Row label="BMS hardware" value={ext?.bmsHwVersion} />
      <Row
        label="BMS cycles"
        value={ext?.bmsCycles !== undefined ? String(ext.bmsCycles) : undefined}
        copyable={false}
      />
      <Row
        label="Battery health"
        value={ext?.bmsHealthPct !== undefined ? `${ext.bmsHealthPct}%` : undefined}
        copyable={false}
      />
      <Row
        label="Last error"
        value={ext?.errorCode}
        copyable={!!ext?.errorCode}
      />

      {errorWord && (
        <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-2 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
          <div className="text-[11px] text-warning leading-relaxed">
            ESC reports a non-zero fault code <span className="mono">{ext?.errorCode}</span>.
            Investigate before riding or flashing.
          </div>
        </div>
      )}
    </div>
  );
}