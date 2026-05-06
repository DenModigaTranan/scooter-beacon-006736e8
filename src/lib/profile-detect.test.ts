import { describe, it, expect } from "vitest";
import { detectProfile, detectChipLabel } from "@/lib/profile-detect";

describe("detectProfile — name patterns", () => {
  it("detects Ninebot from brand name", () => {
    const r = detectProfile({ name: "Ninebot_Max_5F2A" });
    expect(r?.profile).toBe("ninebot");
    expect(r?.confidence).toBe("high");
  });

  it("detects Segway as Ninebot", () => {
    expect(detectProfile({ name: "Segway-G30LP" })?.profile).toBe("ninebot");
  });

  it("detects model-only Ninebot names with medium confidence", () => {
    const r = detectProfile({ name: "ES4-1234" });
    expect(r?.profile).toBe("ninebot");
    expect(r?.confidence).toBe("low"); // weight 2 alone → low
  });

  it("detects Xiaomi M365 from MIScooter prefix", () => {
    const r = detectProfile({ name: "MIScooter1234" });
    expect(r?.profile).toBe("xiaomi-m365");
    expect(r?.confidence).toBe("high");
  });

  it("detects E-wheels brand", () => {
    const r = detectProfile({ name: "E-wheels-X7" });
    expect(r?.profile).toBe("ewheels");
    expect(r?.confidence).toBe("high");
  });

  it("detects EWA brand", () => {
    const r = detectProfile({ name: "EWA-Max" });
    expect(r?.profile).toBe("ewa");
    expect(r?.confidence).toBe("high");
  });

  it("returns null for unknown names with no other signals", () => {
    expect(detectProfile({ name: "Tile_1A2B" })).toBeNull();
  });
});

describe("detectProfile — service UUIDs & manufacturer IDs", () => {
  it("detects Ninebot from ASCII-suffix service UUID alone", () => {
    const r = detectProfile({
      name: "(unnamed)",
      serviceUuids: ["6e400001-b5a3-f393-e0a9-006e696e65626f74"],
    });
    expect(r?.profile).toBe("ninebot");
    expect(r?.confidence).toBe("medium"); // weight 4 → medium
  });

  it("detects Xiaomi from FE95 service UUID", () => {
    const r = detectProfile({
      name: "weird-name",
      serviceUuids: ["0000fe95-0000-1000-8000-00805f9b34fb"],
    });
    expect(r?.profile).toBe("xiaomi-m365");
  });

  it("escalates to high confidence when name + service UUID agree", () => {
    const r = detectProfile({
      name: "Ninebot_Max",
      serviceUuids: ["0000fff0-0000-1000-8000-006e696e65626f74"],
    });
    expect(r?.profile).toBe("ninebot");
    expect(r?.confidence).toBe("high");
    expect(r?.score).toBeGreaterThanOrEqual(9);
  });

  it("detects Ninebot from Segway company ID", () => {
    const r = detectProfile({ name: "(unnamed)", manufacturerIds: [0x0810] });
    expect(r?.profile).toBe("ninebot");
    expect(r?.confidence).toBe("low");
  });

  it("treats Xiaomi company ID alone as a low-confidence Xiaomi hint", () => {
    const r = detectProfile({ name: "(unnamed)", manufacturerIds: [0x038f] });
    expect(r?.profile).toBe("xiaomi-m365");
    expect(r?.confidence).toBe("low");
  });

  it("returns null when nothing matches", () => {
    expect(
      detectProfile({
        name: "Garmin_Watch",
        serviceUuids: ["0000180d-0000-1000-8000-00805f9b34fb"],
        manufacturerIds: [0x0087],
      }),
    ).toBeNull();
  });
});

describe("detectChipLabel", () => {
  it("maps profiles to short labels", () => {
    expect(detectChipLabel({ profile: "ninebot", confidence: "high", reasons: [], score: 0 })).toBe("Ninebot");
    expect(detectChipLabel({ profile: "xiaomi-m365", confidence: "high", reasons: [], score: 0 })).toBe("Xiaomi");
    expect(detectChipLabel({ profile: "ewheels", confidence: "high", reasons: [], score: 0 })).toBe("E-wheels");
    expect(detectChipLabel({ profile: "ewa", confidence: "high", reasons: [], score: 0 })).toBe("EWA");
  });
});
