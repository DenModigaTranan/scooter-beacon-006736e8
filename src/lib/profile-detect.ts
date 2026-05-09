/**
 * Profile auto-detection.
 *
 * Inspects a BLE advertisement (name + service UUIDs + manufacturer IDs) and
 * returns a best-guess `ScooterProfile`. Pure & dependency-free so it can be
 * called from any screen, including inside scan callbacks.
 *
 * Scoring model
 * -------------
 * Each signal contributes points toward a profile. The profile with the
 * highest score wins, and the score is mapped to a confidence level:
 *
 *   - Brand-specific name pattern  → +5  (very strong: contains a brand
 *     literal in the advertised local name)
 *   - Generic / model-only name    → +2  (e.g. "ES4-…", "F30-…")
 *   - Custom service UUID          → +4  (Ninebot ASCII-suffix UUID,
 *     Xiaomi M365 service UUID)
 *   - Manufacturer company ID      → +2  (Segway 0x0810, Xiaomi 0x038F /
 *     0x0157, Ninebot 0x0a78)
 *
 *   total ≥ 5 → "high"
 *   total ≥ 3 → "medium"
 *   total ≥ 1 → "low"
 *
 * Independent signals stack: a service-UUID hit *plus* a brand name produces
 * a higher score (and confidence) than either alone, which is exactly what we
 * want when surfacing a "switch profile?" suggestion.
 */

import type { ScooterProfile } from "@/lib/profile";

export type DetectConfidence = "high" | "medium" | "low";

export interface ProfileDetectInput {
  name?: string | null;
  /** Lowercase or upper-case 128-bit service UUIDs from the scan record. */
  serviceUuids?: string[];
  /** 16-bit manufacturer IDs seen in advertisement. */
  manufacturerIds?: number[];
}

export interface ProfileDetectResult {
  profile: ScooterProfile;
  confidence: DetectConfidence;
  reasons: string[];
  /** Internal score — exposed for tests / debugging. */
  score: number;
}

/**
 * Brand → list of case-insensitive name patterns. More specific patterns
 * first so e.g. "EWA-Max" beats a generic Ninebot "Max" match.
 */
const NAME_RULES: Array<{
  profile: ScooterProfile;
  patterns: RegExp[];
  weight: number; // 5 = brand-specific, 2 = model-only/weak
}> = [
  // E-wheels brand markers
  { profile: "ewheels", weight: 5, patterns: [/^e[- ]?wheels?[-_ ]/i, /\bewheels\b/i, /^ew[- ]?[a-z]?\d/i] },
  // EWA brand markers
  { profile: "ewa",     weight: 5, patterns: [/^ewa[-_ ]/i, /\bewa[-_ ][a-z0-9]/i] },
  // Xiaomi M365 family
  {
    profile: "xiaomi-m365",
    weight: 5,
    patterns: [
      /^miscooter/i, /^mi[-_ ]?scooter/i, /^xiaomi/i, /^m365/i,
      /^mipro/i, /^miessential/i, /^mi1s/i, /^mi(electric)?scooter[-_ ]?[34]/i,
    ],
  },
  // Ninebot / Segway brand markers
  {
    profile: "ninebot",
    weight: 5,
    patterns: [/^ninebot/i, /^segway/i, /^nb[a-z]*[-_ ]/i, /^kickscooter/i, /^max[-_ ]?g30/i],
  },
  // Weaker model-only Ninebot hints (no brand prefix)
  {
    profile: "ninebot",
    weight: 2,
    patterns: [/^es[1-4]\b/i, /^f(20|25|30|40|2)\b/i, /^gt[12]\b/i, /^e(22|25|45)\b/i],
  },
];

/**
 * Service UUIDs we can attribute to a specific protocol.
 *
 * Ninebot uses a custom 128-bit UUID whose final 6 bytes spell the ASCII
 * string "\0ninebot" — i.e. any UUID ending in `006e696e65626f74` is an
 * unambiguous Ninebot match. We match on the 12-hex-char suffix to be robust
 * to dashed vs. undashed formatting.
 */
const NINEBOT_SERVICE_SUFFIX = "006e696e65626f74";
const SERVICE_RULES: Array<
  | { profile: ScooterProfile; kind: "exact"; uuid: string; weight: number }
  | { profile: ScooterProfile; kind: "suffix"; suffix: string; weight: number }
