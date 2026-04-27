/**
 * Firmware catalog client.
 * Catalog is just a remotely-hosted JSON. The default URL points to a
 * placeholder you can swap from Settings — no app rebuild needed.
 */

export interface FirmwareEntry {
  id: string;
  target: "DRV" | "BMS" | "BLE";
  version: string;
  models: string[];           // e.g. ["m365", "pro", "1s"]
  size: number;               // bytes
  sha256: string;
  url: string;
  changelog?: string;
  channel: "stable" | "experimental";
  publishedAt: string;        // ISO date
}

export interface FirmwareCatalog {
  updatedAt: string;
  firmwares: FirmwareEntry[];
}

const DEFAULT_CATALOG_URL =
  "https://raw.githubusercontent.com/scootflash/catalog/main/catalog.json";

const STORAGE_KEY = "scootflash:catalog-url";

export function getCatalogUrl(): string {
  if (typeof localStorage === "undefined") return DEFAULT_CATALOG_URL;
  return localStorage.getItem(STORAGE_KEY) || DEFAULT_CATALOG_URL;
}

export function setCatalogUrl(url: string): void {
  if (typeof localStorage === "undefined") return;
  if (url.trim()) localStorage.setItem(STORAGE_KEY, url.trim());
  else localStorage.removeItem(STORAGE_KEY);
}

import { XIAOMI_MODEL_IDS, NINEBOT_MODEL_IDS, ALL_MODEL_IDS } from "./models";

export const FALLBACK_CATALOG: FirmwareCatalog = {
  updatedAt: new Date().toISOString(),
  firmwares: [
    {
      id: "drv-cfwrm-1.6.6",
      target: "DRV",
      version: "1.6.6 (CFWRM)",
      models: XIAOMI_MODEL_IDS,
      size: 38_400,
      sha256: "—",
      url: "",
      changelog: "Community CFW with custom speed limits, motor curves, and battery info.",
      channel: "stable",
      publishedAt: "2024-08-12",
    },
    {
      id: "drv-stock-1.5.5",
      target: "DRV",
      version: "1.5.5 (Stock)",
      models: ["m365", "1s"],
      size: 36_864,
      sha256: "—",
      url: "",
      changelog: "Original Xiaomi DRV firmware.",
      channel: "stable",
      publishedAt: "2020-03-10",
    },
    {
      id: "drv-stock-pro-1.4.1",
      target: "DRV",
      version: "1.4.1 (Stock Pro)",
      models: ["m365-pro", "pro2"],
      size: 36_864,
      sha256: "—",
      url: "",
      changelog: "Original Xiaomi Pro / Pro 2 DRV firmware.",
      channel: "stable",
      publishedAt: "2021-02-18",
    },
    {
      id: "drv-stock-mi3-1.0.4",
      target: "DRV",
      version: "1.0.4 (Stock Mi 3)",
      models: ["mi3", "mi3-lite"],
      size: 38_912,
      sha256: "—",
      url: "",
      changelog: "Original Xiaomi Mi 3 DRV firmware.",
      channel: "stable",
      publishedAt: "2023-04-09",
    },
    {
      id: "drv-stock-mi4-0.3.0",
      target: "DRV",
      version: "0.3.0 (Stock Mi 4)",
      models: ["mi4", "mi4-pro", "mi4-lite", "mi4-ultra"],
      size: 40_960,
      sha256: "—",
      url: "",
      changelog: "Original Xiaomi Mi 4 series DRV firmware.",
      channel: "experimental",
      publishedAt: "2024-05-22",
    },
    {
      id: "bms-stock-1.6.13",
      target: "BMS",
      version: "1.6.13",
      models: ["m365", "m365-pro"],
      size: 28_672,
      sha256: "—",
      url: "",
      changelog: "Battery management firmware. Flashing BMS is risky — proceed with care.",
      channel: "experimental",
      publishedAt: "2022-01-04",
    },
    {
      id: "ble-stock-0.96",
      target: "BLE",
      version: "0.96",
      models: ALL_MODEL_IDS,
      size: 16_384,
      sha256: "—",
      url: "",
      changelog: "Bluetooth module firmware (M365 family).",
      channel: "stable",
      publishedAt: "2021-06-21",
    },
    {
      id: "ninebot-drv-stock",
      target: "DRV",
      version: "Ninebot stock (placeholder)",
      models: NINEBOT_MODEL_IDS,
      size: 49_152,
      sha256: "—",
      url: "",
      changelog: "Stock Ninebot/Segway DRV firmware. Encrypted protocol — flashing is read-only in app.",
      channel: "experimental",
      publishedAt: "2024-02-01",
    },
  ],
};

export async function fetchCatalog(signal?: AbortSignal): Promise<FirmwareCatalog> {
  try {
    const res = await fetch(getCatalogUrl(), { signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as FirmwareCatalog;
    if (!json?.firmwares) throw new Error("malformed catalog");
    return json;
  } catch {
    return FALLBACK_CATALOG;
  }
}
