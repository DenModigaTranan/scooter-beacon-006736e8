/**
 * Scooter hardware reference registry — BMS packs and motherboards (ESCs).
 *
 * Purpose
 * -------
 * Companion to `src/lib/ninebot-models.ts` and `src/lib/m365/models.ts`.
 * Where those describe *whole vehicles* (the marketing SKU you see on the
 * box), this file describes the **two subsystems Scooter Beacon actually
 * talks to or reads firmware off of**:
 *
 *   1. BMS — the battery management board. Its own MCU, its own firmware
 *      (the "BMS" target in the firmware catalog), and its own serial,
 *      cycle counter, and health stats reachable via reg 0x40+ on the
 *      M365 protocol and the corresponding Ninebot register window.
 *   2. Motherboard / ESC — the main controller. Holds the drive (DRV)
 *      firmware, the speed/throttle curves, the model board id (used by
 *      `decodeModelId()`), and on Ninebot devices the auth handshake.
 *
 * This data is purely descriptive (no I/O happens here). The transport
 * layer uses these tables to:
 *   • Recognize which BMS pack is installed once the BMS serial / hw rev
 *     bytes have been read, so the UI can show "47R 7.65 Ah · cell config
 *     10S3P · LG MH1" instead of an opaque ID.
 *   • Recognize which motherboard revision a scooter ships with based on
 *     its board id / BLE module identifier so we can warn before flashing
 *     a DRV image targeted at a different revision.
 *
 * Sourcing
 * --------
 * Values are aggregated from publicly available community references:
 *   • scooterhacking.org device/board id databases
 *   • m365-st-link / m365-firmware-patcher source trees
 *   • segway-ninebot-ble protocol reference (nootnooot.codeberg.page)
 *   • Xiaomi Mi Home / Segway-Ninebot stock app device-config bundles
 *
 * Where multiple silent revisions of the same physical board exist
 * (e.g. M365 v1.3 vs v1.4 motherboards), we emit a separate entry so a
 * `boardId` match is always unambiguous; the slug carries a `-rN` suffix.
 *
 * Stability
 * ---------
 * `id` is a stable identifier safe to persist (e.g. into per-device user
 * prefs or telemetry). Display labels and the `compatibleScooterIds`
 * arrays may grow without breaking persisted data.
 */

/* -------------------------------------------------------------------------- */
/* Shared types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Which scooter protocol family this hardware belongs to. Drives which
 * register window we read its identifiers from and which firmware target
 * channel applies (M365 BMS != Ninebot BMS even when cells look similar).
 */
export type ScooterHardwareFamily =
  | "xiaomi-m365"   // M365 / 1S / Pro / Pro 2 / Essential / Mi3 (legacy proto)
  | "xiaomi-mi"     // Mi 4 family (Pro2 successor — newer BLE module)
  | "ninebot-es"    // Ninebot ES1/ES2/ES3/ES4
  | "ninebot-max"   // G30 family + Max G2/G3
  | "ninebot-f"     // F-series (F20…F65, F2 family)
  | "ninebot-e"     // E22/E25/E45 + Es
  | "ninebot-g"     // GT1/GT2/GT3 super-scooters
  | "ninebot-d"     // D-series
  // ── Other brands (proprietary protocols; we surface reference data only) ──
  | "inokim"        // Inokim Light/Quick/OX/OXO
  | "dualtron"      // Minimotors Dualtron / EY3 / Mini-Motors apps
  | "kaabo"         // Kaabo Mantis / Wolf / Skywalker
  | "apollo"        // Apollo City / Air / Phantom / Pro / Ghost
  | "unagi"         // Unagi Model One / Voyager
  | "bird"          // Bird One / Air / Bird Three (consumer)
  | "lime"          // Lime Gen3/Gen4 (rideshare; reference only)
  | "razor"         // Razor E-series / EcoSmart / C-series
  | "gotrax"        // Gotrax GXL / G4 / G6 / XR Elite
  | "hiboy"         // Hiboy S2 / Max / Titan
  | "turboant"      // Turboant X7 / V8 / M10
  | "nanrobot"      // Nanrobot D6+ / LS7 / RS11
  | "vsett"         // VSETT 8 / 9 / 10 / 11+
  | "zero"          // Zero 8/9/10X/11X (Ecorider OEM)
  | "emove"         // Voro Motors EMOVE Cruiser / Touring / RoadRunner
  | "fluidfreeride" // Fluid Freeride Mantis / Horizon (Kaabo rebadge)
  | "okai"          // OKAI ES10 / ES20 / ES400 / Beetle / Neon
  | "joyor"         // Joyor S5/S8/S10/Y-series
  | "iscooter"      // iScooter i9 / i10 / iX4 / iX5
  | "pure"          // Pure Air / Air Pro / Advance
  | "augment"       // Augment / NIU KQi family (NIU electric kick scooters)
  | "yadea"         // Yadea KS5 / KS6 Pro / ElitePrime
  | "atomi"         // Atomi Alpha / X / X Pro
  | "levy"          // Levy Original / Plus
  | "evolv"         // EVOLV Pro / Tour / Stride
  | "speedway"      // Minimotors Speedway 4/5
  | "cityblitz"     // CityBlitz CB016 / CB064 (EU clones)
  | "egret"         // Egret Ten / Pro / X+
  | "wegoboard"     // Wegoboard Suprem 3.0 / Slash 1700
  | "yume"          // Yume Y10 / X11 / X13
  | "currus"        // Currus NF10 / Panther
  | "varla"         // Varla Eagle One / Pegasus / Falcon
  | "smacircle"     // Smacircle / generic foldables
  | "clone";        // M365-compatible third-party boards

