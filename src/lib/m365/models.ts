/**
 * Central registry of scooter models known to use (or be compatible with)
 * the M365 / Ninebot protocol family.
 *
 * Keep this list in one place so the protocol decoder, the fallback catalog,
 * and any UI dropdowns stay in sync. New entries should go here only.
 *
 * `id` — short kebab/lowercase slug used in firmware catalog `models[]`.
 * `boardId` — 16-bit board id reported over BLE (when known).
 * `family` — coarse grouping for filters/badges.
 */

export type ModelFamily =
  | "xiaomi-m365"
  | "xiaomi-mi"
  | "xiaomi-pro"
  | "xiaomi-essential"
  | "xiaomi-1s"
  | "xiaomi-3"
  | "xiaomi-4"
  | "ninebot-es"
  | "ninebot-max"
  | "ninebot-f"
  | "ninebot-e"
  | "ninebot-d"
  | "ninebot-g"
  | "ninebot-kickscooter"
  | "clone";

export interface ScooterModel {
  id: string;
  label: string;
  family: ModelFamily;
  boardId?: number;
  notes?: string;
  status: "supported" | "experimental" | "untested" | "clone";
}

/**
 * Comprehensive list of community-documented scooters that talk the M365/Ninebot
 * BLE protocol (or a close clone of it). `boardId` values come from the
 * scooterhacking / m365-st-link community databases.
 */
