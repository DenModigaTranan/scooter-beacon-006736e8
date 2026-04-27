/**
 * Paired-scooters list shown above the live scan results on ConnectScreen.
 *
 * Each row represents a device the user has previously connected to. Tapping
 * a row triggers an immediate reconnect using the same BLE deviceId — no
 * scan required. Rows expose:
 *   • alias (editable)   • last serial / firmware versions
 *   • last flash outcome (success / aborted / error)
 *   • "Forget" to remove the saved profile.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import {
  Bluetooth, Loader2, MoreVertical, Pencil, Trash2, Zap,
  AlertTriangle, CheckCircle2, ShieldX, Link2Off, Wifi,
} from "lucide-react";
import {
  displayName,
  forgetPairedProfile,
  updatePairedProfile,
  usePairedProfiles,
  type PairedProfile,
} from "@/lib/paired-profiles";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface Props {
  /** Reconnect to this device. Wired to `useScooter().connect`. */
  onReconnect: (deviceId: string, name: string) => void;
  /** "connecting" | "scanning" | "idle" | etc — disables rows during transitions. */
  busy: boolean;
  /** When set, the deviceId currently being reconnected to (shows spinner). */
  connectingId?: string | null;
  /**
   * Live BLE state from the scooter store. Used together with `activeDeviceId`
   * to render a per-row status pill so the user can see exactly which paired
   * device is connecting / connected / failed while a reconnect is in flight.
   */
  state?:
    | "idle"
    | "scanning"
    | "connecting"
    | "connected"
    | "disconnected"
    | "error";
  /** deviceId currently selected/connected by the scooter store. */
  activeDeviceId?: string | null;
  /** True once the connected device passed the M365 GATT handshake. */
  handshakeOk?: boolean;
  /**
   * Last reason the handshake failed (or any other connect-time error).
   * Surfaced as a small destructive sub-line on the active row.
   */
  errorMessage?: string | null;
}

/** Per-row connection status, derived from the global scooter state. */
type RowStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "handshake-failed"
  | "disconnected"
  | "error";

function deriveRowStatus(
  rowDeviceId: string,
  props: Pick<Props, "state" | "activeDeviceId" | "connectingId" | "handshakeOk" | "errorMessage">,
): RowStatus {
  if (props.connectingId === rowDeviceId || (props.state === "connecting" && props.activeDeviceId === rowDeviceId)) {
    return "connecting";
  }
  if (props.activeDeviceId !== rowDeviceId) return "idle";
  // From here on the row IS the active device.
  if (props.state === "connected") {
    // A connected-but-no-handshake state typically means the handshake just
    // failed (use-scooter sets an error message in that case).
    if (props.handshakeOk === false && props.errorMessage) return "handshake-failed";
    return "connected";
  }
  if (props.state === "disconnected") return "disconnected";
  if (props.state === "error") return "error";
  return "idle";
}

const STATUS_META: Record<RowStatus, { label: string; className: string; Icon: typeof Wifi }> = {
  idle:               { label: "saved",            className: "text-muted-foreground/70 border-border/40",      Icon: Bluetooth },
  connecting:         { label: "connecting…",      className: "text-primary-glow border-primary-glow/40",       Icon: Loader2 },
  connected:          { label: "connected",        className: "text-primary-glow border-primary-glow/50 bg-primary/5", Icon: Wifi },
  "handshake-failed": { label: "handshake failed", className: "text-destructive border-destructive/40 bg-destructive/5", Icon: ShieldX },
  disconnected:       { label: "disconnected",     className: "text-warning border-warning/40 bg-warning/5",    Icon: Link2Off },
  error:              { label: "error",            className: "text-destructive border-destructive/40 bg-destructive/5", Icon: AlertTriangle },
};

