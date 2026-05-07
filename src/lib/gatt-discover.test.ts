import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so the module-under-test picks them up on import.
const getServicesMock = vi.fn();
const isNativePlatformMock = vi.fn();

vi.mock("@capacitor-community/bluetooth-le", () => ({
  BleClient: { getServices: (...a: unknown[]) => getServicesMock(...a) },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativePlatformMock() },
}));

import { discoverServiceUuids } from "@/lib/gatt-discover";

describe("discoverServiceUuids", () => {
  beforeEach(() => {
    getServicesMock.mockReset();
    isNativePlatformMock.mockReset();
  });

  it("returns [] on web (non-native) without calling BleClient", async () => {
    isNativePlatformMock.mockReturnValue(false);
    const out = await discoverServiceUuids("AA:BB");
    expect(out).toEqual([]);
    expect(getServicesMock).not.toHaveBeenCalled();
  });

  it("returns lowercased unique UUIDs from BleClient.getServices", async () => {
    isNativePlatformMock.mockReturnValue(true);
    getServicesMock.mockResolvedValue([
      { uuid: "0000FFF0-0000-1000-8000-00805F9B34FB" },
      { uuid: "0000FE95-0000-1000-8000-00805F9B34FB" },
      { uuid: "0000fff0-0000-1000-8000-00805f9b34fb" }, // dup of first
    ]);
    const out = await discoverServiceUuids("AA:BB");
    expect(out).toEqual([
      "0000fff0-0000-1000-8000-00805f9b34fb",
      "0000fe95-0000-1000-8000-00805f9b34fb",
    ]);
    expect(getServicesMock).toHaveBeenCalledWith("AA:BB");
  });

  it("skips entries without a uuid field", async () => {
    isNativePlatformMock.mockReturnValue(true);
    getServicesMock.mockResolvedValue([{ uuid: "" }, {}, { uuid: "0000ABCD-0000-1000-8000-00805F9B34FB" }]);
    const out = await discoverServiceUuids("X");
    expect(out).toEqual(["0000abcd-0000-1000-8000-00805f9b34fb"]);
  });

  it("returns [] when BleClient.getServices throws (best-effort)", async () => {
    isNativePlatformMock.mockReturnValue(true);
    getServicesMock.mockRejectedValue(new Error("not connected"));
    await expect(discoverServiceUuids("X")).resolves.toEqual([]);
  });

  it("returns [] for empty service list", async () => {
    isNativePlatformMock.mockReturnValue(true);
    getServicesMock.mockResolvedValue([]);
    await expect(discoverServiceUuids("X")).resolves.toEqual([]);
  });
});