/** Confidence level for community-sourced data we mirror here. */
export type DataConfidence =
  | "documented"     // Multiple independent sources agree (e.g. SH wiki + app bundles)
  | "community"      // Reported by community teardowns; high but not cross-checked
  | "inferred";      // Derived from related models; treat as a starting point

/* -------------------------------------------------------------------------- */
/* BMS                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Cell chemistry. Almost everything in this lineup is Li-ion 18650 or
 * 21700; a few late-model packs use LFP. We surface this so the UI can
 * pick a colour cue and warn about charging behaviour.
 */
export type BmsChemistry = "li-ion-18650" | "li-ion-21700" | "lfp" | "li-po";

export interface BmsModule {
  /** Stable, persisted identifier. Lowercase kebab. */
  id: string;
  /** Display label shown in info panels and chips. */
  displayName: string;
  /** Short label for cramped UI surfaces. */
  shortLabel: string;
  family: ScooterHardwareFamily;
  /**
   * Nominal cell configuration, e.g. "10S3P". Always reported the way the
   * stock app shows it so users can cross-reference with vendor docs.
   */
  cellConfig: string;
  chemistry: BmsChemistry;
  /** Nominal pack voltage in volts. */
  nominalVoltageV: number;
  /** Rated pack capacity in Ah. */
  capacityAh: number;
  /** Rated pack energy in Wh (approximately = V × Ah). */
  energyWh: number;
  /**
   * 16-bit board id reported by the BMS over BLE (when known). This is
   * the value `decodeModelId()` returns when the board id is read from
   * the BMS register window. Authoritative when present.
   */
  boardId?: number;
  /**
   * Free-text marker pattern seen at the start of the BMS serial. The
   * stock Mi Home / Segway apps use these prefixes to fingerprint the
   * pack manufacturer + cell vendor, e.g. "PI" → Pisen-built LG MH1
   * pack used on early M365.
   */
  serialPrefixes?: readonly string[];
  /**
   * Cell vendor (when documented). Helpful for capacity-vs-cycle-life
   * expectations the UI can surface in the BMS health panel.
   */
  cellVendor?: string;
  /** Slugs from `SCOOTER_MODELS` / `NINEBOT_MODELS` that ship this pack. */
  compatibleScooterIds: readonly string[];
  /** How well-sourced the values above are. */
  confidence: DataConfidence;
  /** Free-text quirks worth surfacing in debug UIs. */
  notes?: string;
}

/**
 * Public catalog of BMS packs known to talk the M365 / Ninebot register
 * protocols. Order is rough chronological per family for easier diffing.
 */
