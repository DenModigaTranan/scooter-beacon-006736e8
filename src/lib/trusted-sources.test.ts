import { describe, it, expect } from "vitest";
import { normalisePrefix } from "./trusted-sources";

describe("normalisePrefix", () => {
  describe("scheme handling", () => {
    it("rejects http:// URLs (would bypass SHA-256 verification over plaintext)", () => {
      expect(normalisePrefix("http://fw.example.com")).toBeNull();
      expect(normalisePrefix("http://fw.example.com/m365/")).toBeNull();
    });

    it("rejects non-http(s) schemes", () => {
      expect(normalisePrefix("ftp://fw.example.com")).toBeNull();
      expect(normalisePrefix("file:///etc/passwd")).toBeNull();
      expect(normalisePrefix("javascript:alert(1)")).toBeNull();
      expect(normalisePrefix("ws://fw.example.com")).toBeNull();
    });

    it("accepts https:// URLs", () => {
      expect(normalisePrefix("https://fw.example.com")).toBe("https://fw.example.com");
    });
  });

  describe("input validation", () => {
    it("rejects empty / whitespace-only input", () => {
      expect(normalisePrefix("")).toBeNull();
      expect(normalisePrefix("   ")).toBeNull();
    });

    it("rejects malformed URLs", () => {
      expect(normalisePrefix("not a url")).toBeNull();
      expect(normalisePrefix("example.com")).toBeNull();
    });

    it("trims surrounding whitespace before parsing", () => {
      expect(normalisePrefix("  https://fw.example.com  ")).toBe("https://fw.example.com");
    });
  });

  describe("path-prefix normalisation", () => {
    it("strips a bare-root path so origin-only entries stay bare", () => {
      expect(normalisePrefix("https://fw.example.com/")).toBe("https://fw.example.com");
      expect(normalisePrefix("https://fw.example.com")).toBe("https://fw.example.com");
    });

    it("appends a trailing slash to path prefixes to prevent sibling-prefix matches", () => {
      // Without the trailing slash, "/m365" would also match "/m365-evil/...".
      expect(normalisePrefix("https://fw.example.com/m365")).toBe(
        "https://fw.example.com/m365/",
      );
    });

    it("preserves an existing trailing slash on path prefixes", () => {
      expect(normalisePrefix("https://fw.example.com/m365/")).toBe(
        "https://fw.example.com/m365/",
      );
    });

    it("preserves nested paths", () => {
      expect(normalisePrefix("https://fw.example.com/a/b/c")).toBe(
        "https://fw.example.com/a/b/c/",
      );
    });

    it("preserves explicit ports in the host", () => {
      expect(normalisePrefix("https://fw.example.com:8443/m365")).toBe(
        "https://fw.example.com:8443/m365/",
      );
    });

    it("drops query strings and fragments", () => {
      expect(normalisePrefix("https://fw.example.com/m365/?x=1#frag")).toBe(
        "https://fw.example.com/m365/",
      );
    });
  });
});
