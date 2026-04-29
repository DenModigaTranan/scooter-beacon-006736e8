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
 * Sourcing notes:
 *   The model table mirrors the public Segway-Ninebot BLE protocol
 *   reference at https://nootnooot.codeberg.page/segway-ninebot-ble/
 *   (which extracted device-config packages directly from the official
 *   Segway-Ninebot apps). The reference covers **66 documented devices**
 *   across 8 categories with 8,693 commands; we mirror the *catalog*
 *   here so our identification and capability gating stay in lockstep
 *   with what real hardware advertises. Hardware IDs are the values
 *   returned by the device's hardware-id register and are authoritative
 *   when we have them. Name-prefix patterns are the ones the official
 *   apps use to filter the BLE scan list (e.g. "ninebot_max", "segway_p65",
 *   "MIScooter…" for the Xiaomi-branded units).
 *
 *   When the upstream catalog lists multiple HW IDs for the same product
 *   name (typically silent hardware revisions of the same scooter — e.g.
 *   eMoped B with HW IDs 73 and 86), we keep separate entries so an
 *   authoritative HW-ID match is never ambiguous; their `id` slugs carry
 *   a `-rN` suffix to distinguish revisions.
 *
 * Detection precedence at call sites (single source of truth: this file):
 *   1. Exact `hardwareId` match (post-connect, authoritative).
 *   2. `serviceUuidSuffix` match (pre-connect, very strong — the custom
 *      Ninebot service UUID literally encodes "ninebot" in ASCII).
 *   3. `namePrefixes` longest-match (pre-connect, heuristic but cheap).
 *   4. Fall through to `FALLBACK_MODEL` so the UI always has *some* entry
 *      to render rather than a null state.
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
  | "power-station"
  | "armor-kit";

/**
 * Wire-format generation. Determines which frame codec + auth flow the
 * transport layer must use. We name them after the conventions used in
 * the public protocol docs:
 *   - "p1"   — legacy plaintext frames, header 0x55 0xAA (Ninebot ES era,
 *              Ninebot One/A1, S/S2/S-Max, Xiaomi M365)
 *   - "p2"   — newer plaintext frames, header 0x5A 0xA5 with XOR scrambling
 *   - "enc2" — "Encryption 2": p2 framing wrapped in AES-128-CTR with
 *              CBC-MAC, key derived via the 3-phase handshake (Max G2,
 *              GT1/GT2/GT3, ZT3, F65/G65, eMoped B/C, e-bikes…)
 *   - "enc3" — "Encryption 3": V3 auth, used on the newest 2024+ devices
 *              (SuperScooter GT3, ZT3 Pro, MAX G3, F3, E3, Power Station
 *              Cube). Identical wire format to enc2 with a different KDF.
 *   - "wifi" — OTA/WiFi gateway profile (out of scope for BLE clients)
 */