export const BMS_MODULES: readonly BmsModule[] = [
  // ── Xiaomi M365 family ───────────────────────────────────────────────────
  {
    id: "bms-m365-pi-7p65",
    displayName: "M365 stock 7.65 Ah pack (Pisen / LG MH1)",
    shortLabel: "M365 7.65Ah",
    family: "xiaomi-m365",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 7.65,
    energyWh: 280,
    boardId: 0x0101,
    serialPrefixes: ["PI", "21678"],
    cellVendor: "LG MH1",
    compatibleScooterIds: ["m365"],
    confidence: "documented",
    notes: "Original M365 pack. ~280 Wh, 30A discharge, 30 km range claimed.",
  },
  {
    id: "bms-m365-tianneng-7p8",
    displayName: "M365 stock 7.8 Ah pack (Tianneng)",
    shortLabel: "M365 7.8Ah",
    family: "xiaomi-m365",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 7.8,
    energyWh: 280,
    boardId: 0x0102,
    serialPrefixes: ["TN"],
    cellVendor: "Tianneng / mixed",
    compatibleScooterIds: ["m365"],
    confidence: "documented",
    notes: "Later M365 production run with Tianneng cells; identical chassis.",
  },
  {
    id: "bms-1s-7p65",
    displayName: "Mi 1S stock 7.65 Ah pack",
    shortLabel: "1S 7.65Ah",
    family: "xiaomi-m365",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 7.65,
    energyWh: 275,
    boardId: 0x0103,
    serialPrefixes: ["1S"],
    cellVendor: "LG / Samsung mixed",
    compatibleScooterIds: ["1s", "essential"],
    confidence: "documented",
    notes: "1S and Essential share the chassis; Essential pack is downrated.",
  },
  {
    id: "bms-essential-5p1",
    displayName: "Mi Essential 5.1 Ah pack",
    shortLabel: "Essential 5.1Ah",
    family: "xiaomi-m365",
    cellConfig: "10S2P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 5.1,
    energyWh: 184,
    boardId: 0x0104,
    serialPrefixes: ["ES"],
    cellVendor: "LG MH1",
    compatibleScooterIds: ["essential"],
    confidence: "documented",
    notes: "20-cell pack; ~20 km range. Same BMS register layout as M365.",
  },
  {
    id: "bms-pro-12p8",
    displayName: "M365 Pro 12.8 Ah pack",
    shortLabel: "Pro 12.8Ah",
    family: "xiaomi-m365",
    cellConfig: "10S4P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 12.8,
    energyWh: 474,
    boardId: 0x0201,
    serialPrefixes: ["PR", "PRO"],
    cellVendor: "LG M26",
    compatibleScooterIds: ["m365-pro"],
    confidence: "documented",
    notes: "First Pro-series pack; ~45 km claimed range.",
  },
  {
    id: "bms-pro2-12p8",
    displayName: "Mi Pro 2 12.8 Ah pack",
    shortLabel: "Pro2 12.8Ah",
    family: "xiaomi-m365",
    cellConfig: "10S4P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 12.8,
    energyWh: 474,
    boardId: 0x0202,
    serialPrefixes: ["P2"],
    cellVendor: "LG M26 / Samsung 26F mixed",
    compatibleScooterIds: ["pro2"],
    confidence: "documented",
  },
  {
    id: "bms-mi3-7p65",
    displayName: "Mi Scooter 3 7.65 Ah pack",
    shortLabel: "Mi3 7.65Ah",
    family: "xiaomi-m365",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 7.65,
    energyWh: 275,
    boardId: 0x0301,
    serialPrefixes: ["M3"],
    cellVendor: "Mixed",
    compatibleScooterIds: ["mi3", "mi3-lite"],
    confidence: "documented",
  },
  {
    id: "bms-mi4-9p6",
    displayName: "Mi Scooter 4 9.6 Ah pack",
    shortLabel: "Mi4 9.6Ah",
    family: "xiaomi-mi",
    cellConfig: "10S3P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 36,
    capacityAh: 9.6,
    energyWh: 346,
    boardId: 0x0401,
    serialPrefixes: ["M4"],
    cellVendor: "EVE / Lishen 21700",
    compatibleScooterIds: ["mi4", "mi4-lite"],
    confidence: "community",
  },
  {
    id: "bms-mi4-pro-12p8",
    displayName: "Mi Scooter 4 Pro 12.8 Ah pack",
    shortLabel: "Mi4 Pro 12.8Ah",
    family: "xiaomi-mi",
    cellConfig: "10S4P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 36,
    capacityAh: 12.8,
    energyWh: 461,
    boardId: 0x0402,
    serialPrefixes: ["M4P"],
    cellVendor: "EVE 21700",
    compatibleScooterIds: ["mi4-pro"],
    confidence: "community",
  },
  {
    id: "bms-mi4-ultra-15p3",
    displayName: "Mi Scooter 4 Ultra 15.3 Ah pack",
    shortLabel: "Mi4 Ultra 15.3Ah",
    family: "xiaomi-mi",
    cellConfig: "12S3P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 43.2,
    capacityAh: 15.3,
    energyWh: 661,
    boardId: 0x0403,
    serialPrefixes: ["M4U"],
    cellVendor: "EVE 21700",
    compatibleScooterIds: ["mi4-ultra"],
    confidence: "community",
    notes: "Higher-voltage pack; 12S architecture. Charger uses 54.6 V CC/CV.",
  },

  // ── Ninebot ES family ────────────────────────────────────────────────────
  {
    id: "bms-ninebot-es-internal",
    displayName: "Ninebot ES internal 5.2 Ah pack",
    shortLabel: "ES 5.2Ah",
    family: "ninebot-es",
    cellConfig: "10S2P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 5.2,
    energyWh: 187,
    boardId: 0x0501,
    serialPrefixes: ["NES"],
    cellVendor: "LG / Samsung mixed",
    compatibleScooterIds: ["es1", "es2", "es3", "es4", "ninebot-kickscooter-es"],
    confidence: "documented",
    notes: "Built-in pack on ES1–ES4. ES2/ES4 can chain a second external pack.",
  },
  {
    id: "bms-ninebot-es-external",
    displayName: "Ninebot ES external add-on pack",
    shortLabel: "ES ext",
    family: "ninebot-es",
    cellConfig: "10S2P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 5.2,
    energyWh: 187,
    boardId: 0x0502,
    serialPrefixes: ["NEX"],
    compatibleScooterIds: ["es2", "es4", "ninebot-kickscooter-es"],
    confidence: "documented",
    notes: "Optional second pack; doubles range. Reports a separate BMS over BLE.",
  },

  // ── Ninebot Max / G family ───────────────────────────────────────────────
  {
    id: "bms-max-g30-15p3",
    displayName: "Ninebot Max G30 / G30D 15.3 Ah pack",
    shortLabel: "G30 15.3Ah",
    family: "ninebot-max",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 15.3,
    energyWh: 551,
    boardId: 0x0601,
    serialPrefixes: ["G30"],
    cellVendor: "LG MJ1",
    compatibleScooterIds: ["max-g30", "max-g30d", "max-g30p", "ninebot-kickscooter-max"],
    confidence: "documented",
    notes: "Iconic high-capacity pack — community favourite for range mods.",
  },
  {
    id: "bms-max-g30lp-7p65",
    displayName: "Ninebot Max G30LP 7.65 Ah pack",
    shortLabel: "G30LP 7.65Ah",
    family: "ninebot-max",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 7.65,
    energyWh: 275,
    boardId: 0x0602,
    serialPrefixes: ["GLP"],
    compatibleScooterIds: ["max-g30lp"],
    confidence: "documented",
    notes: "Half-capacity LP variant for markets where >280Wh is restricted.",
  },
  {
    id: "bms-max-g2-18p2",
    displayName: "Ninebot Max G2 18.2 Ah pack",
    shortLabel: "G2 18.2Ah",
    family: "ninebot-max",
    cellConfig: "13S3P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 46.8,
    capacityAh: 18.2,
    energyWh: 851,
    boardId: 0x0603,
    serialPrefixes: ["G2"],
    cellVendor: "LG / EVE 21700",
    compatibleScooterIds: ["max-g2", "ninebot-kickscooter-max-g2"],
    confidence: "community",
    notes: "13S architecture; encrypted (enc2) BMS — values gated on auth.",
  },
  {
    id: "bms-gt1-21p4",
    displayName: "Ninebot GT1 21.4 Ah pack",
    shortLabel: "GT1 21.4Ah",
    family: "ninebot-g",
    cellConfig: "20S2P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 72,
    capacityAh: 21.4,
    energyWh: 1540,
    boardId: 0x0701,
    serialPrefixes: ["GT1"],
    compatibleScooterIds: ["gt1"],
    confidence: "community",
    notes: "Super-scooter class. 72 V architecture, encrypted protocol.",
  },
  {
    id: "bms-gt2-32p4",
    displayName: "Ninebot GT2 32.4 Ah pack",
    shortLabel: "GT2 32.4Ah",
    family: "ninebot-g",
    cellConfig: "20S3P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 72,
    capacityAh: 32.4,
    energyWh: 2333,
    boardId: 0x0702,
    serialPrefixes: ["GT2"],
    compatibleScooterIds: ["gt2"],
    confidence: "community",
    notes: "Dual-motor flagship. 60 km claimed range, encrypted BMS.",
  },

  // ── Ninebot F series ─────────────────────────────────────────────────────
  {
    id: "bms-f-r1-7p65",
    displayName: "Ninebot F20/F25/F30/F40 7.65 Ah pack",
    shortLabel: "F r1 7.65Ah",
    family: "ninebot-f",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 7.65,
    energyWh: 275,
    boardId: 0x0801,
    serialPrefixes: ["F20", "F25", "F30", "F40"],
    compatibleScooterIds: ["f20", "f25", "f30", "f40", "ninebot-kickscooter-f-r1", "ninebot-kickscooter-f-r2"],
    confidence: "documented",
    notes: "Capacity is shared across F20/F25/F30/F40 — only motor differs.",
  },
  {
    id: "bms-f2-10p2",
    displayName: "Ninebot F2 / F2 Plus 10.2 Ah pack",
    shortLabel: "F2 10.2Ah",
    family: "ninebot-f",
    cellConfig: "10S3P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 36,
    capacityAh: 10.2,
    energyWh: 367,
    boardId: 0x0802,
    serialPrefixes: ["F2"],
    compatibleScooterIds: ["f2", "f2-plus", "ninebot-kickscooter-f2", "ninebot-kickscooter-f2-plus"],
    confidence: "community",
  },
  {
    id: "bms-f2-pro-12p8",
    displayName: "Ninebot F2 Pro 12.8 Ah pack",
    shortLabel: "F2 Pro 12.8Ah",
    family: "ninebot-f",
    cellConfig: "10S4P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 36,
    capacityAh: 12.8,
    energyWh: 461,
    boardId: 0x0803,
    serialPrefixes: ["F2P"],
    compatibleScooterIds: ["f2-pro", "ninebot-kickscooter-f2-pro"],
    confidence: "community",
  },
  {
    id: "bms-f65-21p",
    displayName: "Ninebot F65 21 Ah pack",
    shortLabel: "F65 21Ah",
    family: "ninebot-f",
    cellConfig: "10S5P",
    chemistry: "li-ion-21700",
    nominalVoltageV: 36,
    capacityAh: 21,
    energyWh: 756,
    boardId: 0x0804,
    serialPrefixes: ["F65"],
    compatibleScooterIds: ["ninebot-kickscooter-f65"],
    confidence: "community",
    notes: "Encrypted (enc2) BMS — auth required for cell-level reads.",
  },

  // ── Ninebot E series ─────────────────────────────────────────────────────
  {
    id: "bms-e22-5p2",
    displayName: "Ninebot E22 5.2 Ah pack",
    shortLabel: "E22 5.2Ah",
    family: "ninebot-e",
    cellConfig: "10S2P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 5.2,
    energyWh: 187,
    boardId: 0x0901,
    serialPrefixes: ["E22"],
    compatibleScooterIds: ["e22"],
    confidence: "documented",
  },
  {
    id: "bms-e25-7p65",
    displayName: "Ninebot E25 7.65 Ah pack",
    shortLabel: "E25 7.65Ah",
    family: "ninebot-e",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 7.65,
    energyWh: 275,
    boardId: 0x0902,
    serialPrefixes: ["E25"],
    compatibleScooterIds: ["e25"],
    confidence: "documented",
  },
  {
    id: "bms-e45-15p3",
    displayName: "Ninebot E45 15.3 Ah pack",
    shortLabel: "E45 15.3Ah",
    family: "ninebot-e",
    cellConfig: "10S3P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 15.3,
    energyWh: 551,
    boardId: 0x0903,
    serialPrefixes: ["E45"],
    compatibleScooterIds: ["e45"],
    confidence: "documented",
  },

  // ── Generic clones ───────────────────────────────────────────────────────
  {
    id: "bms-clone-generic",
    displayName: "Generic M365-protocol clone BMS",
    shortLabel: "Clone BMS",
    family: "clone",
    cellConfig: "10S?P",
    chemistry: "li-ion-18650",
    nominalVoltageV: 36,
    capacityAh: 0,
    energyWh: 0,
    compatibleScooterIds: ["generic-clone", "kugoo-s1", "kugoo-s2", "kugoo-s3", "mercane-widewheel"],
    confidence: "inferred",
    notes: "Clones reuse the M365 register layout but capacity reads are unreliable.",
  },
];

