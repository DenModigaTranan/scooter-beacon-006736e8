/**
 * Profile auto-detection.
 *
 * Inspect a BLE device's advertised name (and any service UUIDs / manufacturer
 * IDs we have at scan time) and guess which `ScooterProfile` it most likely
 * belongs to. Pure & dependency-free so it can be called from any screen.
 *
 * Confidence levels:
 *   - "high"    → strong, brand-specific name match
 *   - "medium"  → known prefix shared with the platform family
 *   - "low"     → weak hint (e.g. only a service UUID present)
 *   - null      → no opinion
 */

import type { ScooterProfile } from "@/lib/profile";

export type DetectConfidence = "high" | "medium" | "low";

export interface ProfileDetectInput {
  name?: string | null;
  /** Lowercase service UUIDs seen in advertisement, if available. */
  serviceUuids?: string[];
  /** Manufacturer IDs (16-bit) seen in advertisement, if available. */
  manufacturerIds?: number[];
}

export interface ProfileDetectResult {
  profile: ScooterProfile;
  confidence: DetectConfidence;
  reasons: string[];
}

/**
 * Brand → list of case-insensitive name patterns. Order matters: more
 * specific patterns first so "EWA-Max" beats a generic "Max" Ninebot match.
 *
 * E-wheels and EWA are Nordic Ninebot rebadges — their advertised names
 * usually include the brand string before the model code.
 */
const NAME_RULES: Array<{
  profile: ScooterProfile;
  patterns: RegExp[];
  confidence: DetectConfidence;
}> = [
  // E-wheels brand markers
  {
    profile: "ewheels",
    confidence: "high",
    patterns: [/^e[- ]?wheels?[-_ ]/i, /\bewheels\b/i, /^ew[- ]?[a-z]?\d/i],
  },
  // EWA brand markers
  {
    profile: "ewa",
    confidence: "high",
    patterns: [/^ewa[-_ ]/i, /\bewa[-_ ][a-z0-9]/i],
  },
  // Xiaomi M365 family
  {
    profile: "xiaomi-m365",
    confidence: "high",
    patterns: [
      /^miscooter/i,
      /^mi[-_ ]?scooter/i,
      /^xiaomi/i,
      /^m365/i,
      /^mipro/i,
      /^miessential/i,
      /^mi1s/i,
      /^mi(electric)?scooter[-_ ]?[34]/i,
    ],
  },
  // Ninebot / Segway
  {
    profile: "ninebot",
    confidence: "high",
    patterns: [
      /^ninebot/i,
      /^segway/i,
      /^nb[a-z]*[-_ ]/i,
      /^kickscooter/i,
      /^max[-_ ]?g30/i,
    ],
  },
  // Weaker generic Ninebot hints (model-only names without the brand prefix)
  {
    profile: "ninebot",
    confidence: "medium",
    patterns: [/^es[1-4]\b/i, /^f(20|25|30|40|2)\b/i, /^gt[12]\b/i, /^e(22|25|45)\b/i],
  },
];

// Service UUIDs we know belong to specific protocols.
const SERVICE_RULES: Array<{ profile: ScooterProfile; uuid: string }> = [
  // Ninebot custom GATT service
  { profile: "ninebot", uuid: "6e400001-b5a3-f393-e0a9-e50e24dcca9e" },
  // Xiaomi M365 service
  { profile: "xiaomi-m365", uuid: "0000fe95-0000-1000-8000-00805f9b34fb" },
];

const MANUFACTURER_RULES: Array<{ profile: ScooterProfile; id: number; reason: string }> = [
  { profile: "xiaomi-m365", id: 0x0157, reason: "Xiaomi company ID" },
  { profile: "ninebot",     id: 0x0a78, reason: "Segway/Ninebot company ID" },
];

/**
 * Returns the best-guess profile for a discovered device, or `null` if no
 * rule fires. Callers can use this to suggest an automatic profile switch.
 */
export function detectProfile(input: ProfileDetectInput): ProfileDetectResult | null {
  const reasons: string[] = [];
  const name = (input.name ?? "").trim();

  // 1. Name patterns (most reliable for brand attribution).
  for (const rule of NAME_RULES) {
    for (const re of rule.patterns) {
      if (re.test(name)) {
        return {
          profile: rule.profile,
          confidence: rule.confidence,
          reasons: [`name "${name}" matches ${re}`],
        };
      }
    }
  }

  // 2. Service UUID hints.
  const services = (input.serviceUuids ?? []).map((u) => u.toLowerCase());
  for (const rule of SERVICE_RULES) {
    if (services.includes(rule.uuid.toLowerCase())) {
      reasons.push(`advertises service ${rule.uuid}`);
      return { profile: rule.profile, confidence: "medium", reasons };
    }
  }

  // 3. Manufacturer ID hints (weak — many devices share these).
  const ids = input.manufacturerIds ?? [];
  for (const rule of MANUFACTURER_RULES) {
    if (ids.includes(rule.id)) {
      return {
        profile: rule.profile,
        confidence: "low",
        reasons: [rule.reason],
      };
    }
  }

  return null;
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