export type NinebotProtocol = "p1" | "p2" | "enc2" | "enc3" | "wifi";

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
   * prefix-only (so "Ninebot_Max_5F2A" matches "ninebot_max" but a device
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
   * the hardware-id register (where supported). Authoritative — when
   * present and matching, overrides any name/UUID heuristics. The value
   * is the integer the device reports; we use the raw integer (not hex)
   * so the upstream "HW ID 257" entries can be mirrored verbatim.
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

/** Full kick-scooter / moped capability bundle (read + write + cruise + OTA). */
const FULL_SCOOTER: readonly NinebotCapability[] = [
  ...READ_BASIC,
  ...WRITE_BASIC,
  "write.cruise-control",
  "write.ble-name",
  "secure.firmware-update",
];

/** EUC / unicycle capability bundle — no lock and no drive-mode register. */
const UNICYCLE_CAPS: readonly NinebotCapability[] = [
  "read.battery",
  "read.speed",
  "read.odometer",
  "read.temperature",
  "read.firmware-version",
  "read.serial-number",
  "write.beep",
  "write.lights",
  "write.speed-limit",
];

/** Self-balancing (S-series) — adds lock back, drops cruise. */
const SELFBALANCE_CAPS: readonly NinebotCapability[] = [
  "read.battery",
  "read.speed",
  "read.odometer",
  "read.temperature",
  "read.firmware-version",
  "read.serial-number",
  "write.lock",
  "write.unlock",
  "write.lights",
  "write.beep",
  "write.speed-limit",
];

/** Go-kart — no lock, full read set, lights/beep/OTA. */
const GOKART_CAPS: readonly NinebotCapability[] = [
  ...READ_BASIC,
  "write.lights",
  "write.beep",
  "write.speed-limit",
  "secure.firmware-update",
];

/** E-bike — adds lock + cruise on top of full read. */
const EBIKE_CAPS: readonly NinebotCapability[] = [
  ...READ_BASIC,
  "write.lock",
  "write.unlock",
  "write.lights",
  "write.beep",
  "write.cruise-control",
  "secure.firmware-update",
];

/** Power-station — only the metered reads + OTA. */
const POWER_STATION_CAPS: readonly NinebotCapability[] = [
  "read.battery",
  "read.firmware-version",
  "read.serial-number",
  "read.temperature",
  "secure.firmware-update",
];

/** Speaker — almost nothing; just identity + battery. */
const SPEAKER_CAPS: readonly NinebotCapability[] = [
  "read.battery",
  "read.firmware-version",
  "read.serial-number",
];

const NINEBOT_SERVICE_SUFFIX = "006e696e65626f74";

/**
 * Common detection hints reused by every Segway-Ninebot device that
 * advertises the canonical custom service + Bluetooth SIG company id.
 * Spread this into each model's `detection` so we have a single place to
 * fix if the company id or service shape ever changes upstream.
 */
const NB_BASE_DETECTION = {
  serviceUuidSuffix: NINEBOT_SERVICE_SUFFIX,
  manufacturerIds: [0x0810] as const,
} as const;

export const NINEBOT_MODELS: readonly NinebotModel[] = [
  /* ────────────────────────────────────────────────────────────────────
   * Kick scooters (30 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "ninebot-kickscooter-air",
    displayName: "Ninebot KickScooter Air",
    shortLabel: "Air",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_air", "nbair"],
      hardwareId: 35,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-e",
    displayName: "Ninebot KickScooter E",
    shortLabel: "E",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_e_", "ninebote"],
      hardwareId: 39,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-es",
    displayName: "Ninebot KickScooter ES (ES1/ES2/ES3/ES4)",
    shortLabel: "ES",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_es", "nbes"],
      hardwareId: 33,
    },
    capabilities: FULL_SCOOTER,
    notes: "Covers ES1/ES2/ES3/ES4 — they share HW ID 33 and protocol Proto2.",
  },
  {
    id: "ninebot-kickscooter-max",
    displayName: "Ninebot KickScooter Max (G30 family)",
    shortLabel: "Max",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_max", "nbmax", "nb_max"],
      hardwareId: 36,
    },
    capabilities: FULL_SCOOTER,
    notes: "G30 / G30D / G30LP / G30P. Mass-market kick scooter.",
  },
  {
    id: "ninebot-kickscooter-c2-pro",
    displayName: "Ninebot KickScooter C2 Pro",
    shortLabel: "C2 Pro",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_c2", "nbc2"],
      hardwareId: 124,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-d18",
    displayName: "Ninebot KickScooter D18",
    shortLabel: "D18",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_d18", "nbd18"],
      hardwareId: 116,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-d28",
    displayName: "Ninebot KickScooter D28",
    shortLabel: "D28",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_d28", "nbd28"],
      hardwareId: 114,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-d38",
    displayName: "Ninebot KickScooter D38",
    shortLabel: "D38",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_d38", "nbd38"],
      hardwareId: 115,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-e2",
    displayName: "Ninebot KickScooter E2 / E2 Plus",
    shortLabel: "E2",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_e2", "nbe2"],
      hardwareId: 125,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-f-r1",
    displayName: "Ninebot KickScooter F (rev 1)",
    shortLabel: "F r1",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_f_", "ninebot_f25", "ninebot_f30", "ninebot_f40"],
      hardwareId: 44,
    },
    capabilities: FULL_SCOOTER,
    notes: "First-gen F-series (F20/F25/F30/F40).",
  },
  {
    id: "ninebot-kickscooter-f-r2",
    displayName: "Ninebot KickScooter F (rev 2)",
    shortLabel: "F r2",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      // Same advertised name family as r1; HW ID 123 is the differentiator.
      namePrefixes: ["ninebot_f_", "ninebot_f25", "ninebot_f30", "ninebot_f40"],
      hardwareId: 123,
    },
    capabilities: FULL_SCOOTER,
    notes: "Silent hardware revision of the F-series with HW ID 123.",
  },
  {
    id: "ninebot-kickscooter-f2",
    displayName: "Ninebot KickScooter F2",
    shortLabel: "F2",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_f2_", "ninebot_f2."],
      hardwareId: 127,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-f2-plus",
    displayName: "Ninebot KickScooter F2 Plus",
    shortLabel: "F2 Plus",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_f2plus", "ninebot_f2_plus"],
      hardwareId: 128,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-f2-pro",
    displayName: "Ninebot KickScooter F2 Pro",
    shortLabel: "F2 Pro",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_f2pro", "ninebot_f2_pro"],
      hardwareId: 129,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-f65",
    displayName: "Ninebot KickScooter F65",
    shortLabel: "F65",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_f65", "nbf65"],
      hardwareId: 45,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-g65",
    displayName: "Ninebot KickScooter G65",
    shortLabel: "G65",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_g65", "nbg65"],
      hardwareId: 120,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-max-g2",
    displayName: "Ninebot KickScooter MAX G2",
    shortLabel: "Max G2",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_g2", "nbg2", "ninebot_maxg2"],
      hardwareId: 131,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-uifi-1",
    displayName: "Ninebot KickScooter UiFi 1",
    shortLabel: "UiFi 1",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_uifi1_", "ninebot_uifi_1"],
      hardwareId: 121,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-kickscooter-uifi-1-pro",
    displayName: "Ninebot KickScooter UiFi 1 Pro",
    shortLabel: "UiFi 1 Pro",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_uifi1pro", "ninebot_uifi_1_pro"],
      hardwareId: 122,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ninebot-ekickscooter-e2-pro",
    displayName: "Ninebot eKickScooter E2 Pro",
    shortLabel: "E2 Pro",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_e2pro", "ninebot_e2_pro"],
      hardwareId: 141,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-st2-pro",
    displayName: "Segway ST2 Pro",
    shortLabel: "ST2 Pro",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_st2", "st2pro"],
      hardwareId: 136,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-gt1",
    displayName: "Segway GT1",
    shortLabel: "GT1",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_gt1", "ninebot_gt1"],
      hardwareId: 112,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-gt2",
    displayName: "Segway GT2",
    shortLabel: "GT2",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_gt2", "ninebot_gt2"],
      hardwareId: 113,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-p100s",
    displayName: "Segway P100S",
    shortLabel: "P100S",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_p100s", "segway_p100"],
      hardwareId: 119,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-p65",
    displayName: "Segway P65",
    shortLabel: "P65",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_p65"],
      hardwareId: 118,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-superscooter-gt3",
    displayName: "Segway SuperScooter GT3",
    shortLabel: "GT3",
    category: "kick-scooter",
    protocol: "enc3",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_gt3", "supergt3", "ninebot_gt3"],
      hardwareId: 257,
    },
    capabilities: FULL_SCOOTER,
    notes: "2024+ flagship. Uses Encryption3 (V3 auth).",
  },
  {
    id: "segway-zt3-pro",
    displayName: "Segway ZT3 Pro",
    shortLabel: "ZT3 Pro",
    category: "kick-scooter",
    protocol: "enc3",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_zt3", "zt3pro"],
      hardwareId: 256,
    },
    capabilities: FULL_SCOOTER,
    notes: "Off-road / all-terrain. Encryption3 (V3 auth).",
  },
  {
    id: "segway-ekickscooter-max-g3",
    displayName: "Segway eKickScooter Ninebot MAX G3 / G3 Plus",
    shortLabel: "Max G3",
    category: "kick-scooter",
    protocol: "enc3",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_g3", "nbg3", "ninebot_maxg3", "segway_g3"],
      hardwareId: 258,
    },
    capabilities: FULL_SCOOTER,
    notes: "Successor to the G2 line. Encryption3 (V3 auth).",
  },
  {
    id: "ekickscooter-e3-series",
    displayName: "eKickScooter E3 Series",
    shortLabel: "E3",
    category: "kick-scooter",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_e3", "nbe3"],
      hardwareId: 261,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "ekickscooter-f3",
    displayName: "eKickScooter F3",
    shortLabel: "F3",
    category: "kick-scooter",
    protocol: "enc3",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_f3", "nbf3"],
      hardwareId: 259,
    },
    capabilities: FULL_SCOOTER,
    notes: "F-series 2024 refresh. Encryption3 (V3 auth).",
  },

  /* ────────────────────────────────────────────────────────────────────
   * Mopeds & Motorcycles (6 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "segway-e150s-e250s",
    displayName: "Segway E150S / E250S",
    shortLabel: "E150S/E250S",
    category: "moped",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_e150", "segway_e250", "e125s", "segway_e125"],
      hardwareId: 4102,
    },
    capabilities: FULL_SCOOTER,
    notes: "Reference device for the public Ninebot protocol documentation (verified against E125S, same family).",
  },
  {
    id: "segway-emoped-b-r1",
    displayName: "Segway eMoped B (rev 1)",
    shortLabel: "eMoped B r1",
    category: "moped",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_b", "ninebot_b", "emopedb"],
      hardwareId: 73,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-emoped-b-r2",
    displayName: "Segway eMoped B (rev 2)",
    shortLabel: "eMoped B r2",
    category: "moped",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_b", "ninebot_b", "emopedb"],
      hardwareId: 86,
    },
    capabilities: FULL_SCOOTER,
    notes: "Hardware revision of the eMoped B sharing the same advertised name.",
  },
  {
    id: "segway-emoped-c",
    displayName: "Segway eMoped C",
    shortLabel: "eMoped C",
    category: "moped",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_c", "ninebot_c", "emopedc"],
      hardwareId: 67,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-escooter-e",
    displayName: "Segway eScooter E",
    shortLabel: "eScooter E",
    category: "moped",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_escooter_e", "segway_e_"],
      hardwareId: 66,
    },
    capabilities: FULL_SCOOTER,
  },
  {
    id: "segway-escooter-n",
    displayName: "Segway eScooter N",
    shortLabel: "eScooter N",
    category: "moped",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_escooter_n", "segway_n_"],
      hardwareId: 89,
    },
    capabilities: FULL_SCOOTER,
  },

  /* ────────────────────────────────────────────────────────────────────
   * Self-balancing (9 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "ninebot-s",
    displayName: "Ninebot-S",
    shortLabel: "S",
    category: "self-balancing",
    protocol: "p1",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_s_", "ninebot-s"],
      hardwareId: 3,
    },
    capabilities: SELFBALANCE_CAPS,
  },
  {
    id: "ninebot-s-plus",
    displayName: "Ninebot S-Plus",
    shortLabel: "S-Plus",
    category: "self-balancing",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_splus", "ninebot_s_plus"],
      hardwareId: 20,
    },
    capabilities: SELFBALANCE_CAPS,
  },
  {
    id: "ninebot-s-2",
    displayName: "Ninebot S 2",
    shortLabel: "S 2",
    category: "self-balancing",
    protocol: "p1",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_s2", "ninebot_s_2"],
      hardwareId: 30,
    },
    capabilities: SELFBALANCE_CAPS,
  },
  {
    id: "ninebot-s-l",
    displayName: "Ninebot S L",
    shortLabel: "S L",
    category: "self-balancing",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_sl", "ninebot_s_l"],
      hardwareId: 28,
    },
    capabilities: SELFBALANCE_CAPS,
  },
  {
    id: "ninebot-s-nano-r1",
    displayName: "Ninebot S Nano (rev 1)",
    shortLabel: "S Nano r1",
    category: "self-balancing",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_snano", "ninebot_s_nano"],
      hardwareId: 25,
    },
    capabilities: SELFBALANCE_CAPS,
  },
  {
    id: "ninebot-s-nano-r2",
    displayName: "Ninebot S Nano (rev 2)",
    shortLabel: "S Nano r2",
    category: "self-balancing",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_snano", "ninebot_s_nano"],
      hardwareId: 27,
    },
    capabilities: SELFBALANCE_CAPS,
  },
  {
    id: "ninebot-s-max-r1",
    displayName: "Ninebot S-Max (rev 1)",
    shortLabel: "S-Max r1",
    category: "self-balancing",
    protocol: "p1",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_smax", "ninebot_s_max"],
      hardwareId: 24,
    },
    capabilities: SELFBALANCE_CAPS,
  },
  {
    id: "ninebot-s-max-r2",
    displayName: "Ninebot S-Max (rev 2)",
    shortLabel: "S-Max r2",
    category: "self-balancing",
    protocol: "p1",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_smax", "ninebot_s_max"],
      hardwareId: 26,
    },
    capabilities: SELFBALANCE_CAPS,
  },
  {
    id: "segway-minilite",
    displayName: "Segway miniLITE",
    shortLabel: "miniLITE",
    category: "self-balancing",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_minilite", "minilite"],
      hardwareId: 22,
    },
    capabilities: SELFBALANCE_CAPS,
  },

  /* ────────────────────────────────────────────────────────────────────
   * Go-karts (7 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "ninebot-gokart",
    displayName: "Ninebot Gokart",
    shortLabel: "Gokart",
    category: "go-kart",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_gokart", "nbgokart"],
      hardwareId: 48,
    },
    capabilities: GOKART_CAPS,
  },
  {
    id: "ninebot-gokart-pro",
    displayName: "Ninebot Gokart Pro",
    shortLabel: "Gokart Pro",
    category: "go-kart",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_gokartpro", "ninebot_gokart_pro"],
      hardwareId: 49,
    },
    capabilities: GOKART_CAPS,
  },
  {
    id: "ninebot-gokart-pro-lambo",
    displayName: "Ninebot Gokart Pro Lamborghini Edition",
    shortLabel: "Gokart Lambo",
    category: "go-kart",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_gokart_lambo", "ninebot_lambo"],
      hardwareId: 50,
    },
    capabilities: GOKART_CAPS,
  },
  {
    id: "segway-gokart-pro-bumblebee",
    displayName: "Segway Gokart Pro Bumblebee Limited Edition",
    shortLabel: "Gokart Bumblebee",
    category: "go-kart",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_bumblebee", "gokart_bumblebee"],
      hardwareId: 54,
    },
    capabilities: GOKART_CAPS,
  },
  {
    id: "segway-gokart-pro-optimus",
    displayName: "Segway Gokart Pro Optimus Prime Limited Edition",
    shortLabel: "Gokart Optimus",
    category: "go-kart",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_optimus", "gokart_optimus"],
      hardwareId: 55,
    },
    capabilities: GOKART_CAPS,
  },
  {
    id: "segway-gokart-pro-2",
    displayName: "Segway Gokart Pro 2",
    shortLabel: "Gokart Pro 2",
    category: "go-kart",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_gokartpro2", "segway_gokart_pro_2"],
      hardwareId: 56,
    },
    capabilities: GOKART_CAPS,
  },
  {
    id: "segway-gokart-kit-2",
    displayName: "Segway Gokart Kit 2",
    shortLabel: "Gokart Kit 2",
    category: "go-kart",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_gokartkit2", "segway_gokart_kit_2"],
      hardwareId: 57,
    },
    capabilities: GOKART_CAPS,
  },

  /* ────────────────────────────────────────────────────────────────────
   * Unicycles (3 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "ninebot-one",
    displayName: "Ninebot One",
    shortLabel: "One",
    category: "unicycle",
    protocol: "p1",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_one_", "nbone"],
      hardwareId: 2,
    },
    capabilities: UNICYCLE_CAPS,
  },
  {
    id: "ninebot-one-a1",
    displayName: "Ninebot One A1",
    shortLabel: "One A1",
    category: "unicycle",
    protocol: "p1",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_one_a1", "ninebot_a1"],
      hardwareId: 19,
    },
    capabilities: UNICYCLE_CAPS,
  },
  {
    id: "ninebot-one-z",
    displayName: "Ninebot One Z",
    shortLabel: "One Z",
    category: "unicycle",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_one_z", "ninebot_z10", "nbz10"],
      hardwareId: 18,
    },
    capabilities: UNICYCLE_CAPS,
  },

  /* ────────────────────────────────────────────────────────────────────
   * E-bikes (4 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "segway-ebike-muxi",
    displayName: "Segway E-bike Muxi",
    shortLabel: "Muxi",
    category: "e-bike",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_muxi", "muxi"],
      hardwareId: 17153,
    },
    capabilities: EBIKE_CAPS,
  },
  {
    id: "segway-ebike-myon",
    displayName: "Segway E-bike Myon",
    shortLabel: "Myon",
    category: "e-bike",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_myon", "myon"],
      hardwareId: 16384,
    },
    capabilities: EBIKE_CAPS,
  },
  {
    id: "segway-xyber",
    displayName: "Segway Xyber",
    shortLabel: "Xyber",
    category: "e-bike",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_xyber", "xyber"],
      hardwareId: 17152,
    },
    capabilities: EBIKE_CAPS,
  },
  {
    id: "segway-xafari",
    displayName: "Xafari",
    shortLabel: "Xafari",
    category: "e-bike",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["xafari", "segway_xafari"],
      hardwareId: 16640,
    },
    capabilities: EBIKE_CAPS,
  },

  /* ────────────────────────────────────────────────────────────────────
   * Speakers (3 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "ninebot-engine-speaker",
    displayName: "Ninebot Engine Speaker",
    shortLabel: "Engine Spk",
    category: "speaker",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_speaker", "engine_speaker"],
      hardwareId: 242,
    },
    capabilities: SPEAKER_CAPS,
  },
  {
    id: "segway-ninebot-engine-speaker-2",
    displayName: "Segway-Ninebot Engine Speaker 2",
    shortLabel: "Engine Spk 2",
    category: "speaker",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_speaker2", "engine_speaker2"],
      hardwareId: 244,
    },
    capabilities: SPEAKER_CAPS,
  },
  {
    id: "ninebot-engine-speaker-2-cn",
    displayName: "Ninebot Engine Speaker II (CN)",
    shortLabel: "九号引擎音箱II",
    category: "speaker",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_yyx", "yyx_2"],
      hardwareId: 17410,
    },
    capabilities: SPEAKER_CAPS,
    notes: "Mainland China SKU of the Engine Speaker II.",
  },

  /* ────────────────────────────────────────────────────────────────────
   * Power stations (2 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "lumina-500",
    displayName: "Lumina-500",
    shortLabel: "Lumina-500",
    category: "power-station",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["lumina", "lumina500"],
      hardwareId: 10752,
    },
    capabilities: POWER_STATION_CAPS,
  },
  {
    id: "segway-power-station-cube",
    displayName: "Segway Portable Power Station Cube",
    shortLabel: "Cube PSU",
    category: "power-station",
    protocol: "enc2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["segway_cube", "cube_pps"],
      hardwareId: 208,
    },
    capabilities: POWER_STATION_CAPS,
  },

  /* ────────────────────────────────────────────────────────────────────
   * Armor kits (2 devices).
   * ──────────────────────────────────────────────────────────────────── */
  {
    id: "ninebot-mecha-kit-r1",
    displayName: "Ninebot Mecha Kit (rev 1)",
    shortLabel: "Mecha r1",
    category: "armor-kit",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_mecha", "mecha_kit"],
      hardwareId: 51,
    },
    capabilities: [
      "read.battery",
      "read.firmware-version",
      "read.serial-number",
      "write.lights",
      "write.beep",
      "secure.firmware-update",
    ],
  },
  {
    id: "ninebot-mecha-kit-r2",
    displayName: "Ninebot Mecha Kit (rev 2)",
    shortLabel: "Mecha r2",
    category: "armor-kit",
    protocol: "p2",
    detection: {
      ...NB_BASE_DETECTION,
      namePrefixes: ["ninebot_mecha", "mecha_kit"],
      hardwareId: 52,
    },
    capabilities: [
      "read.battery",
      "read.firmware-version",
      "read.serial-number",
      "write.lights",
      "write.beep",
      "secure.firmware-update",
    ],
  },

  /* ────────────────────────────────────────────────────────────────────
   * Xiaomi-branded units (legacy P1/P3/P4 family — Mi Home app).
   *
   * These don't appear in the Segway-Ninebot HW-ID catalog because they
   * speak the older Xiaomi protocols, but the user-visible "Scooter
   * Beacon" registry needs to recognise them so a generic BLE scan can
   * still tag and gate them. They advertise under Xiaomi's company ID
   * 0x038F with a "MIScooter…" / "MISC…" / "MIMax…" / "Mi3…" / "Mi4…"
   * name prefix and do NOT expose the Ninebot custom service UUID, so
   * no `serviceUuidSuffix` here.
   * ──────────────────────────────────────────────────────────────────── */
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
  {
    id: "xiaomi-pro",
    displayName: "Xiaomi Mi Pro / Pro 2",
    shortLabel: "Mi Pro",
    category: "kick-scooter",
    protocol: "p1",
    detection: {
      namePrefixes: ["mipro", "miscooterpro", "miscpro"],
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
  },
  {
    id: "xiaomi-1s",
    displayName: "Xiaomi Mi 1S",
    shortLabel: "Mi 1S",
    category: "kick-scooter",
    protocol: "p1",
    detection: {
      namePrefixes: ["mi1s", "mi_1s"],
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
  },
  {
    id: "xiaomi-essential",
    displayName: "Xiaomi Mi Essential",
    shortLabel: "Mi Essential",
    category: "kick-scooter",
    protocol: "p1",
    detection: {
      namePrefixes: ["miessential", "mi_essential"],
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
  },
  {
    id: "xiaomi-mi3",
    displayName: "Xiaomi Mi Electric Scooter 3",
    shortLabel: "Mi 3",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      namePrefixes: ["mi3", "miscooter3", "mi_3"],
      manufacturerIds: [0x038f],
    },
    capabilities: [
      "read.battery",
      "read.speed",
      "read.odometer",
      "read.mode",
      "read.firmware-version",
      "read.serial-number",
      "write.lock",
      "write.unlock",
      "write.lights",
      "write.speed-limit",
    ],
    notes: "First Xiaomi gen with full P3 encrypted protocol (Mi Home app).",
  },
  {
    id: "xiaomi-mi4",
    displayName: "Xiaomi Mi Electric Scooter 4 (incl. Pro / Lite / Ultra)",
    shortLabel: "Mi 4",
    category: "kick-scooter",
    protocol: "enc2",
    detection: {
      namePrefixes: ["mi4", "miscooter4", "mi_4"],
      manufacturerIds: [0x038f],
    },
    capabilities: [
      "read.battery",
      "read.speed",
      "read.odometer",
      "read.mode",
      "read.firmware-version",
      "read.serial-number",
      "write.lock",
      "write.unlock",
      "write.lights",
      "write.speed-limit",
      "write.cruise-control",
    ],
    notes: "P4 encrypted protocol. Covers Mi 4, Mi 4 Pro, Mi 4 Lite, Mi 4 Ultra.",
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
  // 1. Hardware ID — authoritative when we have it. With the catalog
  //    expanded to mirror the upstream registry we can have multiple
  //    models share an id (silent hardware revisions); pick the first
  //    listed match deterministically so the result is stable.
  if (input.hardwareId != null) {
    const hit = NINEBOT_MODELS.find((m) => m.detection.hardwareId === input.hardwareId);
    if (hit) {
      return { model: hit, via: "hardware-id", evidence: `${input.hardwareId} (0x${input.hardwareId.toString(16)})` };
    }
  }

  const flatSuffixes = (input.serviceUuids ?? []).map((u) => u.replace(/-/g, "").toLowerCase());
  const lowerName = (input.name ?? "").trim().toLowerCase();

  // 2. Longest-name-prefix match. We sort prefixes by length descending
  //    so "ninebot_max_g2" wins over the generic "ninebot_max" entry
  //    when both could match. Within a single model we still pick the
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

  // 3. Service-UUID-only fallback. Lower confidence than name-prefix
  //    because the same custom service is shared across the lineup, so we
  //    can confirm "it's a Ninebot" but not which one. Only fires for
  //    models that uniquely own their suffix (effectively never today,
  //    since the canonical Ninebot suffix is shared); kept for
  //    forward-compatibility if a model ever lands its own custom UUID.
  for (const model of NINEBOT_MODELS) {
    const suffix = model.detection.serviceUuidSuffix;
    if (suffix && flatSuffixes.some((s) => s.endsWith(suffix))) {
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