/* -------------------------------------------------------------------------- */
/* Motherboard / ESC                                                          */
/* -------------------------------------------------------------------------- */

/**
 * MCU family used by the controller. Determines the flashing toolchain
 * (ST-Link / N76E DAP / Nordic SWD) and whether community firmware exists.
 */
export type MotherboardMcu =
  | "stm32f1"      // STM32F103 — original M365 / 1S / Pro / Pro 2 / Mi3
  | "stm32f0"      // STM32F0 — entry-level controllers (Razor, Gotrax, OKAI)
  | "stm32f4"      // STM32F4 — performance boards (Dualtron, Kaabo, NAMI)
  | "stm32g4"      // STM32G431 — Mi4, Apollo, NIU KQi3 Pro
  | "stm32l4"      // STM32L4 — low-power (Bird, Lime fleet hardware)
  | "gd32f3"       // GigaDevice GD32 — late M365, Joyor, iScooter clones
  | "n76e"         // Nuvoton N76E — Ninebot ES BLE module
  | "nrf52"        // Nordic nRF52 — Ninebot Max + most premium BLE modules
  | "nrf51"        // Nordic nRF51 — early Bird / Lime / Inokim modules
  | "esp32"        // Espressif ESP32 — newer Ninebot G/F/Max-G2 + Apollo
  | "ti-msp430"    // TI MSP430 — Razor / EcoSmart BMS
  | "bq76930"      // TI BQ769x0 — common stack monitor (many BMS)
  | "atmega"       // Atmel ATmega — older clones (Inokim Light 1, Egret Ten)
  | "unknown";

