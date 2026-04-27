/**
 * NinebotControlsPanel — write-side command surface for a connected,
 * authenticated Ninebot.
 *
 * Scope:
 *   The screen-level hook owns the session lifecycle and exposes a single
 *   `sendCommand(cmd)` callback. This panel is a pure presentational
 *   component on top of that callback: it renders one button per command
 *   the active model claims to support, drives per-button `idle → sending
 *   → ok / error` feedback, and gates the whole panel on the session
 *   being in the `polling` (i.e. authed-and-live) state.
 *
 * Why not just render every button always:
 *   the model registry already enumerates which commands each scooter
 *   actually exposes — e.g. unicycles have no lock register, the legacy
 *   M365 has no horn — so honouring the registry's `capabilities` here
 *   keeps the UI honest without per-model `if`s baked in. Unrecognised
 *   models (model === null) get the conservative full set, since hiding
 *   buttons we *might* support would be more confusing than letting the
 *   user try and see the device-rejected error.
 */

import { useCallback, useState } from "react";
import { Lock, LockOpen, Lightbulb, Volume2, Loader2, Check, AlertTriangle, Info, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NinebotModel, NinebotCapability } from "@/lib/ninebot-models";
import type { NinebotCommand } from "@/lib/ninebot/session";
import type { NinebotSessionStatus } from "@/lib/ninebot/session";

/**
 * One button definition. `command` is a thunk over `locked` because the
 * lock toggle's payload depends on the current device state — keeping
 * the resolution lazy means the button's onClick reads the freshest
 * `locked` value at fire-time, not at render-time, eliminating the race
 * between optimistic state and a user mashing the button mid-update.
 */
interface ControlSpec {
  id: string;
  /** Capability gate against the model registry. */
  capability: NinebotCapability;
  label: (state: { locked: boolean | undefined; lights: boolean }) => string;
  icon: (state: { locked: boolean | undefined; lights: boolean }) => LucideIcon;
  /** Tone of the button when idle. */
  tone: "primary" | "warning" | "muted";
  /** Build the command to dispatch from current local state. */
  command: (state: { locked: boolean | undefined; lights: boolean }) => NinebotCommand;
}

const CONTROLS: readonly ControlSpec[] = [
  {
    id: "lock-toggle",
    // We render a single toggle (not separate Lock + Unlock) so the
    // panel works the same way the user thinks about it — "is the
    // scooter locked right now?" — and the button's label/icon doubles
    // as the state indicator.
    capability: "write.lock",
    label: ({ locked }) => (locked ? "Unlock" : "Lock"),
    icon:  ({ locked }) => (locked ? LockOpen : Lock),
    tone:  "primary",
    command: ({ locked }) => (locked ? { kind: "unlock" } : { kind: "lock" }),
  },
  {
    id: "lights-toggle",
    capability: "write.lights",
    label: ({ lights }) => (lights ? "Lights off" : "Lights on"),
    icon:  () => Lightbulb,
    tone:  "muted",
    command: ({ lights }) => ({ kind: "lights", on: !lights }),
  },
  {
    id: "beep",
    capability: "write.beep",
    label: () => "Beep",
    icon:  () => Volume2,
    tone:  "warning",
    command: () => ({ kind: "beep" }),
  },
];

const TONE_CLASSES: Record<ControlSpec["tone"], string> = {
  primary: "border-primary-glow/40 hover:border-primary-glow text-primary-glow hover:bg-primary-glow/10",
  warning: "border-warning/40 hover:border-warning text-warning hover:bg-warning/10",
  muted:   "border-border hover:border-foreground/40 text-foreground/80 hover:bg-secondary/60",
};

interface ButtonState {
  /** `null` = idle. */
  status: "sending" | "ok" | "error" | null;
  message?: string;
  /** Auto-revert timer handle so we can clear feedback after a beat. */
  clearAt?: number;
}

export interface NinebotControlsPanelProps {
  status: NinebotSessionStatus;
  /** Resolved model from the registry, or null when unrecognised. */
  model: NinebotModel | null;
  /**
   * Latest decoded lock state from telemetry. `undefined` means we
   * haven't seen a register read yet — the panel still renders the
   * lock button but assumes "unlocked" (the safer default for a
   * scooter just brought online).
   */
  locked: boolean | undefined;
  /** Sends a command via the active session. Resolves on ack. */
  onSend: (cmd: NinebotCommand) => Promise<void>;
}

