import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CompatibilityBadge } from "@/components/CompatibilityBadge";

/**
 * These tests render the full-variant <CompatibilityBadge /> and assert on
 * the "Source: ..." footer it produces, exercising the classifySource()
 * decision matrix end-to-end (including its dependency on detectProfile).
 */

const NINEBOT_UUID = "0000fff0-0000-1000-8000-006e696e65626f74";
const ANOTHER_NINEBOT_UUID = "6e400001-b5a3-f393-e0a9-006e696e65626f74";

function renderBadge(props: React.ComponentProps<typeof CompatibilityBadge>) {
  return render(<CompatibilityBadge {...props} />);
}

describe("CompatibilityBadge — Source classification", () => {
  it("classifies as 'Device name only' when no UUIDs / mfg IDs are present", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Ninebot_Max_5F2A",
      variant: "full",
    });
    expect(screen.getByText(/Source: Device name only/i)).toBeInTheDocument();
  });

  it("classifies as 'Scan advertisement' when only advertised mfg ID/UUIDs contribute", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Ninebot_Max",
      manufacturerIds: [0x0810],
      variant: "full",
    });
    expect(screen.getByText(/Source: Scan advertisement/i)).toBeInTheDocument();
  });

  it("classifies as 'GATT services' when only post-connect discovery contributes", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Unknown_Device",
      serviceUuids: [NINEBOT_UUID], // also present in gatt list → not advertised
      gattServiceUuids: [NINEBOT_UUID],
      variant: "full",
    });
    expect(screen.getByText(/Source: GATT services/i)).toBeInTheDocument();
  });

  it("classifies as 'Scan ads + GATT' when both signals contribute", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Ninebot_Max",
      manufacturerIds: [0x0810], // ads signal
      serviceUuids: [ANOTHER_NINEBOT_UUID], // also in gatt → gatt-only UUID
      gattServiceUuids: [ANOTHER_NINEBOT_UUID],
      variant: "full",
    });
    expect(screen.getByText(/Source: Scan ads \+ GATT/i)).toBeInTheDocument();
  });

  it("does not show a Source footer when nothing is detected", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Tile_1A2B",
      variant: "full",
    });
    expect(screen.queryByText(/^Source:/i)).not.toBeInTheDocument();
  });

  it("compact variant exposes source via title attribute when matched", () => {
    const { container } = renderBadge({
      profile: "ninebot",
      deviceName: "Ninebot_Max",
      manufacturerIds: [0x0810],
      variant: "compact",
    });
    const chip = container.querySelector("span[title]") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute("title")).toMatch(/via Scan advertisement/i);
  });

  it("deduplicates case-differing UUIDs across serviceUuids and gattServiceUuids", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Unknown_Device",
      serviceUuids: [NINEBOT_UUID.toUpperCase()],
      gattServiceUuids: [NINEBOT_UUID.toLowerCase()],
      variant: "full",
    });
    expect(screen.getByText(/Source: GATT services/i)).toBeInTheDocument();
  });

  it("classifies as 'Scan ads + GATT' when UUID is duplicated across both lists plus a manufacturer ID is present", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Ninebot_Max",
      serviceUuids: [NINEBOT_UUID],
      gattServiceUuids: [NINEBOT_UUID],
      manufacturerIds: [0x0810],
      variant: "full",
    });
    expect(screen.getByText(/Source: Scan ads \+ GATT/i)).toBeInTheDocument();
  });

  it("handles invalid UUID strings safely without crashing", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Ninebot_Max",
      serviceUuids: ["not-a-uuid", "0000GGGG-0000-0000-0000-000000000000", ""],
      gattServiceUuids: ["completely-bogus", "!!!malformed!!!"],
      variant: "full",
    });
    // Name matches, invalid UUIDs are ignored — should not crash and still show a source.
    expect(screen.getByText(/Source:/i)).toBeInTheDocument();
  });

  it("classifies duplicate UUIDs within the advertised list only as 'Scan advertisement'", () => {
    renderBadge({
      profile: "ninebot",
      deviceName: "Unknown_Device",
      serviceUuids: [NINEBOT_UUID, NINEBOT_UUID],
      variant: "full",
    });
    expect(screen.getByText(/Source: Scan advertisement/i)).toBeInTheDocument();
  });
});