export interface Motherboard {
  /** Stable, persisted identifier. Lowercase kebab. */
  id: string;
  /** Display label shown in info panels and chips. */
  displayName: string;
  /** Short label for cramped UI surfaces. */
  shortLabel: string;
  family: ScooterHardwareFamily;
  /** Drive (DRV) MCU. The "main" CPU, runs motor + UI logic. */
  drvMcu: MotherboardMcu;
  /** BLE module MCU — separate from DRV on every model in this list. */
  bleMcu: MotherboardMcu;
  /**
   * 16-bit board id reported over BLE. This is the value our existing
   * `decodeModelId()` (in `src/lib/m365/protocol.ts`) compares against
   * and what the firmware catalog uses to gate which DRV builds apply.
   */
  boardId?: number;
  /** Hardware revision string as printed on the silkscreen, e.g. "v1.4". */
  hardwareRevision?: string;
  /** Continuous motor power rating in watts (nominal, not peak). */
  motorPowerW?: number;
  /** Phase current limit in amps (where documented). */
  phaseCurrentA?: number;
  /** Slugs from `SCOOTER_MODELS` / `NINEBOT_MODELS` shipping this board. */
  compatibleScooterIds: readonly string[];
  /** How well-sourced the values above are. */
  confidence: DataConfidence;
  /** Free-text quirks worth surfacing in debug UIs. */
  notes?: string;
}