export function PairedScooters({
  onReconnect, busy, connectingId,
  state, activeDeviceId, handshakeOk, errorMessage,
}: Props) {
  const profiles = usePairedProfiles();
  const [renaming, setRenaming] = useState<PairedProfile | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [forgetting, setForgetting] = useState<PairedProfile | null>(null);

  if (profiles.length === 0) return null;

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="mono text-[11px] tracking-[0.22em] uppercase text-muted-foreground">
          Paired ({profiles.length})
        </div>
        <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
          Tap to reconnect
        </div>
      </div>

      <ul className="space-y-2.5">
        {profiles.map((p) => {
          const status = deriveRowStatus(p.deviceId, {
            state, activeDeviceId, connectingId, handshakeOk, errorMessage,
          });
          const meta = STATUS_META[status];
          const StatusIcon = meta.Icon;
          const isConnecting = status === "connecting";
          const isActiveRow = status !== "idle";
          // Only the active row is "live"; other rows stay tappable so the
          // user can switch targets, but we disable while busy to avoid
          // racing two connects.
          const rowDisabled = busy && !isConnecting;
          const lastFlash = p.lastFlash;
          const flashUnsafe = lastFlash?.result === "aborted-unsafe";
          const flashOk = lastFlash?.result === "success";
          return (
            <motion.li
              key={p.deviceId}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className={cn(
                "panel hover:panel-glow transition-all overflow-hidden",
                flashUnsafe && "border-destructive/40",
                status === "connected" && "border-primary-glow/50 shadow-mint/20",
                status === "handshake-failed" && "border-destructive/50",
                status === "disconnected" && "border-warning/40",
                status === "error" && "border-destructive/50",
              )}
              aria-live={isActiveRow ? "polite" : undefined}
            >
              <div className="flex items-stretch">
                <button
                  onClick={() => onReconnect(p.deviceId, p.advertisedName)}
                  disabled={rowDisabled}
                  className="flex-1 flex items-center gap-3 p-3.5 text-left disabled:opacity-60"
                >
                  <div className={cn(
                    "w-10 h-10 rounded-md flex items-center justify-center shrink-0 relative transition-colors",
                    status === "connected" && "bg-primary/15",
                    status === "handshake-failed" && "bg-destructive/10",
                    status === "disconnected" && "bg-warning/10",
                    status === "error" && "bg-destructive/10",
                    (status === "idle" || status === "connecting") && "bg-secondary",
                  )}>
                    {isConnecting ? (
                      <Loader2 className="w-5 h-5 text-primary-glow animate-spin" />
                    ) : status === "connected" ? (
                      <Wifi className="w-5 h-5 text-primary-glow" />
                    ) : status === "handshake-failed" ? (
                      <ShieldX className="w-5 h-5 text-destructive" />
                    ) : status === "disconnected" ? (
                      <Link2Off className="w-5 h-5 text-warning" />
                    ) : status === "error" ? (
                      <AlertTriangle className="w-5 h-5 text-destructive" />
                    ) : (
                      <Bluetooth className="w-5 h-5 text-primary-glow" />
                    )}
                    {/* Live "pulse" dot for the connected row */}
                    {status === "connected" && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary-glow shadow-[0_0_6px_hsl(var(--primary-glow))] animate-pulse" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="mono text-sm truncate">{displayName(p)}</span>
                      {/* Per-row live status pill — the heart of this feature. */}
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border mono text-[9px] uppercase tracking-widest leading-none shrink-0",
                          meta.className,
                        )}
                        role="status"
                        aria-label={`Connection status: ${meta.label}`}
                      >
                        <StatusIcon className={cn(
                          "w-2.5 h-2.5",
                          status === "connecting" && "animate-spin",
                        )} />
                        {meta.label}
                      </span>
                      {flashUnsafe && (
                        <span title="Last flash interrupted mid-write — reflash recommended">
                          <AlertTriangle className="w-3.5 h-3.5 text-destructive shrink-0" />
                        </span>
                      )}
                      {flashOk && status !== "handshake-failed" && (
                        <span title="Last flash succeeded">
                          <CheckCircle2 className="w-3.5 h-3.5 text-primary-glow shrink-0" />
                        </span>
                      )}
                    </div>
                    <div className="mono text-[10px] text-muted-foreground tracking-widest truncate">
                      {p.deviceId.slice(0, 17).toUpperCase()}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] mono text-muted-foreground">
                      {p.lastInfo?.serial && <span>SN {p.lastInfo.serial}</span>}
                      {p.lastInfo?.drvVersion && <span>DRV {p.lastInfo.drvVersion}</span>}
                      {p.lastInfo?.bmsVersion && <span>BMS {p.lastInfo.bmsVersion}</span>}
                      {p.lastInfo?.bleVersion && <span>BLE {p.lastInfo.bleVersion}</span>}
                    </div>
                    {/* Inline failure reason — only for the active row, only when relevant */}
                    {isActiveRow && (status === "handshake-failed" || status === "error") && errorMessage && (
                      <div className="mt-1 text-[10px] mono text-destructive/90 leading-snug break-words">
                        ! {errorMessage}
                      </div>
                    )}
                    <div className="mt-1 flex items-center gap-2 text-[10px] mono text-muted-foreground/80">
                      <span>seen {timeAgo(p.lastConnectedAt)}</span>
                      <span>·</span>
                      <span>{p.connectCount}× connect</span>
                      {lastFlash && (
                        <>
                          <span>·</span>
                          <Zap className="w-2.5 h-2.5 inline" />
                          <span className={cn(
                            flashOk && "text-primary-glow",
                            flashUnsafe && "text-destructive",
                          )}>
                            {lastFlash.target} {lastFlash.label}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label="Manage paired scooter"
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

      {/* Rename dialog */}
      <AlertDialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest">Rename scooter</AlertDialogTitle>
            <AlertDialogDescription>
              Give this scooter a nickname so it's easy to find next time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={renaming?.advertisedName ?? "My scooter"}
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

      {/* Forget confirmation */}
      <AlertDialog open={!!forgetting} onOpenChange={(o) => !o && setForgetting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="mono tracking-widest">Forget this scooter?</AlertDialogTitle>
            <AlertDialogDescription>
              {forgetting && (
                <>
                  Removes saved info for <span className="mono">{displayName(forgetting)}</span>.
                  You'll need to scan and pair again next time. The scooter itself is unaffected.
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
