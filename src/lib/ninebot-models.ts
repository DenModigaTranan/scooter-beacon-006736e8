/**
 * Segway-Ninebot model registry.
 *
 * What this is:
 *   A static, dependency-free table of Ninebot/Segway models we know how
 *   to recognize from a BLE advertisement plus the protocol-level
 *   capabilities each model exposes. The registry is intentionally
 *   *descriptive*, not *behavioral* — it tells the rest of the app what a
 *   given physical device can be asked to do, without itself performing
 *   any I/O. The transport layer (frame codec, auth handshake, register
 *   reads) consumes this catalog when deciding which commands to surface
 *   in the UI and which encoder/decoder to use.
 *
 * Why a registry vs. probing the device:
 *   The Segway-Ninebot protocol does not advertise a machine-readable
 *   capability set. The advertised name (e.g. "NBScooter…", "MIMax…") is
 *   the cheapest available proxy for model family, and once connected we
 *   can sharpen that with the hardware-ID register read (`0x12` on most
 *   gens). We model both so detection can run in two passes — pre-connect
 *   from the advert, post-connect from the hardware ID.
 *
 * Detection precedence at call sites:
 *   1. Exact `hardwareId` match (post-connect, authoritative).
 *   2. `serviceUuidSuffix` match (pre-connect, very strong — the custom
 *      Ninebot service UUID literally encodes "ninebot" in ASCII).
 *   3. `namePrefixes` longest-match (pre-connect, heuristic but cheap).
 *   4. Fall through to `FALLBACK_MODEL` so the UI always has *some* entry
 *      to render rather than a null state.
 *
 * Sourcing notes:
 *   Hardware IDs and command sets are taken from the publicly
 *   reverse-engineered protocol docs at
 *   https://nootnooot.codeberg.page/segway-ninebot-ble (community
 *   reference, verified against an E125S). We deliberately model only a
 *   small representative slice of the ~66 documented devices — enough to
 *   exercise the detection code paths without pretending to be exhaustive.
 *   Adding a model is a one-object append; nothing else needs to change.
 *
 * Stability:
 *   `id` is a stable identifier safe to persist (e.g. into per-device
 *   user prefs). Display labels and command lists may change without
 *   breaking persisted data.
 */

/**
 * Coarse product category. Used by the UI to pick an icon set and decide
 * which telemetry tiles even make sense (e.g. an EUC has no "lock" tile).
 */
export type NinebotCategory =
  | "kick-scooter"
  | "moped"
  | "self-balancing"
  | "go-kart"
  | "unicycle"
  | "e-bike"
  | "speaker"
  | "power-station";

/**
 * Wire-format generation. Determines which frame codec + auth flow the
 * transport layer must use. We name them after the conventions used in
 * the public protocol docs:
 *   - "p1"  — legacy plaintext frames, header 0x55 0xAA (M365 era)
 *   - "p2"  — newer plaintext frames, header 0x5A 0xA5
 *   - "enc2"— "Encryption 2": p2 framing wrapped in AES-128-CTR with
 *             CBC-MAC, key derived via the 3-phase handshake
 *   - "wifi"— OTA/WiFi gateway profile (out of scope for BLE clients)
 */
export type NinebotProtocol = "p1" | "p2" | "enc2" | "wifi";

/**
 * Discrete capability tokens. We use string unions instead of booleans
 * so adding a new capability is a one-line append and so the UI can
 * iterate the set without writing per-flag code paths.
 *
 * Conventions:
 *   - "read.*"   — pulls a value from the device, no side effects.
 *   - "write.*"  — mutates device state; should be gated on auth.
 *   - "secure.*" — requires the auth handshake to have completed.
 */
export type NinebotCapability =
  | "read.battery"
  | "read.speed"
  | "read.odometer"
  | "read.mode"
  | "read.temperature"
  | "read.firmware-version"
  | "read.serial-number"
  | "write.lock"
  | "write.unlock"
  | "write.lights"
  | "write.beep"
  | "write.speed-limit"
  | "write.cruise-control"
  | "write.ble-name"
  | "secure.firmware-update";