> = [
  // Ninebot ASCII-suffix UUID — unambiguous, full weight.
  { profile: "ninebot",     kind: "suffix", suffix: NINEBOT_SERVICE_SUFFIX, weight: 4 },
  // Xiaomi mi-home service (FE95). Shared with non-scooter Mi devices, so
  // we down-weight it slightly.
  { profile: "xiaomi-m365", kind: "exact",  uuid: "0000fe95-0000-1000-8000-00805f9b34fb", weight: 3 },
];

const MANUFACTURER_RULES: Array<{
  profile: ScooterProfile;
  id: number;
  weight: number;
  reason: string;
}> = [
  { profile: "ninebot",     id: 0x0810, weight: 2, reason: "manufacturer ID 0x0810 (Segway-Ninebot)" },
  { profile: "ninebot",     id: 0x0a78, weight: 2, reason: "manufacturer ID 0x0a78 (Ninebot)" },
  { profile: "xiaomi-m365", id: 0x038f, weight: 1, reason: "manufacturer ID 0x038F (Xiaomi, weak)" },
  { profile: "xiaomi-m365", id: 0x0157, weight: 1, reason: "manufacturer ID 0x0157 (Xiaomi, weak)" },
];

interface Bucket {
  score: number;
  reasons: string[];
}

function bump(map: Map<ScooterProfile, Bucket>, p: ScooterProfile, weight: number, reason: string) {
  const cur = map.get(p) ?? { score: 0, reasons: [] };
  cur.score += weight;
  cur.reasons.push(reason);
  map.set(p, cur);
}

/**
 * Returns the best-guess profile for a discovered device, or `null` if no
 * rule fires across any signal.
 */
export function detectProfile(input: ProfileDetectInput): ProfileDetectResult | null {
  const buckets = new Map<ScooterProfile, Bucket>();
  const name = (input.name ?? "").trim();

  // 1. Name patterns — record the first matching pattern per (profile,weight)
  //    so we don't double-count overlapping regexes.
  if (name) {
    const seen = new Set<ScooterProfile>();
    for (const rule of NAME_RULES) {
      if (seen.has(rule.profile) && rule.weight <= 2) continue;
      for (const re of rule.patterns) {
        if (re.test(name)) {
          bump(buckets, rule.profile, rule.weight, `name "${name}" matches ${re}`);
          seen.add(rule.profile);
          break;
        }
      }
    }
  }

  // 2. Service UUIDs — exact match or ASCII suffix.
  const services = (input.serviceUuids ?? [])
    .filter((u): u is string => typeof u === "string")
    .map((u) => u.trim().toLowerCase())
    .filter((u) => u.length > 0);
  for (const rule of SERVICE_RULES) {
    for (const u of services) {
      const flat = u.replace(/-/g, "");
      const hit =
        rule.kind === "exact"
          ? u === rule.uuid.toLowerCase()
          : flat.endsWith(rule.suffix);
      if (hit) {
        bump(buckets, rule.profile, rule.weight, `advertises service ${u}`);
        break;
      }
    }
  }

  // 3. Manufacturer IDs.
  const ids = Array.isArray(input.manufacturerIds) ? input.manufacturerIds : [];
  for (const rule of MANUFACTURER_RULES) {
    if (ids.includes(rule.id)) bump(buckets, rule.profile, rule.weight, rule.reason);
  }

  if (buckets.size === 0) return null;

  // Pick the highest-scoring profile. Ties broken by insertion order, which
  // happens to match our rule priority (brand patterns first).
  let bestProfile: ScooterProfile | null = null;
  let bestBucket: Bucket | null = null;
  for (const [p, b] of buckets) {
    if (!bestBucket || b.score > bestBucket.score) {
      bestProfile = p;
      bestBucket = b;
    }
  }
  if (!bestProfile || !bestBucket) return null;

  const confidence: DetectConfidence =
    bestBucket.score >= 5 ? "high" : bestBucket.score >= 3 ? "medium" : "low";

  return {
    profile: bestProfile,
    confidence,
    reasons: bestBucket.reasons,
    score: bestBucket.score,
  };
}

/** Pretty short label suitable for a chip. */
export function detectChipLabel(r: ProfileDetectResult): string {
  switch (r.profile) {
    case "xiaomi-m365": return "Xiaomi";
    case "ninebot":     return "Ninebot";
    case "ewheels":     return "E-wheels";
    case "ewa":         return "EWA";
    case "generic-ble": return "Generic";
  }
}
