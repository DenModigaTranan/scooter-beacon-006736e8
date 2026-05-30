/**
 * Global scooter controls context.
 *
 * The floating control bar renders on every screen, but the active
 * write-capable session lives inside a route (e.g. NinebotScreen's
 * `useNinebotLiveTelemetry`). Rather than lift that session to app scope,
 * we expose a tiny registration channel: the screen that owns a live
 * session pushes a snapshot via `useRegisterScooterControls`, and the
 * floating bar reads from `useScooterControls` to render state and route
 * button presses to the active backend.
 *
 * When no screen registers a session (M365 / Generic BLE / disconnected),
 * the bar falls back to `available: false` and renders disabled buttons
 * with an explanatory tooltip.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ScooterControlCommand =
  | { kind: "lock" }
  | { kind: "unlock" }
  | { kind: "lights"; on: boolean }
  | { kind: "beep" };

export interface ScooterControlsSnapshot {
  /** True when sendCommand is safe to call. */
  available: boolean;
  /** Latest known lock state, when readable. */
  locked?: boolean;
  /** Latest known headlight state (locally tracked). */
  lightsOn?: boolean;
  /** Human label describing why controls are unavailable, when not. */
  unavailableReason?: string;
  /** Send a control command and resolve on ack. */
  sendCommand: (cmd: ScooterControlCommand) => Promise<void>;
}

const DEFAULT_SNAPSHOT: ScooterControlsSnapshot = {
  available: false,
  unavailableReason: "Connect a scooter to enable controls.",
  sendCommand: async () => {
    throw new Error("No active scooter session");
  },
};

interface ContextValue {
  snapshot: ScooterControlsSnapshot;
  /** Internal — used by useRegisterScooterControls. */
  _register: (snap: ScooterControlsSnapshot | null) => void;
}

const Ctx = createContext<ContextValue | null>(null);

export function ScooterControlsProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<ScooterControlsSnapshot | null>(null);
  const _register = useCallback((s: ScooterControlsSnapshot | null) => setSnap(s), []);
  const value = useMemo<ContextValue>(
    () => ({ snapshot: snap ?? DEFAULT_SNAPSHOT, _register }),
    [snap, _register],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScooterControls(): ScooterControlsSnapshot {
  const ctx = useContext(Ctx);
  return ctx ? ctx.snapshot : DEFAULT_SNAPSHOT;
}

/**
 * Register the current screen's session as the active controls backend.
 * Pass `null` (or omit) to indicate this screen has no controllable session.
 * Snapshot is shallow-compared by reference, so callers should memoise.
 */
export function useRegisterScooterControls(snap: ScooterControlsSnapshot | null): void {
  const ctx = useContext(Ctx);
  useEffect(() => {
    if (!ctx) return;
    ctx._register(snap);
    return () => ctx._register(null);
  }, [ctx, snap]);
}