/**
 * What we'll attempt to read/write from the advertisement and post-connect
 * probe. All fields are optional because not every model exposes every
 * signal; treat absence as "do not match on this dimension".
 */
export interface NinebotDetectionHints {
  /**
   * Lower-cased advert-name prefixes. Match is case-insensitive and
   * prefix-only (so "Ninebot_Max_5F2A" matches "ninebot" but a device
   * merely *containing* the substring does not). List the most specific
   * prefix first so longest-match resolution prefers the better entry.
   */
  namePrefixes?: readonly string[];
  /**
   * Trailing hex (no dashes, lowercase) of the 128-bit custom service
   * UUID this model advertises. The community reference's "ninebot"
   * service ends in `006e696e65626f74` (\0ninebot in ASCII). Models that
   * share the canonical Ninebot service should reuse that suffix.
   */
  serviceUuidSuffix?: string;
  /**
   * Bluetooth SIG company identifiers seen in this model's manufacturer
   * data. 0x0810 = Segway-Ninebot; some legacy Xiaomi-branded units
   * (e.g. M365 family) advertise under 0x038F instead.
   */
  manufacturerIds?: readonly number[];
  /**
   * Hardware ID byte returned by the device after a successful read of
   * register 0x12 (where supported). Authoritative — when present and
   * matching, overrides any name/UUID heuristics.
   */
  hardwareId?: number;
}

export interface NinebotModel {
  /** Stable, persisted identifier. Lowercase kebab. */
  id: string;
  /** Marketing-style display name shown in chips and headers. */
  displayName: string;
  /** Short label for cramped UI surfaces (badges, tabs). */
  shortLabel: string;
  category: NinebotCategory;
  protocol: NinebotProtocol;
  detection: NinebotDetectionHints;
  capabilities: readonly NinebotCapability[];
  /**
   * Free-text note explaining quirks the rest of the app should be aware
   * of (e.g. "auth handshake required for any read", "no GATT writes on
   * stock firmware"). Surfaced in debug UIs.
   */
  notes?: string;
}

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Common capability bundles. Pulled out so model entries stay readable.
 * Spread these into a model's `capabilities` and add/remove as needed.
 */
const READ_BASIC: readonly NinebotCapability[] = [
  "read.battery",
  "read.speed",
  "read.odometer",
  "read.mode",
  "read.temperature",
  "read.firmware-version",
  "read.serial-number",
];

const WRITE_BASIC: readonly NinebotCapability[] = [
  "write.lock",
  "write.unlock",
  "write.lights",
  "write.beep",
  "write.speed-limit",
];

const NINEBOT_SERVICE_SUFFIX = "006e696e65626f74";

