/**
 * UI integration test for the flash supply-chain gate.
 *
 * Renders a minimal harness that mirrors `FlashScreen`'s download phase
 * (the only path that touches the network for a catalog entry) and
 * proves that clicking "FLASH" on an http:// firmware URL:
 *
 *   1. surfaces an error in the UI,
 *   2. never calls `fetch`, and
 *   3. never increments the "downloaded bytes" counter past 0.
 *
 * `FlashScreen` itself routes every catalog download through
 * `downloadFirmware`, so testing that helper through a click path
 * exercises the same supply-chain guard the production button uses
 * without having to mock the BLE / handshake / catalog stack.
 */
import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { downloadFirmware } from "@/lib/firmware-download";
import { InsecureUrlError } from "@/lib/https-url";

function FlashHarness({ url }: { url: string }) {
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const onFlash = async () => {
    setBusy(true);
    setError("");
    try {
      const bytes = await downloadFirmware(url);
      // Mirror FlashScreen: only bump the counter on a successful download.
      setDownloadedBytes(bytes.length);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button onClick={onFlash} disabled={busy}>FLASH</button>
      <div data-testid="downloaded">{downloadedBytes}</div>
      {error && <div role="alert">{error}</div>}
    </div>
  );
}

describe("FlashScreen: clicking FLASH with an http firmware URL", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }),
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it("shows an error, leaves downloaded bytes at 0, and never calls fetch", async () => {
    render(<FlashHarness url="http://fw.example.com/m365/drv.bin" />);

    expect(screen.getByTestId("downloaded")).toHaveTextContent("0");

    fireEvent.click(screen.getByRole("button", { name: /flash/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/https/i);

    // Counter must NOT advance — no bytes were ever pulled off the wire.
    expect(screen.getByTestId("downloaded")).toHaveTextContent("0");
    // And the network layer was never touched.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the underlying helper throws InsecureUrlError (proves the click hit the gate)", async () => {
    await expect(
      downloadFirmware("http://fw.example.com/m365/drv.bin"),
    ).rejects.toBeInstanceOf(InsecureUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an https URL DOES advance the counter (sanity check for the harness)", async () => {
    render(<FlashHarness url="https://fw.example.com/m365/drv.bin" />);

    fireEvent.click(screen.getByRole("button", { name: /flash/i }));

    await waitFor(() => {
      expect(screen.getByTestId("downloaded")).toHaveTextContent("4");
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
