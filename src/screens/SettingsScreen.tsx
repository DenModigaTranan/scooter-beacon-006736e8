import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useScooter } from "@/hooks/use-scooter";
import { getCatalogUrl, setCatalogUrl } from "@/lib/m365/catalog";
import { Share } from "@capacitor/share";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import { Github, LogOut, Trash2, Upload } from "lucide-react";

export function SettingsScreen() {
  const { disconnect, selected, flashLog, clearLog } = useScooter();
  const [url, setUrl] = useState(getCatalogUrl());

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