export const NINEBOT_MODELS: readonly NinebotModel[] = [
  // ---- Kick scooters -----------------------------------------------------
  {
    id: "ninebot-max-g30",
    displayName: "Ninebot Max G30",
    shortLabel: "Max G30",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      namePrefixes: ["ninebot_max", "nbmax", "nb_max"],
      serviceUuidSuffix: NINEBOT_SERVICE_SUFFIX,
      manufacturerIds: [0x0810],
      hardwareId: 0x40,
    },
    capabilities: [...READ_BASIC, ...WRITE_BASIC, "write.cruise-control", "secure.firmware-update"],
    notes: "Encryption2 protocol; full register set requires auth handshake.",
  },
  {
    id: "ninebot-f-series",
    displayName: "Ninebot F-Series (F25/F30/F40)",
    shortLabel: "F-Series",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      namePrefixes: ["ninebot_f", "nbf", "nb_f"],
      serviceUuidSuffix: NINEBOT_SERVICE_SUFFIX,
      manufacturerIds: [0x0810],
    },
    capabilities: [...READ_BASIC, ...WRITE_BASIC, "secure.firmware-update"],
  },
  {
    id: "ninebot-g2",
    displayName: "Ninebot KickScooter G2",
    shortLabel: "G2",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      namePrefixes: ["ninebot_g2", "nbg2"],
      serviceUuidSuffix: NINEBOT_SERVICE_SUFFIX,
      manufacturerIds: [0x0810],
    },
    capabilities: [...READ_BASIC, ...WRITE_BASIC, "write.cruise-control", "secure.firmware-update"],
  },
  {
    id: "xiaomi-m365",
    displayName: "Xiaomi M365 (legacy)",
    shortLabel: "M365",
    category: "kick-scooter",
    protocol: "p1",
    detection: {
      namePrefixes: ["miscooter", "misc"],
      manufacturerIds: [0x038f],
    },
    capabilities: [
      "read.battery",
      "read.speed",
      "read.odometer",
      "read.mode",
      "read.firmware-version",
      "read.serial-number",
      "write.lights",
      "write.speed-limit",
    ],
    notes: "Legacy P1 framing (0x55 0xAA header); no Encryption2, weaker auth.",
  },

  // ---- Mopeds ------------------------------------------------------------
  {
    id: "segway-e125s",
    displayName: "Segway E125S",
    shortLabel: "E125S",
    category: "moped",
    protocol: "enc2",
    detection: {
      namePrefixes: ["segway_e125", "e125s"],
      serviceUuidSuffix: NINEBOT_SERVICE_SUFFIX,
      manufacturerIds: [0x0810],
    },
    capabilities: [
      ...READ_BASIC,
      "write.lock",
      "write.unlock",
      "write.lights",
      "write.beep",
      "secure.firmware-update",
    ],
    notes: "Reference device for the public Ninebot protocol documentation.",
  },

  // ---- Self-balancing / unicycles ---------------------------------------
  {
    id: "ninebot-one-z",
    displayName: "Ninebot One Z",
    shortLabel: "One Z",
    category: "unicycle",
    protocol: "p2",
    detection: {
      namePrefixes: ["ninebot_one", "nbone"],
      serviceUuidSuffix: NINEBOT_SERVICE_SUFFIX,
      manufacturerIds: [0x0810],
      hardwareId: 0x12,
    },
    capabilities: [
      "read.battery",
      "read.speed",
      "read.odometer",
      "read.temperature",
      "read.firmware-version",
      "write.beep",
      "write.lights",
      "write.speed-limit",
    ],
    notes: "Unicycle — no lock/unlock, no mode register.",
  },
  {
    id: "segway-s-pro",
    displayName: "Segway S-Pro",
    shortLabel: "S-Pro",
    category: "self-balancing",
    protocol: "p2",
    detection: {
      namePrefixes: ["segway_s", "s_pro"],
      serviceUuidSuffix: NINEBOT_SERVICE_SUFFIX,
      manufacturerIds: [0x0810],
    },
    capabilities: [
      "read.battery",
      "read.speed",
      "read.firmware-version",
      "write.lights",
      "write.beep",
      "write.speed-limit",
    ],
  },
];

/**
 * Last-resort entry returned when a device looks Ninebot-ish (the cheap
 * detector said yes) but no model rule matches. Capabilities are the
 * conservative intersection of what almost every Ninebot exposes.
 */
export const FALLBACK_MODEL: NinebotModel = {
  id: "ninebot-unknown",
  displayName: "Ninebot (unknown model)",
  shortLabel: "Ninebot",
  category: "kick-scooter",
  protocol: "p2",
  detection: {},
  capabilities: ["read.battery", "read.firmware-version", "read.serial-number"],
  notes: "No model rule matched — capabilities reflect the safe minimum.",
};

/* -------------------------------------------------------------------------- */
/* Lookup                                                                     */
/* -------------------------------------------------------------------------- */

