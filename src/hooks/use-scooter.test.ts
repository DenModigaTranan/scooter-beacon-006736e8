import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// --- Mocks (hoisted) ---------------------------------------------------------
const { discoverMock, scooterMock } = vi.hoisted(() => ({
  discoverMock: vi.fn(),
  scooterMock: {
    initialize: vi.fn().mockResolvedValue(undefined),
    scan: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    handshake: vi.fn().mockResolvedValue({ ok: false, reason: "stop-here-for-test" }),
    readInfo: vi.fn(),
    pollTelemetry: vi.fn(),
    writeSerialAndVerify: vi.fn(),
    readExtendedInfo: vi.fn(),
  },
}));
vi.mock("@/lib/gatt-discover", () => ({
  discoverServiceUuids: (...a: unknown[]) => discoverMock(...a),
}));
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
    // Default to a successful handshake so the GATT-merge tests below
    // exercise the happy path; the failure-path tests override per-call.
    scooterMock.handshake.mockReset();
    scooterMock.handshake.mockResolvedValue({ ok: true, variant: "strict" });
    scooterMock.readInfo.mockReset();
    scooterMock.readInfo.mockResolvedValue(null);
    scooterMock.disconnect.mockReset();
    scooterMock.disconnect.mockResolvedValue(undefined);
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

  it("recovers from a handshake failure: disconnects, clears selected, surfaces a misclassification hint", async () => {
    discoverMock.mockResolvedValue([]);
    scooterMock.handshake.mockReset();
    scooterMock.handshake
      .mockResolvedValueOnce({ ok: false, reason: "no M365 service found" })
      .mockResolvedValueOnce({ ok: false, reason: "no M365 service found" });
    scooterMock.disconnect.mockClear();
    const device = {
      deviceId: "11:22",
      name: "Ninebot_Lookalike",
      rssi: -55,
      serviceUuids: ["0000fff0-0000-1000-8000-00805f9b34fb"],
    };

    const { result } = renderHook(() => useScooter());
    await act(async () => { await result.current.connect(device); });

    const s = useScooterStore.getState();
    expect(scooterMock.disconnect).toHaveBeenCalled();
    expect(s.selected).toBeNull();
    expect(s.info).toBeNull();
    expect(s.telemetry).toBeNull();
    expect(s.extendedInfo).toBeNull();
    expect(s.handshake).toEqual({ ok: false, reason: "no M365 service found" });
    expect(s.errorMessage).toMatch(/Handshake failed/);
    expect(s.errorMessage).toMatch(/misclassified/i);
    expect(s.state).toBe("error");
  });

  it("survives a disconnect throw during handshake-failure cleanup without losing the error", async () => {
    discoverMock.mockResolvedValue([]);
    scooterMock.handshake.mockReset();
    scooterMock.handshake
      .mockResolvedValueOnce({ ok: false, reason: "ESC probe rejected" })
      .mockResolvedValueOnce({ ok: false, reason: "ESC probe rejected" });
    scooterMock.disconnect.mockRejectedValueOnce(new Error("link already closed"));
    const device = { deviceId: "33:44", name: "M365_Clone", rssi: -60 };

    const { result } = renderHook(() => useScooter());
    await act(async () => { await result.current.connect(device); });

    const s = useScooterStore.getState();
    expect(s.errorMessage).toMatch(/ESC probe rejected/);
    expect(s.selected).toBeNull();
  });

  it("retries handshake once after a transient failure and proceeds on success", async () => {
    discoverMock.mockResolvedValue([]);
    scooterMock.handshake.mockReset();
    scooterMock.handshake
      .mockResolvedValueOnce({ ok: false, reason: "transient ESC timeout" })
      .mockResolvedValueOnce({ ok: true, variant: "strict" });
    scooterMock.readInfo.mockResolvedValueOnce({ serial: "X" });
    scooterMock.disconnect.mockClear();
    const device = { deviceId: "55:66", name: "Ninebot_Max", rssi: -50 };

    const { result } = renderHook(() => useScooter());
    await act(async () => { await result.current.connect(device); });

    const s = useScooterStore.getState();
    expect(scooterMock.handshake).toHaveBeenCalledTimes(2);
    expect(scooterMock.disconnect).not.toHaveBeenCalled();
    expect(s.handshake).toEqual({ ok: true, variant: "strict" });
    expect(s.selected?.deviceId).toBe("55:66");
    expect(s.errorMessage).toBeNull();
  });

  it("falls back to disconnect-and-clear if both handshake attempts fail", async () => {
    discoverMock.mockResolvedValue([]);
    scooterMock.handshake.mockReset();
    scooterMock.handshake
      .mockResolvedValueOnce({ ok: false, reason: "ESC probe rejected" })
      .mockResolvedValueOnce({ ok: false, reason: "ESC probe rejected" });
    scooterMock.disconnect.mockClear();
    const device = { deviceId: "77:88", name: "M365_Clone", rssi: -60 };

    const { result } = renderHook(() => useScooter());
    await act(async () => { await result.current.connect(device); });

    const s = useScooterStore.getState();
    expect(scooterMock.handshake).toHaveBeenCalledTimes(2);
    expect(scooterMock.disconnect).toHaveBeenCalled();
    expect(s.selected).toBeNull();
    expect(s.state).toBe("error");
    expect(s.errorMessage).toMatch(/Handshake failed/);
  });
});
