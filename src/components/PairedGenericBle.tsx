/**
 * Paired-devices panel for the Generic BLE screen.
 *
 * Mirrors `PairedScooters` (the M365 panel) in spirit but is scoped to
 * `kind === "generic-ble"` profiles and exposes a far simpler row — there's
 * no protocol info to show, just a name, last-seen timestamp, advertised
 * service UUIDs at last connect, and an optional pinned model badge.
 *
 * Tapping a row triggers a one-tap reconnect via the supplied callback;
 * the parent decides whether to also stop any in-flight scan, etc.
 *
 * Auto-reconnect:
 *   The "Auto" toggle in the header is persisted to localStorage. When on
 *   AND there is at least one paired generic device, the parent screen will
 *   attempt to reconnect to the most-recently-connected entry on mount.
 *   The toggle is intentionally OFF by default — auto-reconnect on every
 *   mount can be surprising in a debugging tool, so we make it opt-in.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Bluetooth, Loader2, MoreVertical, Pencil, Trash2, Wifi, Link2Off,
  AlertTriangle, Zap,
} from "lucide-react";
import {
  displayName, forgetPairedProfile, updatePairedProfile, usePairedProfiles,
  type PairedProfile,
} from "@/lib/paired-profiles";
import { getNinebotModelById } from "@/lib/ninebot-models";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const AUTO_RECONNECT_KEY = "ble.autoReconnectGeneric";

/** Read/write the persisted auto-reconnect toggle. Module-scoped so the
 *  parent can read it synchronously to decide whether to fire a reconnect
 *  on mount, without waiting for this component to render. */
export function getGenericAutoReconnect(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AUTO_RECONNECT_KEY) === "1";
}
export function setGenericAutoReconnect(on: boolean): void {
  if (typeof window === "undefined") return;
  if (on) window.localStorage.setItem(AUTO_RECONNECT_KEY, "1");
  else window.localStorage.removeItem(AUTO_RECONNECT_KEY);
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function shortUuid(u: string): string {
  const m = u.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i);
  return m ? `0x${m[1].toUpperCase()}` : u.slice(0, 8).toUpperCase();
}

export interface PairedGenericBleProps {
  /** Reconnect to a paired device. The parent should map this to a
   *  synthetic GenericDevice and run its connect orchestrator. */
  onReconnect: (profile: PairedProfile) => void;
  /** Disable rows while a connect is already in flight. */
  busy: boolean;
  /** When set, the deviceId currently being reconnected to (shows spinner). */
  connectingId?: string | null;
  /** Currently connected deviceId, if any — drives the row "live" pill. */
  connectedId?: string | null;
}

type RowStatus = "idle" | "connecting" | "connected";

