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

describe("detectProfile — UUID format edge cases", () => {
  const NINEBOT = "0000fff0-0000-1000-8000-006e696e65626f74";
  const XIAOMI_FE95 = "0000fe95-0000-1000-8000-00805f9b34fb";

  it("matches Ninebot suffix when UUID is uppercase", () => {
    const r = detectProfile({ name: "(unnamed)", serviceUuids: [NINEBOT.toUpperCase()] });
    expect(r?.profile).toBe("ninebot");
  });

  it("matches Ninebot suffix when UUID is mixed case", () => {
    const mixed = "0000FFF0-0000-1000-8000-006e696E65626F74";
    expect(detectProfile({ name: "(unnamed)", serviceUuids: [mixed] })?.profile).toBe("ninebot");
  });

  it("matches Ninebot suffix in undashed (flat 32-hex) form", () => {
    const flat = NINEBOT.replace(/-/g, "");
    expect(detectProfile({ name: "(unnamed)", serviceUuids: [flat] })?.profile).toBe("ninebot");
  });

  it("matches Xiaomi exact UUID when uppercase", () => {
    expect(
      detectProfile({ name: "(unnamed)", serviceUuids: [XIAOMI_FE95.toUpperCase()] })?.profile,
    ).toBe("xiaomi-m365");
  });

  it("trims surrounding whitespace from UUIDs before matching", () => {
    const padded = `  ${NINEBOT}\n`;
    expect(detectProfile({ name: "(unnamed)", serviceUuids: [padded] })?.profile).toBe("ninebot");
  });

  it("ignores empty / whitespace-only UUID entries without crashing", () => {
    const r = detectProfile({
      name: "(unnamed)",
      serviceUuids: ["", "   ", "\t\n"],
    });
    expect(r).toBeNull();
  });

  it("does NOT match a partial ASCII suffix missing the leading 0x00 byte", () => {
    // Real suffix is "006e696e65626f74" (8 bytes incl. leading null).
    // Replacing the null byte with 0xff must NOT match.
    const fake = "0000fff0-0000-1000-8000-ff6e696e65626f74";
    const r = detectProfile({ name: "(unnamed)", serviceUuids: [fake] });
    expect(r).toBeNull();
  });

  it("does NOT match a UUID containing 'ninebot' ASCII outside the trailing position", () => {
    // ASCII "ninebot" appearing mid-UUID, not at the end.
    const fake = "006e696e65626f74-0000-1000-8000-0000abcdef00";
    const r = detectProfile({ name: "(unnamed)", serviceUuids: [fake] });
    expect(r).toBeNull();
  });

  it("does NOT match Xiaomi exact UUID if a single hex char differs", () => {
    const fake = "0000fe96-0000-1000-8000-00805f9b34fb";
    expect(detectProfile({ name: "(unnamed)", serviceUuids: [fake] })).toBeNull();
  });

  it("matches when one UUID in a list of unrelated UUIDs is the Ninebot one", () => {
    const r = detectProfile({
      name: "(unnamed)",
      serviceUuids: [
        "0000180a-0000-1000-8000-00805f9b34fb", // device info
        "0000180f-0000-1000-8000-00805f9b34fb", // battery
        NINEBOT.toUpperCase(),
      ],
    });
    expect(r?.profile).toBe("ninebot");
  });
});
