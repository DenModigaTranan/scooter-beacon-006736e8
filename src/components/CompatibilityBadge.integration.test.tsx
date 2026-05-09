import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompatibilityBadge } from "@/components/CompatibilityBadge";
import type { DiscoveredDevice } from "@/lib/m365/scooter-service";

/**
 * Integration tests: simulate the scan + GATT discovery pipeline producing a
 * DiscoveredDevice (as use-scooter.connect() would build it) and verify the
 * CompatibilityBadge derives the correct "Source: ..." footer from it.
 *
 * These intentionally exercise the awkward shapes the BLE plugin can return:
 *   - empty / undefined service UUID lists
 *   - manufacturerIds with mixed types (numbers, strings, null)
 *   - GATT-only UUIDs merged into serviceUuids (mirroring use-scooter.ts:60)
 *   - case-different UUIDs from advert vs. GATT
 */

const NINEBOT_UUID = "0000fff0-0000-1000-8000-006e696e65626f74";

/**
 * Mirrors the merge in use-scooter.ts:60:
 *   const merged = Array.from(new Set([...advUuids, ...gattUuids]));
 *   store.setSelected({ ...device, serviceUuids: merged, gattServiceUuids: gattUuids });
 */
function mergeFromPipeline(
  base: Omit<DiscoveredDevice, "gattServiceUuids">,
  gattUuids: string[],
): DiscoveredDevice {
  const advUuids = base.serviceUuids ?? [];
  const merged = Array.from(new Set([...advUuids, ...gattUuids]));
  return { ...base, serviceUuids: merged, gattServiceUuids: gattUuids };
}

function renderFromDevice(device: DiscoveredDevice) {
  return render(
    <CompatibilityBadge
      profile="ninebot"
      deviceName={device.name}
      serviceUuids={device.serviceUuids}
      gattServiceUuids={device.gattServiceUuids}
      manufacturerIds={device.manufacturerIds}
      variant="full"
    />,
  );
}

describe("CompatibilityBadge — integration with scan/discovery pipeline", () => {
  it("classifies as 'GATT services' when scan returned nothing useful and GATT filled in the UUID", () => {
    // Scanner returned a device with no advertised UUIDs / mfg IDs.
    const scanned: DiscoveredDevice = {
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Unknown_Device",
      rssi: -60,
      serviceUuids: [],
      manufacturerIds: [],
    };
    // Post-connect GATT discovery produced the Ninebot service UUID.
    const merged = mergeFromPipeline(scanned, [NINEBOT_UUID]);
    renderFromDevice(merged);
    expect(screen.getByText(/Source: GATT services/i)).toBeInTheDocument();
  });

  it("classifies as 'Scan advertisement' when advert had mfg ID and GATT discovery returned nothing", () => {
    const scanned: DiscoveredDevice = {
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Ninebot_Max",
      rssi: -60,
      serviceUuids: [],
      manufacturerIds: [0x0810],
    };
    const merged = mergeFromPipeline(scanned, []); // GATT empty
    renderFromDevice(merged);
    expect(screen.getByText(/Source: Scan advertisement/i)).toBeInTheDocument();
  });

  it("classifies as 'Scan ads + GATT' when advert provided mfg ID and GATT added a service UUID", () => {
    const scanned: DiscoveredDevice = {
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Ninebot_Max",
      rssi: -55,
      serviceUuids: [],
      manufacturerIds: [0x0810],
    };
    const merged = mergeFromPipeline(scanned, [NINEBOT_UUID]);
    renderFromDevice(merged);
    expect(screen.getByText(/Source: Scan ads \+ GATT/i)).toBeInTheDocument();
  });

  it("dedupes case-different UUIDs from advert vs. GATT (advert UPPER, GATT lower) → counts as GATT-only", () => {
    const scanned: DiscoveredDevice = {
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Unknown_Device",
      rssi: -70,
      serviceUuids: [NINEBOT_UUID.toUpperCase()],
    };
    // GATT returns the same UUID lowercased. Pipeline keeps both strings
    // in the merged list (Set dedup is case-sensitive), but the classifier
    // dedupes case-insensitively → advUuids resolves to empty, so the
    // signal is correctly attributed to GATT.
    const merged = mergeFromPipeline(scanned, [NINEBOT_UUID.toLowerCase()]);
    renderFromDevice(merged);
    expect(screen.getByText(/Source: GATT services/i)).toBeInTheDocument();
  });

  it("handles undefined serviceUuids / manufacturerIds from a minimal scan record", () => {
    const scanned: DiscoveredDevice = {
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Ninebot_Max_5F2A",
      rssi: -80,
      // serviceUuids + manufacturerIds intentionally omitted
    };
    const merged = mergeFromPipeline(scanned, []);
    renderFromDevice(merged);
    expect(screen.getByText(/Source: Device name only/i)).toBeInTheDocument();
  });

  it("safely handles manufacturerIds with mixed types from a flaky plugin payload", () => {
    const scanned: DiscoveredDevice = {
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Unknown_Device",
      rssi: -65,
      serviceUuids: [],
      // Real-world: some plugin builds emit string keys / null entries.
      manufacturerIds: [null, undefined, "0x0810", 0x0810] as any,
    };
    const merged = mergeFromPipeline(scanned, []);
    renderFromDevice(merged);
    // 0x0810 still matches Segway-Ninebot → ads-driven match.
    expect(screen.getByText(/Source: Scan advertisement/i)).toBeInTheDocument();
  });

  it("does not crash and shows Source when GATT returns malformed UUID strings", () => {
    const scanned: DiscoveredDevice = {
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Ninebot_Max",
      rssi: -55,
      serviceUuids: [],
      manufacturerIds: [0x0810],
    };
    const merged = mergeFromPipeline(scanned, [
      "not-a-uuid",
      "",
      "0000GGGG-0000-0000-0000-000000000000",
    ]);
    renderFromDevice(merged);
    // Mfg ID still drives the match; malformed GATT entries are ignored.
    expect(screen.getByText(/Source: Scan advertisement/i)).toBeInTheDocument();
  });

  it("shows no Source footer when device is utterly unknown after the full pipeline", () => {
    const scanned: DiscoveredDevice = {
      deviceId: "AA:BB:CC:DD:EE:FF",
      name: "Tile_1A2B",
      rssi: -90,
      serviceUuids: [],
      manufacturerIds: [],
    };
    const merged = mergeFromPipeline(scanned, []);
    renderFromDevice(merged);
    expect(screen.queryByText(/^Source:/i)).not.toBeInTheDocument();
  });
});