/**
 * Public catalog of motherboards/ESCs known to talk M365 / Ninebot
 * protocols. Order is rough chronological per family for easier diffing.
 */
export const MOTHERBOARDS: readonly Motherboard[] = [
  // ── Xiaomi M365 family ───────────────────────────────────────────────────
  {
    id: "mb-m365-v1.3",
    displayName: "Xiaomi M365 mainboard v1.3",
    shortLabel: "M365 v1.3",
    family: "xiaomi-m365",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    boardId: 0x0001,
    hardwareRevision: "v1.3",
    motorPowerW: 250,
    phaseCurrentA: 30,
    compatibleScooterIds: ["m365"],
    confidence: "documented",
    notes: "Earliest M365 ESC. Community CFW (CFWRM) targets STM32F103.",
  },
  {
    id: "mb-m365-v1.4",
    displayName: "Xiaomi M365 mainboard v1.4",
    shortLabel: "M365 v1.4",
    family: "xiaomi-m365",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    boardId: 0x0001,
    hardwareRevision: "v1.4",
    motorPowerW: 250,
    phaseCurrentA: 30,
    compatibleScooterIds: ["m365"],
    confidence: "documented",
    notes: "Silent revision; same board id 0x0001 — distinguish via silkscreen.",
  },
  {
    id: "mb-1s",
    displayName: "Xiaomi Mi 1S mainboard",
    shortLabel: "1S",
    family: "xiaomi-m365",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    boardId: 0x0004,
    motorPowerW: 250,
    phaseCurrentA: 30,
    compatibleScooterIds: ["1s"],
    confidence: "documented",
  },
  {
    id: "mb-essential",
    displayName: "Mi Essential mainboard",
    shortLabel: "Essential",
    family: "xiaomi-m365",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    boardId: 0x0003,
    motorPowerW: 250,
    phaseCurrentA: 25,
    compatibleScooterIds: ["essential"],
    confidence: "documented",
    notes: "Downrated phase current vs M365 — community 'Essential CFW' lifts it.",
  },
  {
    id: "mb-m365-pro",
    displayName: "Xiaomi M365 Pro mainboard",
    shortLabel: "M365 Pro",
    family: "xiaomi-m365",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    boardId: 0x0002,
    motorPowerW: 300,
    phaseCurrentA: 35,
    compatibleScooterIds: ["m365-pro"],
    confidence: "documented",
  },
  {
    id: "mb-pro2",
    displayName: "Mi Pro 2 mainboard",
    shortLabel: "Pro 2",
    family: "xiaomi-m365",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    boardId: 0x0005,
    motorPowerW: 300,
    phaseCurrentA: 35,
    compatibleScooterIds: ["pro2"],
    confidence: "documented",
    notes: "Same MCU as M365 Pro; firmware locks down some registers.",
  },
  {
    id: "mb-mi3",
    displayName: "Mi Scooter 3 mainboard",
    shortLabel: "Mi 3",
    family: "xiaomi-m365",
    drvMcu: "gd32f3",
    bleMcu: "nrf52",
    boardId: 0x0006,
    motorPowerW: 300,
    phaseCurrentA: 35,
    compatibleScooterIds: ["mi3", "mi3-lite"],
    confidence: "documented",
    notes: "First Xiaomi scooter to use a GigaDevice DRV + Nordic BLE module.",
  },
  {
    id: "mb-mi4",
    displayName: "Mi Scooter 4 mainboard",
    shortLabel: "Mi 4",
    family: "xiaomi-mi",
    drvMcu: "stm32g4",
    bleMcu: "nrf52",
    boardId: 0x0008,
    motorPowerW: 300,
    phaseCurrentA: 35,
    compatibleScooterIds: ["mi4", "mi4-lite"],
    confidence: "community",
    notes: "STM32G4 introduces hardware-accelerated FOC; CFW work-in-progress.",
  },
  {
    id: "mb-mi4-pro",
    displayName: "Mi Scooter 4 Pro mainboard",
    shortLabel: "Mi 4 Pro",
    family: "xiaomi-mi",
    drvMcu: "stm32g4",
    bleMcu: "nrf52",
    boardId: 0x0009,
    motorPowerW: 350,
    phaseCurrentA: 40,
    compatibleScooterIds: ["mi4-pro"],
    confidence: "community",
  },
  {
    id: "mb-mi4-ultra",
    displayName: "Mi Scooter 4 Ultra mainboard",
    shortLabel: "Mi 4 Ultra",
    family: "xiaomi-mi",
    drvMcu: "stm32g4",
    bleMcu: "esp32",
    boardId: 0x000b,
    motorPowerW: 500,
    phaseCurrentA: 50,
    compatibleScooterIds: ["mi4-ultra"],
    confidence: "community",
    notes: "12S architecture; ESP32 BLE module enables OTA over WiFi.",
  },

  // ── Ninebot ES family ────────────────────────────────────────────────────
  {
    id: "mb-ninebot-es",
    displayName: "Ninebot ES mainboard",
    shortLabel: "ES",
    family: "ninebot-es",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    motorPowerW: 250,
    phaseCurrentA: 25,
    compatibleScooterIds: ["es1", "es2", "es3", "es4", "ninebot-kickscooter-es"],
    confidence: "documented",
    notes: "Shared ESC across ES1–ES4; differences are firmware-only.",
  },

  // ── Ninebot Max / G family ───────────────────────────────────────────────
  {
    id: "mb-ninebot-max-g30",
    displayName: "Ninebot Max G30 mainboard",
    shortLabel: "G30",
    family: "ninebot-max",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    motorPowerW: 350,
    phaseCurrentA: 40,
    compatibleScooterIds: ["max-g30", "max-g30d", "max-g30p", "ninebot-kickscooter-max"],
    confidence: "documented",
    notes: "Plaintext (p2) protocol; widely modded.",
  },
  {
    id: "mb-ninebot-max-g30lp",
    displayName: "Ninebot Max G30LP mainboard",
    shortLabel: "G30LP",
    family: "ninebot-max",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    motorPowerW: 350,
    phaseCurrentA: 40,
    compatibleScooterIds: ["max-g30lp"],
    confidence: "documented",
  },
  {
    id: "mb-ninebot-max-g2",
    displayName: "Ninebot Max G2 mainboard",
    shortLabel: "Max G2",
    family: "ninebot-max",
    drvMcu: "stm32g4",
    bleMcu: "esp32",
    motorPowerW: 450,
    phaseCurrentA: 50,
    compatibleScooterIds: ["max-g2", "ninebot-kickscooter-max-g2"],
    confidence: "community",
    notes: "Encrypted (enc2) protocol; AES-128-CTR + CBC-MAC handshake required.",
  },
  {
    id: "mb-ninebot-gt1",
    displayName: "Ninebot GT1 mainboard",
    shortLabel: "GT1",
    family: "ninebot-g",
    drvMcu: "stm32g4",
    bleMcu: "esp32",
    motorPowerW: 1000,
    phaseCurrentA: 80,
    compatibleScooterIds: ["gt1"],
    confidence: "community",
    notes: "Single-motor super-scooter; encrypted protocol; locked DRV.",
  },
  {
    id: "mb-ninebot-gt2",
    displayName: "Ninebot GT2 mainboard",
    shortLabel: "GT2",
    family: "ninebot-g",
    drvMcu: "stm32g4",
    bleMcu: "esp32",
    motorPowerW: 1500,
    phaseCurrentA: 100,
    compatibleScooterIds: ["gt2"],
    confidence: "community",
    notes: "Dual-motor flagship; two DRV MCUs; encrypted protocol.",
  },

  // ── Ninebot F series ─────────────────────────────────────────────────────
  {
    id: "mb-ninebot-f-r1",
    displayName: "Ninebot F-series mainboard (rev 1)",
    shortLabel: "F r1",
    family: "ninebot-f",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    motorPowerW: 350,
    phaseCurrentA: 35,
    compatibleScooterIds: ["f20", "f25", "f30", "f40", "ninebot-kickscooter-f-r1"],
    confidence: "documented",
    notes: "Shared across F20/F25/F30/F40 — phase current trimmed in firmware.",
  },
  {
    id: "mb-ninebot-f-r2",
    displayName: "Ninebot F-series mainboard (rev 2)",
    shortLabel: "F r2",
    family: "ninebot-f",
    drvMcu: "gd32f3",
    bleMcu: "nrf52",
    motorPowerW: 350,
    phaseCurrentA: 35,
    compatibleScooterIds: ["ninebot-kickscooter-f-r2"],
    confidence: "community",
    notes: "Late-production silent revision; GD32 DRV + Nordic BLE.",
  },
  {
    id: "mb-ninebot-f2",
    displayName: "Ninebot F2 / F2 Plus / F2 Pro mainboard",
    shortLabel: "F2",
    family: "ninebot-f",
    drvMcu: "stm32g4",
    bleMcu: "nrf52",
    motorPowerW: 400,
    phaseCurrentA: 40,
    compatibleScooterIds: ["f2", "f2-plus", "f2-pro", "ninebot-kickscooter-f2", "ninebot-kickscooter-f2-plus", "ninebot-kickscooter-f2-pro"],
    confidence: "community",
    notes: "STM32G4 DRV; plaintext p2 — community CFW in development.",
  },
  {
    id: "mb-ninebot-f65",
    displayName: "Ninebot F65 mainboard",
    shortLabel: "F65",
    family: "ninebot-f",
    drvMcu: "stm32g4",
    bleMcu: "esp32",
    motorPowerW: 500,
    phaseCurrentA: 50,
    compatibleScooterIds: ["ninebot-kickscooter-f65"],
    confidence: "community",
    notes: "Encrypted (enc2) protocol — same auth flow as Max G2.",
  },

  // ── Ninebot E series ─────────────────────────────────────────────────────
  {
    id: "mb-ninebot-e-series",
    displayName: "Ninebot E22/E25/E45 mainboard",
    shortLabel: "E2x",
    family: "ninebot-e",
    drvMcu: "stm32f1",
    bleMcu: "n76e",
    motorPowerW: 300,
    phaseCurrentA: 30,
    compatibleScooterIds: ["e22", "e25", "e45"],
    confidence: "documented",
    notes: "ES descendant; identical register layout, different motor curves.",
  },

  // ── Ninebot D series ─────────────────────────────────────────────────────
  {
    id: "mb-ninebot-d-series",
    displayName: "Ninebot D18/D28/D38 mainboard",
    shortLabel: "Dxx",
    family: "ninebot-d",
    drvMcu: "stm32g4",
    bleMcu: "nrf52",
    motorPowerW: 300,
    phaseCurrentA: 30,
    compatibleScooterIds: ["d18w", "d28e", "d38e", "ninebot-kickscooter-d18", "ninebot-kickscooter-d28", "ninebot-kickscooter-d38"],
    confidence: "community",
    notes: "Encrypted (enc2) protocol; consumer/EU-market kick scooters.",
  },

  // ── Generic clones ───────────────────────────────────────────────────────
  {
    id: "mb-clone-generic",
    displayName: "Generic M365-protocol clone mainboard",
    shortLabel: "Clone",
    family: "clone",
    drvMcu: "unknown",
    bleMcu: "unknown",
    compatibleScooterIds: ["generic-clone", "kugoo-s1", "kugoo-s2", "kugoo-s3", "mercane-widewheel"],
    confidence: "inferred",
    notes: "Clones expose the M365 GATT layout but DRV firmware is non-stock.",
  },
];