export function NinebotControlsPanel({
  status,
  model,
  locked,
  onSend,
}: NinebotControlsPanelProps) {
  // Lights have no read-side register in the protocol module, so we keep
  // a local "what we believe the bulb is doing" flag. Optimistic updates
  // flip it as soon as we send, and the panel never reads back from the
  // device for lights state. This means lights can drift from physical
  // truth across page reloads — acceptable, and called out in the panel
  // hint text below so it isn't a surprise.
  const [lights, setLights] = useState(false);
  const [buttonState, setButtonState] = useState<Record<string, ButtonState>>({});

  const setButton = useCallback((id: string, next: ButtonState) => {
    setButtonState((prev) => ({ ...prev, [id]: next }));
  }, []);

  const isReady = status === "polling";

  const handleSend = useCallback(
    async (spec: ControlSpec) => {
      if (!isReady) return;
      // Snapshot state at fire-time so the optimistic flip and the bytes
      // we send agree, even if a poll round-trip flips `locked` between
      // the click and our async resolution.
      const snapshot = { locked, lights };
      const cmd = spec.command(snapshot);
      setButton(spec.id, { status: "sending" });
      // Optimistic local-only update for lights — the protocol layer
      // doesn't echo lights back, so the device's view of truth never
      // re-asserts itself. For lock, the session's optimistic update +
      // the next poll cycle will reconcile naturally.
      if (cmd.kind === "lights") setLights(cmd.on);
      try {
        await onSend(cmd);
        setButton(spec.id, { status: "ok", clearAt: Date.now() + 1200 });
        // Auto-revert the badge to idle after a beat so the panel doesn't
        // accumulate stale "ok" markers across many clicks.
        setTimeout(() => {
          setButtonState((prev) => {
            // Defensive: only clear if we're still showing the same OK
            // we set above (a faster subsequent click might have moved
            // us into "sending" again).
            if (prev[spec.id]?.status !== "ok") return prev;
            const { [spec.id]: _gone, ...rest } = prev;
            void _gone;
            return rest;
          });
        }, 1200);
      } catch (err) {
        // Roll back optimistic lights update on failure so the button
        // label matches what the device actually saw.
        if (cmd.kind === "lights") setLights(!cmd.on);
        const message = err instanceof Error ? err.message : String(err);
        setButton(spec.id, { status: "error", message });
      }
    },
    [isReady, locked, lights, onSend, setButton],
  );

  // Filter the catalog by the active model's capability set. Unknown
  // models pass everything through — see the file header for why.
  const visibleControls = CONTROLS.filter((c) => {
    if (!model) return true;
    return model.capabilities.includes(c.capability);
  });

  const hideEntirely = visibleControls.length === 0;
  if (hideEntirely) return null;

  return (
    <section
      aria-label="Ninebot controls"
      className="panel p-3 space-y-2"
    >
      <div className="flex items-center justify-between">
        <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
          Controls
        </div>
        <div
          className={cn(
            "inline-flex items-center gap-1 mono text-[9px] tracking-widest uppercase",
            isReady ? "text-primary-glow" : "text-muted-foreground",
          )}
          title={
            isReady
              ? "Session authenticated — commands enabled."
              : "Connect and complete the auth handshake to enable commands."
          }
        >
          <Info className="w-3 h-3" aria-hidden />
          {isReady ? "Live" : "Locked"}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {visibleControls.map((spec) => {
          const state = buttonState[spec.id];
          const Icon = spec.icon({ locked, lights });
          const label = spec.label({ locked, lights });
          const sending = state?.status === "sending";
          const ok = state?.status === "ok";
          const errored = state?.status === "error";
          return (
            <button
              key={spec.id}
              type="button"
              onClick={() => handleSend(spec)}
              disabled={!isReady || sending}
              title={errored ? state?.message : label}
              className={cn(
                "rounded-md border bg-secondary/40 px-2 py-2.5",
                "flex flex-col items-center gap-1 mono text-[10px] tracking-wider uppercase",
                "transition-colors",
                "disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-secondary/40",
                TONE_CLASSES[spec.tone],
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

      {/* Surface the most recent error inline as well so the user doesn't
          have to mouse-over the button to see it. We pick whichever button
          is currently showing an error (at most one in the common case,
          since users rarely fan-fire commands). */}
      {Object.entries(buttonState)
        .filter(([, s]) => s.status === "error")
        .slice(0, 1)
        .map(([id, s]) => (
          <div key={id} className="mono text-[10px] text-destructive/80 pt-1 border-t border-destructive/20">
            {s.message}
          </div>
        ))}

      {/* Caveat for the lights button — the protocol doesn't read the
          headlight register back, so our local idea of on/off is the
          best we can do. Hidden when the lights button isn't even
          visible to avoid confusing copy. */}
      {visibleControls.some((c) => c.id === "lights-toggle") && (
        <p className="mono text-[9px] text-muted-foreground/70 leading-relaxed pt-1">
          Lights state is tracked locally — it resets on reload and may drift from the device.
        </p>
      )}
    </section>
  );
}
