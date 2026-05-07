import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// --- Mocks (hoisted) ---------------------------------------------------------
const discoverMock = vi.fn();
vi.mock("@/lib/gatt-discover", () => ({
  discoverServiceUuids: (...a: unknown[]) => discoverMock(...a),
}));

const scooterMock = {
  initialize: vi.fn().mockResolvedValue(undefined),
  scan: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  handshake: vi.fn().mockResolvedValue({ ok: false, reason: "stop-here-for-test" }),
  readInfo: vi.fn(),
  pollTelemetry: vi.fn(),
  writeSerialAndVerify: vi.fn(),
  readExtendedInfo: vi.fn(),
};
vi.mock("@/lib/m365/scooter-service", () => ({ scooter: scooterMock }));

vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor/haptics", () => ({
  Haptics: { impact: vi.fn().mockResolvedValue(undefined) },
  ImpactStyle: { Light: "LIGHT", Medium: "MEDIUM", Heavy: "HEAVY" },
}));
vi.mock("@/lib/paired-profiles", () => ({ upsertPairedProfile: vi.fn() }));

import { useScooter } from "@/hooks/use-scooter";
import { useScooterStore } from "@/store/scooter-store";

describe("useScooter.connect — GATT UUID merging", () => {
  beforeEach(() => {
    discoverMock.mockReset();
    useScooterStore.setState({
      state: "idle", devices: [], selected: null, info: null, telemetry: null,
      errorMessage: null, flashLog: [], flashing: false, pendingFlash: null,
      handshake: null, extendedInfo: null,
    });
  });

  it("merges advertised + GATT UUIDs (deduped, order preserved) onto selected device", async () => {
    discoverMock.mockResolvedValue([
      "0000fff0-0000-1000-8000-00805f9b34fb", // dup of advertised
      "0000fe95-0000-1000-8000-00805f9b34fb", // new
    ]);
    const device = {
      deviceId: "AA:BB",
      name: "Ninebot_Max",
      rssi: -50,
      serviceUuids: ["0000fff0-0000-1000-8000-00805f9b34fb"],
    };

    const { result } = renderHook(() => useScooter());
    await act(async () => { await result.current.connect(device); });

    const sel = useScooterStore.getState().selected!;
    expect(sel.serviceUuids).toEqual([
      "0000fff0-0000-1000-8000-00805f9b34fb",
      "0000fe95-0000-1000-8000-00805f9b34fb",
    ]);
    expect(sel.gattServiceUuids).toEqual([
      "0000fff0-0000-1000-8000-00805f9b34fb",
      "0000fe95-0000-1000-8000-00805f9b34fb",
    ]);
    expect(discoverMock).toHaveBeenCalledWith("AA:BB");
  });

  it("leaves selected device untouched when GATT discovery returns nothing", async () => {
    discoverMock.mockResolvedValue([]);
    const device = {
      deviceId: "CC:DD",
      name: "Xiaomi",
      rssi: -60,
      serviceUuids: ["0000fe95-0000-1000-8000-00805f9b34fb"],
    };

    const { result } = renderHook(() => useScooter());
    await act(async () => { await result.current.connect(device); });

    const sel = useScooterStore.getState().selected!;
    expect(sel.serviceUuids).toEqual(["0000fe95-0000-1000-8000-00805f9b34fb"]);
    expect(sel.gattServiceUuids).toBeUndefined();
  });

  it("treats missing advertised UUIDs as empty and uses GATT results alone", async () => {
    discoverMock.mockResolvedValue(["0000fff0-0000-1000-8000-00805f9b34fb"]);
    const device = { deviceId: "EE:FF", name: "(unnamed)", rssi: -70 };

    const { result } = renderHook(() => useScooter());
    await act(async () => { await result.current.connect(device); });

    const sel = useScooterStore.getState().selected!;
    expect(sel.serviceUuids).toEqual(["0000fff0-0000-1000-8000-00805f9b34fb"]);
    expect(sel.gattServiceUuids).toEqual(["0000fff0-0000-1000-8000-00805f9b34fb"]);
  });
});
