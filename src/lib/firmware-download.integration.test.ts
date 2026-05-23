/**
 * Integration test for the flash supply-chain gate.
 *
 * Verifies that attempting to flash firmware from an http:// (or any
 * non-https) catalog entry is blocked by `downloadFirmware` BEFORE any
 * network request is issued. `FlashScreen` itself routes every catalog
 * download through this helper, so an http URL coming from a tampered
 * catalog can never reach `fetch`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { downloadFirmware } from "./firmware-download";
import { InsecureUrlError } from "./https-url";

describe("flash via http firmware URL is blocked before any network request", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), { status: 200 }),
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it("rejects http:// firmware URLs with InsecureUrlError and never calls fetch", async () => {
    await expect(
      downloadFirmware("http://fw.example.com/m365/drv.bin"),
    ).rejects.toBeInstanceOf(InsecureUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects ftp://, file://, javascript: schemes before fetch", async () => {
    for (const url of [
      "ftp://fw.example.com/x.bin",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      await expect(downloadFirmware(url)).rejects.toBeInstanceOf(InsecureUrlError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed/empty URLs before fetch", async () => {
    await expect(downloadFirmware("not a url")).rejects.toBeInstanceOf(InsecureUrlError);
    await expect(downloadFirmware("")).rejects.toBeInstanceOf(InsecureUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the abort signal is never even consulted for non-https URLs", async () => {
    // Pre-aborted signal — if downloadFirmware reached fetch, fetch would
    // throw AbortError, not InsecureUrlError. The InsecureUrlError proves
    // we short-circuited before touching the network layer at all.
    const ac = new AbortController();
    ac.abort();
    await expect(
      downloadFirmware("http://fw.example.com/x.bin", { signal: ac.signal }),
    ).rejects.toBeInstanceOf(InsecureUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allows https:// firmware URLs through to fetch (sanity check)", async () => {
    const bytes = await downloadFirmware("https://fw.example.com/drv.bin");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://fw.example.com/drv.bin",
      expect.objectContaining({ signal: undefined }),
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(4);
  });

  it("propagates HTTP error status (proves https path actually hits fetch)", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    await expect(downloadFirmware("https://fw.example.com/missing.bin"))
      .rejects.toThrow(/HTTP 404/);
  });
});
