import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assertHttpsUrl, isHttpsUrl, InsecureUrlError } from "./https-url";
import { setCatalogUrl, fetchCatalog, getCatalogUrl } from "./m365/catalog";

describe("isHttpsUrl", () => {
  it("returns true only for https URLs", () => {
    expect(isHttpsUrl("https://x.com/a")).toBe(true);
    expect(isHttpsUrl("https://x.com:8443/a")).toBe(true);
  });

  it("rejects http, other schemes, junk, and empty", () => {
    expect(isHttpsUrl("http://x.com")).toBe(false);
    expect(isHttpsUrl("ftp://x.com")).toBe(false);
    expect(isHttpsUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrl("ws://x.com")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
    expect(isHttpsUrl("")).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
    expect(isHttpsUrl(null)).toBe(false);
  });
});

describe("assertHttpsUrl", () => {
  it("returns the parsed URL for https inputs", () => {
    const u = assertHttpsUrl("https://fw.example.com/firmware.bin", "firmware URL");
    expect(u).toBeInstanceOf(URL);
    expect(u.host).toBe("fw.example.com");
  });

  it("throws InsecureUrlError for http", () => {
    expect(() => assertHttpsUrl("http://fw.example.com/firmware.bin", "firmware URL"))
      .toThrow(InsecureUrlError);
  });

  it("throws for non-http(s) schemes", () => {
    expect(() => assertHttpsUrl("ftp://x.com")).toThrow(InsecureUrlError);
    expect(() => assertHttpsUrl("file:///etc/passwd")).toThrow(InsecureUrlError);
    expect(() => assertHttpsUrl("javascript:alert(1)")).toThrow(InsecureUrlError);
  });

  it("throws for malformed / empty input", () => {
    expect(() => assertHttpsUrl("not a url")).toThrow(InsecureUrlError);
    expect(() => assertHttpsUrl("")).toThrow(InsecureUrlError);
    expect(() => assertHttpsUrl(undefined)).toThrow(InsecureUrlError);
  });

  it("includes the label in the error message", () => {
    expect(() => assertHttpsUrl("http://x.com", "catalog URL"))
      .toThrow(/catalog URL must be https/);
  });
});

describe("catalog URL https-only enforcement", () => {
  beforeEach(() => localStorage.clear());

  it("setCatalogUrl rejects http:// and does not persist", () => {
    expect(() => setCatalogUrl("http://catalog.example.com/c.json"))
      .toThrow(/https/);
    expect(localStorage.getItem("scootflash:catalog-url")).toBeNull();
  });

  it("setCatalogUrl rejects non-https schemes", () => {
    expect(() => setCatalogUrl("ftp://catalog.example.com/c.json")).toThrow();
    expect(() => setCatalogUrl("javascript:alert(1)")).toThrow();
    expect(() => setCatalogUrl("not a url")).toThrow();
  });

  it("setCatalogUrl accepts https:// and persists", () => {
    setCatalogUrl("https://catalog.example.com/c.json");
    expect(getCatalogUrl()).toBe("https://catalog.example.com/c.json");
  });

  it("setCatalogUrl('') resets to default", () => {
    setCatalogUrl("https://catalog.example.com/c.json");
    setCatalogUrl("");
    expect(getCatalogUrl()).toMatch(/^https:\/\//);
  });
});

describe("no fetch happens for non-https firmware/catalog URLs", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
  });
  afterEach(() => fetchSpy.mockRestore());

  it("setCatalogUrl throws BEFORE any fetch for http URLs", () => {
    expect(() => setCatalogUrl("http://catalog.example.com/c.json")).toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a downstream fetch using assertHttpsUrl throws before issuing the request", async () => {
    // Simulates the FlashScreen firmware-download guard: assert, then fetch.
    const download = async (url: string) => {
      assertHttpsUrl(url, "firmware URL");
      return fetch(url);
    };
    await expect(download("http://fw.example.com/x.bin")).rejects.toBeInstanceOf(InsecureUrlError);
    expect(fetchSpy).not.toHaveBeenCalled();

    await download("https://fw.example.com/x.bin");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith("https://fw.example.com/x.bin");
  });

  it("fetchCatalog only ever uses an https endpoint (default URL is https)", async () => {
    await fetchCatalog();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledWith = fetchSpy.mock.calls[0][0] as string;
    expect(calledWith.startsWith("https://")).toBe(true);
  });
});
