import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useScooter, configureHandshakeRetry, handshakeRetryConfig } from "@/hooks/use-scooter";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useScooterStore } from "@/store/scooter-store";
import { getCatalogUrl, setCatalogUrl } from "@/lib/m365/catalog";
import {
  addTrustedSource,
  exportTrustedSourcesJson,
  importTrustedSources,
  listTrustedSources,
  removeTrustedSource,
  normalisePrefix,
  type TrustedSource,
} from "@/lib/trusted-sources";
import { ProfilePicker } from "@/components/ProfilePicker";
import { Share } from "@capacitor/share";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import { Download, Github, LogOut, Plus, Save, ShieldCheck, Trash2, Upload, X } from "lucide-react";
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

export function SettingsScreen() {
  const { disconnect, selected, flashLog, clearLog } = useScooter();
  const [url, setUrl] = useState(getCatalogUrl());
  const [trusted, setTrusted] = useState<TrustedSource[]>(() => listTrustedSources());
  const [newLabel, setNewLabel] = useState("");
  const [newPrefix, setNewPrefix] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);

  const [retryEnabled, setRetryEnabled] = useState(handshakeRetryConfig.enabled);
  const [retryBackoff, setRetryBackoff] = useState(String(handshakeRetryConfig.backoffMs));

  const [pendingRestore, setPendingRestore] = useState<{
    file: File;
    json: string;
    incoming: number;
  } | null>(null);

  const onBackupTrusted = async () => {
    const json = exportTrustedSourcesJson();
    const filename = `scootflash-trusted-sources-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    if (Capacitor.isNativePlatform()) {
      try {
        await Share.share({
          title: filename,
          text: json,
          dialogTitle: "Backup trusted sources",
        });
        toast.success(`Backup ready (${trusted.length} source(s))`);
        return;
      } catch {
        try {
          await navigator.clipboard.writeText(json);
          toast.success("Backup copied to clipboard");
          return;
        } catch {
          toast.error("Backup failed");
          return;
        }
      }
    }
    try {
      const blob = new Blob([json], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      toast.success(`Backup downloaded (${trusted.length} source(s))`);
    } catch {
      toast.error("Backup failed");
    }
  };

  const onPickRestoreFile = async (file: File) => {
    if (useScooterStore.getState().flashing) {
      toast.error("Stop flashing before restoring trusted sources");
      return;
    }
    try {
      const text = await file.text();
      // Dry-run parse: importTrustedSources also validates.
      const parsed = JSON.parse(text);
      const incoming = Array.isArray(parsed)
        ? parsed.length
        : Array.isArray(parsed?.sources)
        ? parsed.sources.length
        : 0;
      if (incoming === 0) {
        toast.error("Backup file contains no trusted sources");
        return;
      }
      setPendingRestore({ file, json: text, incoming });
    } catch (e) {
      toast.error(
        `Could not read backup: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const confirmRestore = () => {
    if (!pendingRestore) return;
    if (useScooterStore.getState().flashing) {
      toast.error("Stop flashing before restoring trusted sources");
      setPendingRestore(null);
      return;
    }
    try {
      const result = importTrustedSources(pendingRestore.json, { replace: true });
      refreshTrusted();
      toast.success(
        `Restored ${result.total} source(s) (${result.skipped} skipped)`,
      );
    } catch (e) {
      toast.error(
        `Restore failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setPendingRestore(null);
    }
  };

  const onImportTrustedFile = async (file: File) => {
    try {
      const text = await file.text();
      const result = importTrustedSources(text);
      refreshTrusted();
      toast.success(
        `Imported ${result.added} new, skipped ${result.skipped} (total ${result.total})`,
      );
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const refreshTrusted = () => setTrusted(listTrustedSources());

  const onAddTrusted = () => {
    const norm = normalisePrefix(newPrefix);
    if (!norm) {
      toast.error("Enter a valid https:// URL or origin");
      return;
    }
    const entry = addTrustedSource(newLabel, newPrefix);
    if (!entry) {
      toast.error("Could not add trusted source");
      return;
    }
    refreshTrusted();
    setNewLabel("");
    setNewPrefix("");
    toast.success(`Trusted: ${entry.label}`);
  };

  const onRemoveTrusted = (prefix: string) => {
    removeTrustedSource(prefix);
    refreshTrusted();
    toast.success("Removed trusted source");
  };

  const onSave = () => {
    setCatalogUrl(url);
    toast.success("Catalog URL saved");
  };

  const exportLog = async () => {
    const text = flashLog.join("\n") || "(empty)";
    if (Capacitor.isNativePlatform()) {
      try {
        await Share.share({ title: "ScootFlash log", text, dialogTitle: "Export diagnostic log" });
      } catch {
        await navigator.clipboard.writeText(text);
        toast.success("Log copied to clipboard");
      }
    } else {
      await navigator.clipboard.writeText(text);
      toast.success("Log copied to clipboard");
    }
  };

  return (
    <div className="px-4 pt-4 pb-28 max-w-md mx-auto space-y-4 animate-fade-in">
      <ProfilePicker />

      <div className="panel p-4">
        <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground mb-2">Connected device</div>
        <div className="mono text-sm">{selected?.name ?? "—"}</div>
        <Button onClick={disconnect} variant="outline" className="w-full mt-3 mono tracking-widest border-destructive/40 text-destructive hover:bg-destructive/10">
          <LogOut className="w-4 h-4 mr-2" /> DISCONNECT
        </Button>
      </div>

      <div className="panel p-4">
        <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground mb-2">Firmware catalog URL</div>
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/catalog.json" className="mono text-xs" />
        <div className="flex gap-2 mt-2">
          <Button variant="ghost" className="flex-1 mono" onClick={() => { setUrl(""); setCatalogUrl(""); toast.success("Reset to default"); }}>RESET</Button>
          <Button onClick={onSave} className="flex-1 bg-gradient-mint text-primary-foreground mono tracking-widest">SAVE</Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
          Point this at your own JSON file to host a custom firmware list. Schema mirrors the built-in catalog.
        </p>
      </div>

      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-3.5 h-3.5 text-primary-glow" />
          <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
            Trusted firmware sources
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed mb-3">
          When a catalog entry has no SHA-256, downloads from these origins or
          path prefixes are treated as trusted and the unverified-firmware
          prompt is skipped. Use only sources you control or fully trust.
        </p>

        <div className="space-y-2 mb-3">
          {trusted.length === 0 && (
            <div className="text-[11px] mono text-muted-foreground italic">
              No trusted sources yet.
            </div>
          )}
          {trusted.map((s) => (
            <div
              key={s.prefix}
              className="flex items-center gap-2 panel p-2 bg-background/40"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-primary-glow shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="mono text-xs truncate">{s.label}</div>
                <div className="mono text-[10px] text-muted-foreground truncate">
                  {s.prefix}
                </div>
              </div>
              <button
                onClick={() => onRemoveTrusted(s.prefix)}
                className="text-muted-foreground hover:text-destructive shrink-0"
                aria-label={`Remove ${s.label}`}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. My self-hosted catalog)"
            className="mono text-xs"
          />
          <Input
            value={newPrefix}
            onChange={(e) => setNewPrefix(e.target.value)}
            placeholder="https://fw.example.com or https://host/path/"
            className="mono text-xs"
          />
          <Button
            onClick={onAddTrusted}
            disabled={!newPrefix.trim()}
            className="w-full mono tracking-widest"
            variant="outline"
          >
            <Plus className="w-4 h-4 mr-2" /> ADD TRUSTED SOURCE
          </Button>
        </div>

        <div className="flex gap-2 mt-3">
          <Button
            type="button"
            variant="outline"
            className="flex-1 mono tracking-widest"
            onClick={onBackupTrusted}
            disabled={trusted.length === 0}
          >
            <Save className="w-4 h-4 mr-2" /> BACKUP
          </Button>
          <Button
            type="button"
            variant="outline"
            className="flex-1 mono tracking-widest"
            onClick={() => importInputRef.current?.click()}
          >
            <Upload className="w-4 h-4 mr-2" /> RESTORE
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickRestoreFile(f);
              e.target.value = "";
            }}
          />
        </div>
        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
          Backup downloads your trusted sources as a JSON file. Restore
          replaces the current allowlist with the contents of a backup file.
        </p>
      </div>

      <AlertDialog
        open={!!pendingRestore}
        onOpenChange={(open) => !open && setPendingRestore(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest">
              Restore trusted sources?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will replace your current{" "}
              <span className="mono">{trusted.length}</span> trusted source(s)
              with{" "}
              <span className="mono">{pendingRestore?.incoming ?? 0}</span> from
              the backup file. This cannot be undone — back up first if you
              want to keep your existing list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="mono tracking-widest">
              CANCEL
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmRestore}
              className="mono tracking-widest"
            >
              RESTORE
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="panel p-4">
        <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground mb-2">
          Handshake retry
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed mb-3">
          After a failed post-connect GATT handshake, retry once with a short
          backoff before tearing the link down. Disable if you'd rather fail
          fast on misclassified devices.
        </p>

        <div className="flex items-center justify-between mb-3">
          <Label htmlFor="hs-retry" className="mono text-xs">
            Enable retry
          </Label>
          <Switch
            id="hs-retry"
            checked={retryEnabled}
            onCheckedChange={(v) => {
              setRetryEnabled(v);
              configureHandshakeRetry({ enabled: v });
              toast.success(`Handshake retry ${v ? "enabled" : "disabled"}`);
            }}
          />
        </div>

        <Label htmlFor="hs-backoff" className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
          Backoff (ms)
        </Label>
        <div className="flex gap-2 mt-1">
          <Input
            id="hs-backoff"
            type="number"
            min={0}
            step={50}
            value={retryBackoff}
            onChange={(e) => setRetryBackoff(e.target.value)}
            disabled={!retryEnabled}
            className="mono text-xs"
          />
          <Button
            variant="outline"
            className="mono tracking-widest"
            disabled={!retryEnabled}
            onClick={() => {
              const n = Number(retryBackoff);
              if (!Number.isFinite(n) || n < 0) {
                toast.error("Backoff must be a non-negative number");
                setRetryBackoff(String(handshakeRetryConfig.backoffMs));
                return;
              }
              configureHandshakeRetry({ backoffMs: n });
              setRetryBackoff(String(handshakeRetryConfig.backoffMs));
              toast.success(`Backoff set to ${handshakeRetryConfig.backoffMs}ms`);
            }}
          >
            <Save className="w-4 h-4 mr-2" /> APPLY
          </Button>
        </div>
      </div>

      <div className="panel p-4">
        <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground mb-2">Diagnostic log</div>
        <div className="text-xs text-muted-foreground mb-3">{flashLog.length} lines buffered.</div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1 mono" onClick={exportLog}>
            <Upload className="w-4 h-4 mr-2" /> EXPORT
          </Button>
          <Button variant="ghost" className="flex-1 mono text-destructive" onClick={() => { clearLog(); toast.success("Log cleared"); }}>
            <Trash2 className="w-4 h-4 mr-2" /> CLEAR
          </Button>
        </div>
      </div>

      <div className="panel p-4 text-xs leading-relaxed text-muted-foreground">
        <div className="mono text-[10px] tracking-[0.22em] uppercase mb-2">About</div>
        <p className="mb-2">
          ScootFlash is a community tool for the Xiaomi M365 family. It is not affiliated with Xiaomi.
        </p>
        <p className="mb-2">
          Use at your own risk. Flashing scooter firmware can affect performance, battery health, road-legality and warranty.
        </p>
        <a href="https://github.com" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-primary-glow hover:underline mt-1">
          <Github className="w-3.5 h-3.5" /> Source & catalog repo
        </a>
      </div>
    </div>
  );
}
