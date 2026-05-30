/**
 * FloatingControlBar — app-wide scooter control surface.
 *
 * Pinned above the tab bar on every screen. Renders lock/unlock, lights,
 * and horn buttons. The actual command transport is provided by whichever
 * screen currently owns an authenticated session (see controls-context).
 *
 * When no session is registered (M365 / Generic BLE / disconnected) the
 * buttons render disabled with a small tooltip explaining why, so the
 * affordance is still discoverable across the app.
 */

import { useCallback, useState } from "react";
import { Lock, LockOpen, Lightbulb, Volume2, Loader2, AlertTriangle, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScooterControls, type ScooterControlCommand } from "@/lib/controls-context";

type ButtonId = "lock" | "lights" | "beep";

type ButtonStatus = "idle" | "sending" | "ok" | "error";

export function FloatingControlBar({ bottomOffset = "4.5rem" }: { bottomOffset?: string }) {
  const { available, locked, lightsOn, unavailableReason, sendCommand } = useScooterControls();
  const [status, setStatus] = useState<Record<ButtonId, ButtonStatus>>({
    lock: "idle",
    lights: "idle",
    beep: "idle",
  });
  const [lastError, setLastError] = useState<string | null>(null);

  const run = useCallback(
    async (id: ButtonId, cmd: ScooterControlCommand) => {
      setStatus((s) => ({ ...s, [id]: "sending" }));
      setLastError(null);
      try {
        await sendCommand(cmd);
        setStatus((s) => ({ ...s, [id]: "ok" }));
        setTimeout(() => {
          setStatus((s) => (s[id] === "ok" ? { ...s, [id]: "idle" } : s));
        }, 1200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg);
        setStatus((s) => ({ ...s, [id]: "error" }));
        setTimeout(() => {
          setStatus((s) => (s[id] === "error" ? { ...s, [id]: "idle" } : s));
        }, 2000);
      }
    },
    [sendCommand],
  );

  const buttons = [
    {
      id: "lock" as const,
      label: locked ? "Unlock" : "Lock",
      Icon: locked ? LockOpen : Lock,
      cmd: (locked ? { kind: "unlock" } : { kind: "lock" }) as ScooterControlCommand,
      activeTone: "text-primary-glow border-primary-glow/50",
    },
    {
      id: "lights" as const,
      label: lightsOn ? "Lights off" : "Lights on",
      Icon: Lightbulb,
      cmd: { kind: "lights", on: !lightsOn } as ScooterControlCommand,
      activeTone: lightsOn ? "text-warning border-warning/60" : "text-foreground/80 border-border",
    },
    {
      id: "beep" as const,
      label: "Horn",
      Icon: Volume2,
      cmd: { kind: "beep" } as ScooterControlCommand,
      activeTone: "text-warning border-warning/40",
    },
  ];

  return (
    <div
      className="fixed inset-x-0 z-20 pointer-events-none flex justify-center px-3"
      style={{ bottom: `calc(${bottomOffset} + env(safe-area-inset-bottom, 0px))` }}
      aria-label="Scooter controls"
    >
      <div
        className={cn(
          "pointer-events-auto w-full max-w-md panel panel-glow px-2 py-2",
          "flex items-center gap-2 backdrop-blur-xl bg-background/85",
          !available && "opacity-80",
        )}
      >
        {buttons.map(({ id, label, Icon, cmd, activeTone }) => {
          const s = status[id];
          const sending = s === "sending";
          const ok = s === "ok";
          const errored = s === "error";
          return (
            <button
              key={id}
              type="button"
              onClick={() => available && run(id, cmd)}
              disabled={!available || sending}
              title={available ? label : unavailableReason}
              className={cn(
                "flex-1 rounded-md border bg-secondary/40 px-2 py-2",
                "flex flex-col items-center gap-0.5 mono text-[9px] tracking-[0.15em] uppercase",
                "transition-colors",
                "disabled:opacity-40 disabled:cursor-not-allowed",
                available && !ok && !errored && activeTone,
                available && !ok && !errored && "hover:bg-secondary/70",
                ok && "border-primary-glow bg-primary-glow/10 text-primary-glow",
                errored && "border-destructive bg-destructive/10 text-destructive",
              )}
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
              ) : ok ? (
                <Check className="w-4 h-4" aria-hidden />
              ) : errored ? (
                <AlertTriangle className="w-4 h-4" aria-hidden />
              ) : (
                <Icon className="w-4 h-4" aria-hidden />
              )}
              <span className="truncate max-w-full">{label}</span>
            </button>
          );
        })}
      </div>
      {lastError && available && (
        <div className="sr-only" role="status">
          {lastError}
        </div>
      )}
    </div>
  );
}