export interface NinebotModelMatch {
  model: NinebotModel;
  /**
   * Why we picked this entry. "hardware-id" is authoritative; the others
   * are heuristic. Useful for debug UIs and unit tests.
   */
  via: "hardware-id" | "service-uuid" | "name-prefix" | "fallback";
  /** The specific value (prefix, suffix, or hw id) that matched. */
  evidence?: string;
}

/**
 * Look up a model by its stable id. Returns `null` for unknown ids so
 * callers can decide whether to fall back or treat it as a data bug.
 */
export function getNinebotModelById(id: string): NinebotModel | null {
  return NINEBOT_MODELS.find((m) => m.id === id) ?? null;
}

/**
 * Resolve a model from an advertisement (and optional post-connect
 * hardware-id read). See file header for the precedence rules; this
 * function is the single source of truth for them so the UI never
 * implements its own.
 *
 * Always returns a match — falls through to `FALLBACK_MODEL` so callers
 * can render unconditionally. If you need to know "did we actually
 * recognize this device?", check `via !== "fallback"`.
 */
export function matchNinebotModel(input: {
  name?: string | null;
  serviceUuids?: readonly string[];
  manufacturerIds?: readonly number[];
  hardwareId?: number | null;
}): NinebotModelMatch {
  // 1. Hardware ID — authoritative when we have it.
  if (input.hardwareId != null) {
    const hit = NINEBOT_MODELS.find((m) => m.detection.hardwareId === input.hardwareId);
    if (hit) {
      return { model: hit, via: "hardware-id", evidence: `0x${input.hardwareId.toString(16)}` };
    }
  }

  // 2. Service UUID suffix. We only consider models whose detection rule
  //    *also* names a name-prefix, so a generic Ninebot service alone (no
  //    distinguishing name) doesn't get incorrectly attributed to a
  //    specific model — that case should fall through to step 3 or 4.
  const flatSuffixes = (input.serviceUuids ?? []).map((u) => u.replace(/-/g, "").toLowerCase());
  const lowerName = (input.name ?? "").trim().toLowerCase();

  // 3. Longest-name-prefix match. We sort prefixes by length descending
  //    so "ninebot_max" wins over the generic "ninebot" entry would, if
  //    such overlap existed. Within a single model we still pick the
  //    first listed prefix as the evidence string (callers care which
  //    rule fired, not which alias the device happened to use).
  type Candidate = { model: NinebotModel; prefix: string };
  const nameCandidates: Candidate[] = [];
  for (const model of NINEBOT_MODELS) {
    for (const prefix of model.detection.namePrefixes ?? []) {
      if (lowerName.startsWith(prefix)) {
        nameCandidates.push({ model, prefix });
      }
    }
  }
  if (nameCandidates.length > 0) {
    nameCandidates.sort((a, b) => b.prefix.length - a.prefix.length);
    const best = nameCandidates[0];
    return { model: best.model, via: "name-prefix", evidence: best.prefix };
  }

  // 4. Service-UUID-only fallback. Lower confidence than name-prefix
  //    because the same custom service is shared across the lineup, so we
  //    can confirm "it's a Ninebot" but not which one.
  for (const model of NINEBOT_MODELS) {
    const suffix = model.detection.serviceUuidSuffix;
    if (suffix && flatSuffixes.some((s) => s.endsWith(suffix))) {
      // Don't claim a specific model from a shared suffix — only return a
      // service-uuid match when the model uniquely owns its suffix
      // (rare today, but the check keeps us honest).
      const owners = NINEBOT_MODELS.filter((m) => m.detection.serviceUuidSuffix === suffix);
      if (owners.length === 1) {
        return { model, via: "service-uuid", evidence: suffix };
      }
      break; // shared suffix → fall through to FALLBACK
    }
  }

  return { model: FALLBACK_MODEL, via: "fallback" };
}

/**
 * Convenience: does this model expose the given capability? Centralizing
 * the check lets us swap the underlying representation later (e.g. to a
 * Set) without touching call sites.
 */
export function hasCapability(model: NinebotModel, cap: NinebotCapability): boolean {
  return model.capabilities.includes(cap);
}
