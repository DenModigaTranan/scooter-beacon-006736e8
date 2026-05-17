import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(__dirname, "../../android/app/src/main/AndroidManifest.xml");
const nscPath = resolve(
  __dirname,
  "../../android/app/src/main/res/xml/network_security_config.xml",
);

describe("AndroidManifest cleartext-traffic guard", () => {
  it("AndroidManifest.xml exists (template is checked in so cap sync preserves hardening)", () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("does not enable android:usesCleartextTraffic anywhere", () => {
    const xml = readFileSync(manifestPath, "utf8");
    // Catch any whitespace/quote-style variation: usesCleartextTraffic = "true" / 'true'
    expect(xml).not.toMatch(/usesCleartextTraffic\s*=\s*["']true["']/i);
  });

  it("explicitly declares android:usesCleartextTraffic=\"false\" on <application>", () => {
    const xml = readFileSync(manifestPath, "utf8");
    expect(xml).toMatch(/android:usesCleartextTraffic\s*=\s*"false"/);
  });

  it("references a network security config", () => {
    const xml = readFileSync(manifestPath, "utf8");
    expect(xml).toMatch(/android:networkSecurityConfig\s*=\s*"@xml\/network_security_config"/);
  });

  it("network_security_config.xml forbids cleartext traffic", () => {
    expect(existsSync(nscPath)).toBe(true);
    const xml = readFileSync(nscPath, "utf8");
    expect(xml).toMatch(/cleartextTrafficPermitted\s*=\s*"false"/);
    expect(xml).not.toMatch(/cleartextTrafficPermitted\s*=\s*"true"/);
  });
});
