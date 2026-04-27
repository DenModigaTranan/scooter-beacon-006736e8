import { create } from "zustand";
import type { DiscoveredDevice, ScooterInfo, Telemetry } from "@/lib/m365/scooter-service";

export type ConnectionState = "idle" | "scanning" | "connecting" | "connected" | "disconnected" | "error";

interface ScooterStore {
  state: ConnectionState;
  devices: DiscoveredDevice[];
  selected: DiscoveredDevice | null;
  info: ScooterInfo | null;
  telemetry: Telemetry | null;
  errorMessage: string | null;
  flashLog: string[];

  setState: (s: ConnectionState) => void;
  addDevice: (d: DiscoveredDevice) => void;
  clearDevices: () => void;
  setSelected: (d: DiscoveredDevice | null) => void;
  setInfo: (i: ScooterInfo | null) => void;
  setTelemetry: (t: Telemetry | null) => void;
  setError: (msg: string | null) => void;
  appendLog: (line: string) => void;
  clearLog: () => void;
}

export const useScooterStore = create<ScooterStore>((set) => ({
  state: "idle",
  devices: [],
  selected: null,
  info: null,
  telemetry: null,
  errorMessage: null,
  flashLog: [],

  setState: (s) => set({ state: s }),
  addDevice: (d) =>
    set((prev) => (prev.devices.some((x) => x.deviceId === d.deviceId) ? prev : { devices: [...prev.devices, d] })),
  clearDevices: () => set({ devices: [] }),
  setSelected: (d) => set({ selected: d }),
  setInfo: (i) => set({ info: i }),
  setTelemetry: (t) => set({ telemetry: t }),
  setError: (msg) => set({ errorMessage: msg, state: msg ? "error" : "idle" }),
  appendLog: (line) => set((p) => ({ flashLog: [...p.flashLog.slice(-500), line] })),
  clearLog: () => set({ flashLog: [] }),
}));
