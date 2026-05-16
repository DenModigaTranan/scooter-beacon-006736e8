/**
 * Integration tests for the end-to-end trusted-firmware-source flow.
 *
 * Where `trusted-sources.test.ts` exercises the pure `normalisePrefix`
 * helper in isolation, this suite drives the public add → list → match
 * surface that the Settings screen and FlashScreen consume. The goal is
 * to prove that an `http://` URL cannot reach the firmware download path
 * through ANY of these entry points:
 *
 *   - addTrustedSource() (Settings "Add" button)
 *   - importTrustedSources() (Settings JSON import)
 *   - findTrustedSource() / isUrlTrusted() (FlashScreen pre-flight check
 *     that decides whether to skip the SHA-256 verification gate)
 *
 * If any of these accepted http we'd regress to the MITM scenario flagged
 * by `agent_security/http_trusted_sources`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addTrustedSource,
  exportTrustedSources,
  findTrustedSource,
  importTrustedSources,
  isUrlTrusted,
  listTrustedSources,
  removeTrustedSource,
} from "./trusted-sources";

beforeEach(() => {
  localStorage.clear();
});

describe("trusted firmware source flow — http rejection", () => {
  it("addTrustedSource refuses http origins", () => {
    expect(addTrustedSource("evil", "http://fw.example.com")).toBeNull();
    expect(addTrustedSource("evil path", "http://fw.example.com/m365/")).toBeNull();
    expect(listTrustedSources()).toEqual([]);
  });

  it("addTrustedSource refuses other non-https schemes", () => {
    expect(addTrustedSource("ftp", "ftp://fw.example.com")).toBeNull();
    expect(addTrustedSource("file", "file:///etc/passwd")).toBeNull();
    expect(listTrustedSources()).toEqual([]);
  });

  it("an http URL is never matched, even if a sibling https entry exists for the same host", () => {
    addTrustedSource("legit", "https://fw.example.com");
    // The host is trusted over https, but a plaintext download to that
    // same host must NOT inherit trust.
    expect(isUrlTrusted("http://fw.example.com/firmware.bin")).toBe(false);
    expect(findTrustedSource("http://fw.example.com/firmware.bin")).toBeNull();
    // Sanity: the https equivalent IS trusted.
    expect(isUrlTrusted("https://fw.example.com/firmware.bin")).toBe(true);
  });

  it("importTrustedSources silently skips http entries in a JSON payload", () => {
    const payload = JSON.stringify({
      kind: "scootflash:trusted-sources",
      version: 1,
      exportedAt: new Date().toISOString(),
      sources: [
        { label: "legit", prefix: "https://fw.example.com/m365/", addedAt: 1 },
        { label: "mitm", prefix: "http://fw.example.com/", addedAt: 2 },
        { label: "mitm2", prefix: "http://evil.example/firmware/", addedAt: 3 },
      ],
    });
    const result = importTrustedSources(payload, { replace: true });
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(2);
    const stored = listTrustedSources();
    expect(stored).toHaveLength(1);
    expect(stored[0].prefix).toBe("https://fw.example.com/m365/");
  });
});

describe("trusted firmware source flow — https normalisation end-to-end", () => {
  it("stores the normalised prefix (trailing slash on path entries)", () => {
    const entry = addTrustedSource("m365 builds", "https://fw.example.com/m365");
    expect(entry?.prefix).toBe("https://fw.example.com/m365/");
    expect(listTrustedSources()[0].prefix).toBe("https://fw.example.com/m365/");
  });

  it("origin-only entry matches any path on that origin", () => {
    addTrustedSource("any", "https://fw.example.com");
    expect(isUrlTrusted("https://fw.example.com/anything/firmware.bin")).toBe(true);
    expect(isUrlTrusted("https://fw.example.com")).toBe(true);
  });

  it("path-prefix entry only matches within its subtree (no sibling-prefix bleed)", () => {
    addTrustedSource("m365 only", "https://fw.example.com/m365");
    expect(isUrlTrusted("https://fw.example.com/m365/v1/drv.bin")).toBe(true);
    // The classic confused-deputy case: "/m365" must NOT match "/m365-evil/...".
    expect(isUrlTrusted("https://fw.example.com/m365-evil/drv.bin")).toBe(false);
    // Sibling subtree on the same host is also untrusted.
    expect(isUrlTrusted("https://fw.example.com/ninebot/drv.bin")).toBe(false);
  });

  it("different host on https is not trusted just because another host is", () => {
    addTrustedSource("ours", "https://fw.example.com");
    expect(isUrlTrusted("https://fw.attacker.com/firmware.bin")).toBe(false);
  });

  it("round-trips through export → import without admitting http", () => {
    addTrustedSource("ours", "https://fw.example.com/m365");
    const exported = exportTrustedSources();
    // Tamper with the export to inject an http entry before re-importing.
    const tampered = {
      ...exported,
      sources: [
        ...exported.sources,
        { label: "mitm", prefix: "http://fw.example.com/m365/", addedAt: 99 },
      ],
    };
    localStorage.clear();
    const result = importTrustedSources(JSON.stringify(tampered), { replace: true });
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(listTrustedSources().every((s) => s.prefix.startsWith("https://"))).toBe(true);
  });

  it("removeTrustedSource clears the entry so prior trust is revoked", () => {
    addTrustedSource("temp", "https://fw.example.com/m365");
    expect(isUrlTrusted("https://fw.example.com/m365/x.bin")).toBe(true);
    removeTrustedSource("https://fw.example.com/m365/");
    expect(isUrlTrusted("https://fw.example.com/m365/x.bin")).toBe(false);
  });
});
