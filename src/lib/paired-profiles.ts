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

/**
 * Which app profile this paired device belongs to. Lets the M365 ConnectScreen
 * and the GenericBleScreen render disjoint paired lists from the same store.
 * Older installs predate this field and are migrated to "m365" on read.
 */
export type PairedKind = "m365" | "generic-ble";

export interface PairedProfile {
  /** Lowercased BLE address / OS-supplied device id. */
  deviceId: string;
  /** Which screen / profile saved this entry. Defaults to "m365" for older data. */
  kind: PairedKind;
  /** Advertised name at last connect (e.g. "MIScooter1234"). */
  advertisedName: string;
  /** Optional user-chosen nickname. */
  alias?: string;
  /** Snapshot of the last successful M365 `readInfo()`. Only set for kind="m365". */
  lastInfo?: ScooterInfo;
  /** Most recent flash from this app, if any. Only set for kind="m365". */
  lastFlash?: PairedFlashRecord;
  /**
   * Service UUIDs advertised at last connect. Used by the Generic BLE paired
   * panel to render a quick "what is this?" hint and by auto-reconnect to
   * detect if the peripheral has changed identity since pairing.
   */
  serviceUuids?: string[];
  /**
   * Pinned Ninebot/Generic model id (from `NINEBOT_MODELS`), if the user
   * confirmed one for this device on the Generic BLE screen. Persisted here
   * — alongside the device-model-overrides store — so the paired list can
   * show the model badge without consulting the override store.
   */
  pinnedModelId?: string;
  /** Epoch ms of first time we saw this device. */
  firstSeenAt: number;
  /** Epoch ms of most recent successful connection. */
  lastConnectedAt: number;
  /** How many times we've connected to this device. */
  connectCount: number;
}

interface ProfileStore {
  schemaVersion: 2;
  profiles: Record<string, PairedProfile>;
}

const STORAGE_KEY = "scootflash:paired-profiles";
const CHANGE_EVENT = "scootflash:paired-profiles-changed";

function emptyStore(): ProfileStore {
  return { schemaVersion: 2, profiles: {} };
}

function read(): ProfileStore {
  if (typeof localStorage === "undefined") return emptyStore();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as { schemaVersion: number; profiles?: Record<string, PairedProfile> };
    if (!parsed || typeof parsed.profiles !== "object" || !parsed.profiles) {
      return emptyStore();
    }
    // Forward-migrate v1 → v2: stamp every existing entry with kind="m365"
    // so the M365 paired list keeps working unchanged. Generic BLE entries
    // can only have been written under v2+, so anything missing `kind` is
    // M365 by definition.
    if (parsed.schemaVersion === 1 || parsed.schemaVersion === 2) {
      const profiles: Record<string, PairedProfile> = {};
      for (const [k, p] of Object.entries(parsed.profiles)) {
        profiles[k] = { ...p, kind: (p as PairedProfile).kind ?? "m365" };
      }
      return { schemaVersion: 2, profiles };
    }
    return emptyStore();
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
export function listPairedProfiles(kind?: PairedKind): PairedProfile[] {
  const all = Object.values(read().profiles).sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  return kind ? all.filter((p) => p.kind === kind) : all;
}

export function getPairedProfile(deviceId: string): PairedProfile | null {
  return read().profiles[key(deviceId)] ?? null;
}

/**
 * Upsert an M365-flavoured profile after a successful protocol handshake.
 * Bumps `lastConnectedAt` and `connectCount`, and merges `info` over any
 * previous snapshot. Keeps the existing call sites in use-scooter.ts working.
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
    kind: "m365",
    advertisedName: device.name || prev?.advertisedName || "Unknown",
    alias: prev?.alias,
    lastInfo: info ?? prev?.lastInfo,
    lastFlash: prev?.lastFlash,
    serviceUuids: prev?.serviceUuids,
    pinnedModelId: prev?.pinnedModelId,
    firstSeenAt: prev?.firstSeenAt ?? now,
    lastConnectedAt: now,
    connectCount: (prev?.connectCount ?? 0) + 1,
  };
  store.profiles[k] = next;
  write(store);
  return next;
}

/**
 * Generic BLE flavour of upsert — used by the Generic BLE screen after a
 * link is up and services have been discovered. Records the advertised
 * service UUIDs (lowercased) so the paired panel can show what the device
 * looked like, plus an optional pinned model id when the user has chosen
 * one for this MAC on the Generic screen.
 *
 * Kept separate from `upsertPairedProfile` so:
 *   • the M365 call site doesn't accidentally clear `serviceUuids` to undefined,
 *   • the type system can guarantee `kind="generic-ble"` here without a
 *     runtime branch on every M365 connect.
 */
export function upsertGenericPairedProfile(input: {
  deviceId: string;
  name?: string;
  serviceUuids?: string[];
  pinnedModelId?: string;
}): PairedProfile {
  const store = read();
  const k = key(input.deviceId);
  const now = Date.now();
  const prev = store.profiles[k];
  const dedupedUuids = input.serviceUuids
    ? Array.from(new Set(input.serviceUuids.map((u) => u.toLowerCase())))
    : prev?.serviceUuids;
  const next: PairedProfile = {
    deviceId: k,
    kind: "generic-ble",
    advertisedName: input.name || prev?.advertisedName || "(unnamed)",
    alias: prev?.alias,
    // Generic profiles never carry M365 lastInfo/lastFlash; leave any prior
    // M365 data in place if a device somehow toggled between profiles, but
    // don't surface it on the Generic panel (filtered by `kind`).
    lastInfo: prev?.lastInfo,
    lastFlash: prev?.lastFlash,
    serviceUuids: dedupedUuids,
    pinnedModelId: input.pinnedModelId ?? prev?.pinnedModelId,
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
 * Pass `kind` to scope the result to one app profile.
 */
export function usePairedProfiles(kind?: PairedKind): PairedProfile[] {
  const [list, setList] = useState<PairedProfile[]>(() => listPairedProfiles(kind));
  useEffect(() => {
    const refresh = () => setList(listPairedProfiles(kind));
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) refresh(); };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, [kind]);
  return list;
}
