import { describe, it, expect } from "vitest";
import config from "../../capacitor.config";

describe("capacitor.config android security", () => {
  it("does not enable allowMixedContent (would let WebView load http:// resources)", () => {
    const allow = config.android?.allowMixedContent;
    expect(allow === true).toBe(false);
  });

  it("android config is defined", () => {
    expect(config.android).toBeDefined();
  });
});
