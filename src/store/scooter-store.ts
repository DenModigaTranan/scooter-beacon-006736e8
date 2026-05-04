import { create } from "zustand";
import type { DiscoveredDevice, ScooterInfo, Telemetry, HandshakeResult, ExtendedDeviceInfo } from "@/lib/m365/scooter-service";
import type { FirmwareEntry } from "@/lib/m365/catalog";

export type ConnectionState = "idle" | "scanning" | "connecting" | "connected" | "disconnected" | "error";

interface ScooterStore {
  state: ConnectionState;
  devices: DiscoveredDevice[];
  selected: DiscoveredDevice | null;
  info: ScooterInfo | null;
  telemetry: Telemetry | null;
  errorMessage: string | null;
  flashLog: string[];
  /** True while a firmware write is actively in progress. */
  flashing: boolean;
  /** A firmware entry queued from the Catalog screen for the Flash flow to pick up. */
  pendingFlash: FirmwareEntry | null;
  /** Latest BLE GATT handshake result, or null if not yet validated. */
  handshake: HandshakeResult | null;
  /** Extended identifiers — null until the user reads them on Info screen. */
  extendedInfo: ExtendedDeviceInfo | null;

  setState: (s: ConnectionState) => void;
  addDevice: (d: DiscoveredDevice) => void;
  clearDevices: () => void;
  setSelected: (d: DiscoveredDevice | null) => void;
  setInfo: (i: ScooterInfo | null) => void;
  setTelemetry: (t: Telemetry | null) => void;
  setError: (msg: string | null) => void;
  appendLog: (line: string) => void;
  clearLog: () => void;
  setPendingFlash: (fw: FirmwareEntry | null) => void;
  setHandshake: (h: HandshakeResult | null) => void;
  setExtendedInfo: (e: ExtendedDeviceInfo | null) => void;
  setFlashing: (v: boolean) => void;
}

export const useScooterStore = create<ScooterStore>((set) => ({
  state: "idle",
  devices: [],
  selected: null,
  info: null,
  telemetry: null,
  errorMessage: null,
  flashLog: [],
  flashing: false,
  pendingFlash: null,
  handshake: null,
  extendedInfo: null,

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
  setPendingFlash: (fw) => set({ pendingFlash: fw }),
  setHandshake: (h) => set({ handshake: h }),
  setExtendedInfo: (e) => set({ extendedInfo: e }),
  setFlashing: (v) => set({ flashing: v }),
}));