export function PairedGenericBle({
  onReconnect, busy, connectingId, connectedId,
}: PairedGenericBleProps) {
  const profiles = usePairedProfiles("generic-ble");
  const [renaming, setRenaming] = useState<PairedProfile | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [forgetting, setForgetting] = useState<PairedProfile | null>(null);
  const [autoOn, setAutoOn] = useState<boolean>(() => getGenericAutoReconnect());

  // Mirror the toggle into localStorage. Cheap; the value is read at most
  // once per parent mount so we don't need a custom event broadcast.
  useEffect(() => { setGenericAutoReconnect(autoOn); }, [autoOn]);

  if (profiles.length === 0) return null;

  return (
    <section className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[11px] tracking-[0.22em] uppercase text-muted-foreground">
          Paired ({profiles.length})
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="auto-reconnect-generic" className="mono text-[10px] uppercase tracking-widest text-muted-foreground/80 cursor-pointer">
            Auto
          </Label>
          <Switch
            id="auto-reconnect-generic"
            checked={autoOn}
            onCheckedChange={setAutoOn}
            aria-label="Auto-reconnect on screen open"
          />
        </div>
      </div>

      <ul className="space-y-2">
        {profiles.map((p) => {
          const status: RowStatus =
            connectingId === p.deviceId ? "connecting" :
            connectedId === p.deviceId ? "connected" : "idle";
          const rowDisabled = busy && status !== "connecting";
          const model = p.pinnedModelId ? getNinebotModelById(p.pinnedModelId) : null;
          const StatusIcon =
            status === "connecting" ? Loader2 :
            status === "connected"  ? Wifi :
            Bluetooth;
          return (
            <motion.li
              key={p.deviceId}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "panel hover:panel-glow transition-all overflow-hidden",
                status === "connected" && "border-primary-glow/50",
              )}
            >
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => onReconnect(p)}
                  disabled={rowDisabled || status === "connected"}
                  className="flex-1 flex items-center gap-3 p-3 text-left disabled:opacity-60"
                >
                  <div className={cn(
                    "w-9 h-9 rounded-md flex items-center justify-center shrink-0 relative",
                    status === "connected" && "bg-primary/15",
                    status !== "connected" && "bg-secondary",
                  )}>
                    <StatusIcon className={cn(
                      "w-4 h-4",
                      status === "connected" && "text-primary-glow",
                      status === "connecting" && "text-primary-glow animate-spin",
                      status === "idle" && "text-primary-glow",
                    )} />
                    {status === "connected" && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary-glow shadow-[0_0_6px_hsl(var(--primary-glow))] animate-pulse" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="mono text-sm truncate">{displayName(p)}</span>
                      {model && (
                        <span className="chip chip-muted text-[9px] uppercase tracking-widest leading-none px-1.5 py-0.5">
                          {model.displayName}
                        </span>
                      )}
                      {status === "connecting" && (
                        <span className="mono text-[9px] uppercase tracking-widest text-primary-glow">connecting…</span>
                      )}
                      {status === "connected" && (
                        <span className="mono text-[9px] uppercase tracking-widest text-primary-glow">live</span>
                      )}
                    </div>
                    <div className="mono text-[10px] text-muted-foreground tracking-widest truncate">
                      {p.deviceId.slice(0, 17).toUpperCase()}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] mono text-muted-foreground/80">
                      <span>seen {timeAgo(p.lastConnectedAt)}</span>
                      <span>·</span>
                      <span>{p.connectCount}× connect</span>
                      {p.serviceUuids && p.serviceUuids.length > 0 && (
                        <>
                          <span>·</span>
                          <span className="truncate">
                            {p.serviceUuids.slice(0, 3).map(shortUuid).join(" ")}
                            {p.serviceUuids.length > 3 ? ` +${p.serviceUuids.length - 3}` : ""}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Manage paired device"
                      className="px-2.5 text-muted-foreground hover:text-foreground border-l border-border/40"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      onSelect={() => {
                        setRenameValue(p.alias ?? "");
                        setRenaming(p);
                      }}
                    >
                      <Pencil className="w-3.5 h-3.5 mr-2" /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => setForgetting(p)}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-2" /> Forget
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </motion.li>
          );
        })}
      </ul>

      {/* Rename */}
      <AlertDialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest">Rename device</AlertDialogTitle>
            <AlertDialogDescription>
              Give this device a nickname so it's easy to spot next time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={renaming?.advertisedName ?? "My device"}
            maxLength={40}
            autoFocus
            className="mono"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (renaming) {
                  updatePairedProfile(renaming.deviceId, {
                    alias: renameValue.trim() || undefined,
                  });
                }
                setRenaming(null);
              }}
            >
              Save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Forget */}
      <AlertDialog open={!!forgetting} onOpenChange={(o) => !o && setForgetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest">Forget this device?</AlertDialogTitle>
            <AlertDialogDescription>
              {forgetting && (
                <>
                  Removes saved info for <span className="mono">{displayName(forgetting)}</span>.
                  You'll need to scan again to reconnect. The device itself is unaffected.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (forgetting) forgetPairedProfile(forgetting.deviceId);
                setForgetting(null);
              }}
            >
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
