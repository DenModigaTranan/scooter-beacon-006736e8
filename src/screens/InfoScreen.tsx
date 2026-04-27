import { useState } from "react";
import { Copy, Check, ShieldAlert, PenLine } from "lucide-react";
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
        {copyable && (
          <button onClick={onCopy} className="text-muted-foreground hover:text-primary-glow transition-colors">
            {copied ? <Check className="w-3.5 h-3.5 text-primary-glow" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

export function InfoScreen() {
  const { info, writeSerial, selected } = useScooter();
  const [editingSerial, setEditingSerial] = useState(false);
  const [newSerial, setNewSerial] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const onCommit = async () => {
    if (confirmText !== "CONFIRM") return;
    try {
      await writeSerial(newSerial);
      toast.success("Serial updated");
      setConfirmOpen(false);
      setEditingSerial(false);
      setNewSerial("");
      setConfirmText("");
    } catch (e) {
      toast.error(String(e));
    }
  };

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
        <Row label="Serial number" value={info?.serial} />
        <Row label="DRV firmware" value={info?.drvVersion} />
        <Row label="BLE firmware" value={info?.bleVersion} />
        <Row label="BMS firmware" value={info?.bmsVersion} />
        <Row label="Total mileage" value={info ? `${info.totalMileageKm.toFixed(1)} km` : undefined} />
      </div>

      {/* Change serial */}
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-3">
          <PenLine className="w-4 h-4 text-primary-glow" />
          <div className="mono text-[11px] tracking-[0.2em] uppercase">Change serial</div>
        </div>
        <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
          Modifying the serial can void warranty and may break theft-protection links. Use only on scooters you own.
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

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { setConfirmOpen(o); if (!o) setConfirmText(""); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-warning" /> CONFIRM SERIAL CHANGE
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span>This permanently overwrites the scooter serial number from</span>
              <span className="block mono text-xs text-muted-foreground">{info?.serial ?? "—"}</span>
              <span>to</span>
              <span className="block mono text-xs text-primary-glow">{newSerial || "—"}</span>
              <span>Type <span className="mono text-warning">CONFIRM</span> to proceed.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value.toUpperCase())} className="mono" placeholder="CONFIRM" />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={confirmText !== "CONFIRM"}
              onClick={onCommit}
              className="bg-warning text-warning-foreground hover:opacity-90 mono"
            >
              WRITE
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
