import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const plistPath = resolve(__dirname, "../../ios/App/App/Info.plist");

/**
 * Parse a (small, hand-maintained) Apple plist XML into a nested JS object.
 * Supports dict/array/string/true/false/integer — enough for the ATS block.
 */
function parsePlist(xml: string): unknown {
  // Strip XML declaration, DOCTYPE, comments
  const body = xml
    .replace(/<\?xml[^?]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();

  const tokens = body.match(/<\/?[a-zA-Z]+(?:\s[^>]*)?\/?>|[^<]+/g) ?? [];
  let i = 0;

  const skipWs = () => {
    while (i < tokens.length && /^\s+$/.test(tokens[i])) i++;
  };

  const parseValue = (): unknown => {
    skipWs();
    const tok = tokens[i++];
    if (tok === "<dict>") return parseDict();
    if (tok === "<dict/>") return {};
    if (tok === "<array>") return parseArray();
    if (tok === "<array/>") return [];
    if (tok === "<true/>") return true;
    if (tok === "<false/>") return false;
    if (tok === "<string>") {
      const v = tokens[i++] ?? "";
      i++; // </string>
      return v;
    }
    if (tok === "<string/>") return "";
    if (tok === "<integer>") {
      const v = parseInt(tokens[i++] ?? "0", 10);
      i++; // </integer>
      return v;
    }
    throw new Error(`Unexpected plist token: ${tok}`);
  };

  const parseDict = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    while (true) {
      skipWs();
      const tok = tokens[i];
      if (tok === "</dict>") {
        i++;
        return out;
      }
      if (tok !== "<key>") throw new Error(`Expected <key>, got ${tok}`);
      i++;
      const key = tokens[i++] ?? "";
      i++; // </key>
      out[key] = parseValue();
    }
  };

  const parseArray = (): unknown[] => {
    const out: unknown[] = [];
    while (true) {
      skipWs();
      if (tokens[i] === "</array>") {
        i++;
        return out;
      }
      out.push(parseValue());
    }
  };

  // Find <plist ...> then read its single child value
  while (i < tokens.length && !/^<plist(\s|>)/.test(tokens[i])) i++;
  i++; // consume <plist ...>
  const root = parseValue();
  return root;
}

describe("iOS App Transport Security guard", () => {
  it("Info.plist exists (template is checked in so cap sync preserves hardening)", () => {
    expect(existsSync(plistPath)).toBe(true);
  });

  it("ATS does not allow arbitrary loads anywhere", () => {
    const xml = readFileSync(plistPath, "utf8");
    const plist = parsePlist(xml) as Record<string, unknown>;
    const ats = plist["NSAppTransportSecurity"] as Record<string, unknown> | undefined;

    expect(ats, "NSAppTransportSecurity dict must be present").toBeDefined();
    expect(ats!["NSAllowsArbitraryLoads"]).toBe(false);
    expect(ats!["NSAllowsArbitraryLoadsInWebContent"]).toBe(false);
    expect(ats!["NSAllowsArbitraryLoadsForMedia"]).toBe(false);
    expect(ats!["NSAllowsLocalNetworking"]).toBe(false);
  });

  it("ATS declares no per-domain cleartext exceptions", () => {
    const xml = readFileSync(plistPath, "utf8");
    const plist = parsePlist(xml) as Record<string, unknown>;
    const ats = plist["NSAppTransportSecurity"] as Record<string, unknown>;
    const exceptions = ats["NSExceptionDomains"] as
      | Record<string, Record<string, unknown>>
      | undefined;

    if (!exceptions) return; // none declared — best case
    for (const [domain, cfg] of Object.entries(exceptions)) {
      expect(cfg["NSExceptionAllowsInsecureHTTPLoads"], `${domain} insecure loads`).not.toBe(true);
      expect(cfg["NSThirdPartyExceptionAllowsInsecureHTTPLoads"], `${domain} 3p`).not.toBe(true);
      expect(cfg["NSExceptionMinimumTLSVersion"], `${domain} TLS`).not.toMatch(/^TLSv1\.[01]$/);
    }
  });

  it("raw XML contains no obvious cleartext re-enables", () => {
    const xml = readFileSync(plistPath, "utf8");
    // Catch the common footguns even if the parser misses an edge case.
    const dangerous = [
      /<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/,
      /<key>NSAllowsArbitraryLoadsInWebContent<\/key>\s*<true\/>/,
      /<key>NSAllowsArbitraryLoadsForMedia<\/key>\s*<true\/>/,
      /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/,
      /<key>NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\/>/,
    ];
    for (const re of dangerous) expect(xml).not.toMatch(re);
  });
});
