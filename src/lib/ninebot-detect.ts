/**
 * Lightweight Segway-Ninebot detection from a BLE advertisement.
 *
 * We intentionally keep this side-effect-free and dependency-free so it can
 * run inside the scan callback (called many times per second) without
 * risking jank. Detection is a best-effort heuristic — there is no public
 * registry of Ninebot BLE adverts, so we combine three independently
 * sufficient signals derived from publicly reverse-engineered docs (e.g.
 * https://nootnooot.codeberg.page/segway-ninebot-ble):
 *
 *   1. Advertised name prefix. Ninebot scooters historically use
 *      "Ninebot…", "NB…", or the legacy Xiaomi-branded "MIScooter…" /
 *      "MISC…" naming. Match is case-insensitive and prefix-only so we
 *      don't false-positive on devices that merely contain the substring.
 *   2. Custom GATT service UUID. The Segway-Ninebot custom service uses a
 *      UUID whose tail spells "ninebot" in ASCII: the last 12 hex chars
 *      are `006e696e65626f74` (i.e. `\0ninebot`). Any 128-bit UUID with
 *      that suffix is an unambiguous match.
 *   3. Manufacturer ID. Segway-Ninebot's assigned Bluetooth SIG company
 *      identifier is 0x0810. (Some legacy Xiaomi-branded units advertise
 *      under Xiaomi's 0x038F instead, which we treat as a *weak* hint —
 *      not enough on its own because plenty of non-scooter Mi devices
 *      share that ID.)
 *
 * `confidence` reflects how many strong signals agreed:
 *   - "high"   → service UUID matched, OR name + Segway company ID matched
 *   - "medium" → name prefix matched alone
 *   - "low"    → only the Xiaomi company ID hint, with no name match
 *
 * Returns `null` when no signal fires, so callers can render unchanged.
 */

export interface NinebotDetection {
  /** Always true when this object is returned. */
  isNinebot: true;
  confidence: "low" | "medium" | "high";
  /** Human-readable label suitable for a chip in the device row. */
  label: string;
  /** Which signal(s) triggered the match — useful for debug tooltips. */
  reasons: string[];
}

// Bluetooth SIG company identifiers. Source: Bluetooth assigned numbers.
const COMPANY_ID_SEGWAY = 0x0810;
const COMPANY_ID_XIAOMI = 0x038f;

// Case-insensitive prefix match. Order matters only for cosmetic logging;
// any hit is treated equally.
const NINEBOT_NAME_PREFIXES = ["ninebot", "nb", "miscooter", "misc"] as const;

/**
 * The custom Ninebot service uses a 128-bit UUID whose final 6 bytes are
 * the ASCII string "\0ninebot". We match on the trailing 12 hex chars so
 * we're robust to either dashed or undashed UUID formatting.
 */
const NINEBOT_SERVICE_SUFFIX = "006e696e65626f74";

function nameMatchesNinebot(name: string | null | undefined): string | null {
  if (!name) return null;
  const lower = name.trim().toLowerCase();
  for (const prefix of NINEBOT_NAME_PREFIXES) {
    if (lower.startsWith(prefix)) return prefix;
  }
  return null;
}

function serviceMatchesNinebot(serviceUuids: readonly string[]): string | null {
  for (const u of serviceUuids) {
    // Strip dashes and lowercase so 128-bit UUIDs like
    // "6e400001-b5a3-f393-e0a9-006e696e65626f74" and the undashed form
    // both compare equal against the suffix.
    const flat = u.replace(/-/g, "").toLowerCase();
    if (flat.endsWith(NINEBOT_SERVICE_SUFFIX)) return u;
  }
  return null;
}

export function detectNinebot(input: {
  name?: string | null;
  serviceUuids?: readonly string[];
  manufacturerIds?: readonly number[];
}): NinebotDetection | null {
  const reasons: string[] = [];
  let strongHits = 0;

  const namePrefix = nameMatchesNinebot(input.name);
  if (namePrefix) {
    reasons.push(`name starts with "${namePrefix}"`);
    strongHits += 1;
  }

  const serviceHit = serviceMatchesNinebot(input.serviceUuids ?? []);
  if (serviceHit) {
    reasons.push(`service UUID ${serviceHit}`);
    // Service UUID is the strongest single signal — it has the literal
    // ASCII "ninebot" baked in, no other vendor uses it.
    strongHits += 2;
  }

  const ids = input.manufacturerIds ?? [];
  const hasSegway = ids.includes(COMPANY_ID_SEGWAY);
  const hasXiaomi = ids.includes(COMPANY_ID_XIAOMI);
  if (hasSegway) {
    reasons.push("manufacturer ID 0x0810 (Segway)");
    strongHits += 1;
  }
  // Xiaomi alone is a weak hint (lots of non-scooter Mi devices share it),
  // so we only record it when we have no other evidence — and even then
  // only as a "low" confidence flag, not a confident match.
  let weakOnlyXiaomi = false;
  if (hasXiaomi && strongHits === 0) {
    reasons.push("manufacturer ID 0x038F (Xiaomi, weak)");
    weakOnlyXiaomi = true;
  }

  if (strongHits === 0 && !weakOnlyXiaomi) return null;

  let confidence: NinebotDetection["confidence"];
  if (serviceHit || (namePrefix && hasSegway)) confidence = "high";
  else if (strongHits >= 1) confidence = "medium";
  else confidence = "low";

  return {
    isNinebot: true,
    confidence,
    label: "Ninebot",
    reasons,
  };
}