/* -------------------------------------------------------------------------- */
/* Lookup helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Find a BMS module by its stable id. */
export function getBmsById(id: string): BmsModule | undefined {
  return BMS_MODULES.find((b) => b.id === id);
}

/** Find a motherboard by its stable id. */
export function getMotherboardById(id: string): Motherboard | undefined {
  return MOTHERBOARDS.find((m) => m.id === id);
}

/** Find the BMS module whose 16-bit board id matches `boardId`, if any. */
export function getBmsByBoardId(boardId: number): BmsModule | undefined {
  return BMS_MODULES.find((b) => b.boardId === boardId);
}

/** Find the motherboard whose 16-bit board id matches `boardId`, if any. */
export function getMotherboardByBoardId(boardId: number): Motherboard | undefined {
  return MOTHERBOARDS.find((m) => m.boardId === boardId);
}

/**
 * Resolve the BMS modules a scooter (by registry id) is documented to ship
 * with. Multi-pack scooters (e.g. ES2 with internal+external) return both.
 */
export function getBmsForScooter(scooterId: string): BmsModule[] {
  return BMS_MODULES.filter((b) => b.compatibleScooterIds.includes(scooterId));
}

/**
 * Resolve the motherboard(s) a scooter (by registry id) is documented to
 * ship with. Most scooters return exactly one entry; silent revisions
 * return multiple.
 */
export function getMotherboardsForScooter(scooterId: string): Motherboard[] {
  return MOTHERBOARDS.filter((m) => m.compatibleScooterIds.includes(scooterId));
}

/**
 * Match a BMS module against a freshly-read serial number string. Uses
 * the longest matching `serialPrefixes[]` entry across the catalog so a
 * specific prefix ("F2P") wins over a generic one ("F2").
 */
export function matchBmsBySerial(serial: string | null | undefined): BmsModule | undefined {
  if (!serial) return undefined;
  const upper = serial.trim().toUpperCase();
  let best: { module: BmsModule; len: number } | undefined;
  for (const m of BMS_MODULES) {
    for (const p of m.serialPrefixes ?? []) {
      const pu = p.toUpperCase();
      if (upper.startsWith(pu) && (!best || pu.length > best.len)) {
        best = { module: m, len: pu.length };
      }
    }
  }
  return best?.module;
}