export const SCOOTER_MODELS: ScooterModel[] = [
  // ── Xiaomi M365 / Mi family ──────────────────────────────────────────────
  { id: "m365",          label: "Xiaomi M365 (1st gen)",   family: "xiaomi-m365",      boardId: 0x0001, status: "supported" },
  { id: "m365-pro",      label: "Xiaomi M365 Pro",         family: "xiaomi-pro",       boardId: 0x0002, status: "supported" },
  { id: "essential",     label: "Mi Essential",            family: "xiaomi-essential", boardId: 0x0003, status: "supported" },
  { id: "1s",            label: "Mi 1S",                   family: "xiaomi-1s",        boardId: 0x0004, status: "supported" },
  { id: "pro2",          label: "Mi Pro 2",                family: "xiaomi-pro",       boardId: 0x0005, status: "supported" },
  { id: "mi3",           label: "Mi Electric Scooter 3",   family: "xiaomi-3",         boardId: 0x0006, status: "supported", notes: "Sometimes reported as ‘3 / Lite’." },
  { id: "mi3-lite",      label: "Mi Scooter 3 Lite",       family: "xiaomi-3",         boardId: 0x0007, status: "experimental" },
  { id: "mi4",           label: "Mi Electric Scooter 4",   family: "xiaomi-4",         boardId: 0x0008, status: "experimental" },
  { id: "mi4-pro",       label: "Mi Electric Scooter 4 Pro", family: "xiaomi-4",      boardId: 0x0009, status: "experimental" },
  { id: "mi4-lite",      label: "Mi Electric Scooter 4 Lite", family: "xiaomi-4",     boardId: 0x000a, status: "experimental" },
  { id: "mi4-ultra",     label: "Mi Electric Scooter 4 Ultra", family: "xiaomi-4",    boardId: 0x000b, status: "experimental" },

  // ── Ninebot / Segway ES family ───────────────────────────────────────────
  { id: "es1",           label: "Ninebot ES1",             family: "ninebot-es",       status: "experimental" },
  { id: "es2",           label: "Ninebot ES2",             family: "ninebot-es",       status: "experimental" },
  { id: "es3",           label: "Ninebot ES3",             family: "ninebot-es",       status: "experimental" },
  { id: "es4",           label: "Ninebot ES4",             family: "ninebot-es",       status: "experimental" },

  // ── Ninebot / Segway Max ─────────────────────────────────────────────────
  { id: "max-g30",       label: "Ninebot Max G30",         family: "ninebot-max",      status: "experimental" },
  { id: "max-g30d",      label: "Ninebot Max G30D",        family: "ninebot-max",      status: "experimental" },
  { id: "max-g30lp",     label: "Ninebot Max G30LP",       family: "ninebot-max",      status: "experimental" },
  { id: "max-g30p",      label: "Ninebot Max G30P",        family: "ninebot-max",      status: "experimental" },
  { id: "max-g2",        label: "Ninebot Max G2",          family: "ninebot-max",      status: "untested" },

  // ── Ninebot F series ─────────────────────────────────────────────────────
  { id: "f20",           label: "Ninebot F20",             family: "ninebot-f",        status: "experimental" },
  { id: "f25",           label: "Ninebot F25",             family: "ninebot-f",        status: "experimental" },
  { id: "f30",           label: "Ninebot F30",             family: "ninebot-f",        status: "experimental" },
  { id: "f40",           label: "Ninebot F40",             family: "ninebot-f",        status: "experimental" },
  { id: "f2",            label: "Ninebot F2",              family: "ninebot-f",        status: "untested" },
  { id: "f2-plus",       label: "Ninebot F2 Plus",         family: "ninebot-f",        status: "untested" },
  { id: "f2-pro",        label: "Ninebot F2 Pro",          family: "ninebot-f",        status: "untested" },

  // ── Ninebot E series ─────────────────────────────────────────────────────
  { id: "e22",           label: "Ninebot E22",             family: "ninebot-e",        status: "experimental" },
  { id: "e25",           label: "Ninebot E25",             family: "ninebot-e",        status: "experimental" },
  { id: "e45",           label: "Ninebot E45",             family: "ninebot-e",        status: "experimental" },

  // ── Ninebot D series ─────────────────────────────────────────────────────
  { id: "d18w",          label: "Ninebot D18W",            family: "ninebot-d",        status: "untested" },
  { id: "d28e",          label: "Ninebot D28E",            family: "ninebot-d",        status: "untested" },
  { id: "d38e",          label: "Ninebot D38E",            family: "ninebot-d",        status: "untested" },

  // ── Ninebot KickScooter / G ──────────────────────────────────────────────
  { id: "kickscooter-c",     label: "Ninebot KickScooter C",   family: "ninebot-kickscooter", status: "untested" },
  { id: "kickscooter-zing",  label: "Ninebot Zing E8 / E10",   family: "ninebot-kickscooter", status: "untested" },
  { id: "gt1",           label: "Ninebot GT1",             family: "ninebot-g",        status: "untested" },
  { id: "gt2",           label: "Ninebot GT2",             family: "ninebot-g",        status: "untested" },

  // ── Common rebadges / clones using the M365 GATT layout ──────────────────
  { id: "mercane-widewheel", label: "Mercane WideWheel",   family: "clone",            status: "clone", notes: "Some revisions expose the M365 service." },
  { id: "kugoo-s1",      label: "Kugoo S1 (M365 BLE mod)", family: "clone",            status: "clone" },
  { id: "kugoo-s2",      label: "Kugoo S2 (M365 BLE mod)", family: "clone",            status: "clone" },
  { id: "kugoo-s3",      label: "Kugoo S3 (M365 BLE mod)", family: "clone",            status: "clone" },
  { id: "generic-clone", label: "Generic M365 clone",      family: "clone",            status: "clone" },
];

/** Lookup by short id used in firmware catalog entries. */
export function getModelById(id: string): ScooterModel | undefined {
  return SCOOTER_MODELS.find((m) => m.id === id);
}

/** Map of `boardId → "Pretty Name"` consumed by `decodeModelId()`. */
export const BOARD_ID_TO_NAME: Record<number, string> = SCOOTER_MODELS.reduce(
  (acc, m) => {
    if (m.boardId !== undefined) acc[m.boardId] = m.label;
    return acc;
  },
  {} as Record<number, string>,
);

/** All known short ids — useful for fallback firmware `models[]` arrays. */
export const ALL_MODEL_IDS: string[] = SCOOTER_MODELS.map((m) => m.id);

/** Subset belonging to the Xiaomi/Mi M365 protocol-compatible family. */
export const XIAOMI_MODEL_IDS: string[] = SCOOTER_MODELS
  .filter((m) => m.family.startsWith("xiaomi-"))
  .map((m) => m.id);

/** Subset belonging to the Ninebot/Segway protocol family. */
export const NINEBOT_MODEL_IDS: string[] = SCOOTER_MODELS
  .filter((m) => m.family.startsWith("ninebot-"))
  .map((m) => m.id);
