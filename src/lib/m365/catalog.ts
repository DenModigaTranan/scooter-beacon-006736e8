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

export const FALLBACK_CATALOG: FirmwareCatalog = {
  updatedAt: new Date().toISOString(),
  firmwares: [
    {
      id: "drv-cfwrm-1.6.6",
      target: "DRV",
      version: "1.6.6 (CFWRM)",
      models: ["m365", "pro", "1s", "essential", "pro2"],
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
      id: "bms-stock-1.6.13",
      target: "BMS",
      version: "1.6.13",
      models: ["m365", "pro"],
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
      models: ["m365", "pro", "1s", "essential", "pro2"],
      size: 16_384,
      sha256: "—",
      url: "",
      changelog: "Bluetooth module firmware.",
      channel: "stable",
      publishedAt: "2021-06-21",
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
