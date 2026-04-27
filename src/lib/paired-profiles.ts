/**
 * Paired scooter profiles.
 *
 * Persists, per BLE device address, the most recent device info we read off
 * the scooter (serial, firmware versions, mileage), an optional user alias,
 * and the last firmware payload that was flashed from this app. This lets
 * the user re-connect to a previously seen scooter with one tap and pick up
 * where they left off (e.g. continue a partial flash).
 *
 * Storage: a single JSON object in localStorage keyed by lowercased device
 * id, plus a `schemaVersion` so we can migrate later without breaking older
 * installs. Subscribers (via `usePairedProfiles()`) re-render on any local
 * change as well as on cross-tab `storage` events.
 */
import { useEffect, useState } from "react";
import type { ScooterInfo, DiscoveredDevice } from "@/lib/m365/scooter-service";

export interface PairedFlashRecord {
  /** "DRV" | "BMS" | "BLE" — kept loose to avoid coupling to FlashScreen. */
  target: string;
  /** Human label of the firmware (catalog version, file name, etc.). */
  label: string;
  /** Bytes written. */
  size: number;
  /** Epoch ms. */
  at: number;
  /** "success" | "aborted-safe" | "aborted-unsafe" | "error". */
  result: string;
}

export interface PairedProfile {
  /** Lowercased BLE address / OS-supplied device id. */
  deviceId: string;
  /** Advertised name at last connect (e.g. "MIScooter1234"). */
  advertisedName: string;
  /** Optional user-chosen nickname. */
  alias?: string;
  /** Snapshot of the last successful `readInfo()`. */
  lastInfo?: ScooterInfo;
  /** Most recent flash from this app, if any. */
  lastFlash?: PairedFlashRecord;
  /** Epoch ms of first time we saw this device. */
  firstSeenAt: number;
  /** Epoch ms of most recent successful connection. */
  lastConnectedAt: number;
  /** How many times we've connected to this device. */
  connectCount: number;
}

interface ProfileStore {
  schemaVersion: 1;
  profiles: Record<string, PairedProfile>;
}

const STORAGE_KEY = "scootflash:paired-profiles";
const CHANGE_EVENT = "scootflash:paired-profiles-changed";

function emptyStore(): ProfileStore {
  return { schemaVersion: 1, profiles: {} };
}

function read(): ProfileStore {
  if (typeof localStorage === "undefined") return emptyStore();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as ProfileStore;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.profiles !== "object") {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}

function write(store: ProfileStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function key(deviceId: string): string {
  return deviceId.toLowerCase();
}

/** All paired profiles, sorted by most-recently-connected first. */
export function listPairedProfiles(): PairedProfile[] {
  return Object.values(read().profiles).sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
}

export function getPairedProfile(deviceId: string): PairedProfile | null {
  return read().profiles[key(deviceId)] ?? null;
}

/**
 * Upsert a profile after a successful connect. Bumps `lastConnectedAt` and
 * `connectCount`, and merges `info` over any previous snapshot.
 */
export function upsertPairedProfile(
  device: Pick<DiscoveredDevice, "deviceId" | "name">,
  info?: ScooterInfo | null,
): PairedProfile {
  const store = read();
  const k = key(device.deviceId);
  const now = Date.now();
  const prev = store.profiles[k];
  const next: PairedProfile = {
    deviceId: k,
    advertisedName: device.name || prev?.advertisedName || "Unknown",
    alias: prev?.alias,
    lastInfo: info ?? prev?.lastInfo,
    lastFlash: prev?.lastFlash,
    firstSeenAt: prev?.firstSeenAt ?? now,
    lastConnectedAt: now,
    connectCount: (prev?.connectCount ?? 0) + 1,
  };
  store.profiles[k] = next;
  write(store);
  return next;
}

/** Patch arbitrary fields on a profile (e.g. alias). No-op if unknown. */
export function updatePairedProfile(deviceId: string, patch: Partial<Omit<PairedProfile, "deviceId">>): void {
  const store = read();
  const k = key(deviceId);
  const prev = store.profiles[k];
  if (!prev) return;
  store.profiles[k] = { ...prev, ...patch, deviceId: k };
  write(store);
}

/** Record the outcome of a flash against this device. */
export function recordPairedFlash(deviceId: string, record: PairedFlashRecord): void {
  const store = read();
  const k = key(deviceId);
  const prev = store.profiles[k];
  if (!prev) return;
  store.profiles[k] = { ...prev, lastFlash: record };
  write(store);
}

/** Remove a profile entirely ("forget this scooter"). */
export function forgetPairedProfile(deviceId: string): void {
  const store = read();
  delete store.profiles[key(deviceId)];
  write(store);
}

export function clearAllPairedProfiles(): void {
  write(emptyStore());
}

/** Friendly display name: alias → advertised name → short id. */
export function displayName(p: PairedProfile): string {
  if (p.alias && p.alias.trim()) return p.alias.trim();
  if (p.advertisedName && p.advertisedName !== "Unknown") return p.advertisedName;
  return p.deviceId.slice(0, 8).toUpperCase();
}

/**
 * React hook returning the live list of paired profiles. Re-renders on
 * same-tab updates (via custom event) and cross-tab updates (via `storage`).
 */
export function usePairedProfiles(): PairedProfile[] {
  const [list, setList] = useState<PairedProfile[]>(() => listPairedProfiles());
  useEffect(() => {
    const refresh = () => setList(listPairedProfiles());
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) refresh(); };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return list;
}
