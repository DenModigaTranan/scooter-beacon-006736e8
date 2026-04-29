/**
 * Per-device Ninebot model overrides.
 *
 * Maps a BLE device id (typically a MAC address on Android, or an
 * OS-supplied UUID on iOS/web) to a pinned model id from the
 * `ninebot-models` registry. Used to force the correct model for one
 * specific scooter when auto-detection picks the wrong family — e.g. a
 * device whose advertised name doesn't match any known prefix, or a
 * cloned/relabeled unit reporting the wrong manufacturer ID.
 *
 * Resolution precedence at call sites should be:
 *   1. Per-device override (this module)            — most specific
 *   2. Toolbar "Target model" pin (session-wide)
 *   3. Registry auto-detection from advert
 *   4. Fallback / null
 *
 * Storage: a single JSON object in localStorage keyed by lowercased
 * device id. Subscribers re-render via a custom event on local writes
 * and via the native `storage` event for cross-tab updates.
 */
import { useEffect, useState } from "react";

const STORAGE_KEY = "scootflash:device-model-overrides";
const CHANGE_EVENT = "scootflash:device-model-overrides-changed";

interface OverrideStore {
  schemaVersion: 1;
  /** lowercased deviceId → model id from the registry. */
  overrides: Record<string, string>;
}

function emptyStore(): OverrideStore {
  return { schemaVersion: 1, overrides: {} };
}

function read(): OverrideStore {
  if (typeof localStorage === "undefined") return emptyStore();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as OverrideStore;
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.overrides !== "object") {
      return emptyStore();
    }
    return parsed;
  } catch {
    return emptyStore();
  }
}

function write(store: OverrideStore): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function key(deviceId: string): string {
  return deviceId.toLowerCase();
}

/** Returns the pinned model id for a device, or null if none. */
export function getDeviceModelOverride(deviceId: string): string | null {
  return read().overrides[key(deviceId)] ?? null;
}

/** Snapshot of all overrides (lowercased id → model id). */
export function listDeviceModelOverrides(): Record<string, string> {
  return { ...read().overrides };
}

/** Pin a model id for the given device. Empty/falsy modelId clears it. */
export function setDeviceModelOverride(deviceId: string, modelId: string | null): void {
  const store = read();
  const k = key(deviceId);
  if (!modelId) {
    if (!(k in store.overrides)) return;
    delete store.overrides[k];
  } else {
    if (store.overrides[k] === modelId) return;
    store.overrides[k] = modelId;
  }
  write(store);
}

/** Drop the override for a device, if any. */
export function clearDeviceModelOverride(deviceId: string): void {
  setDeviceModelOverride(deviceId, null);
}

/**
 * React hook returning the live override map. Re-renders on same-tab
 * updates (custom event) and cross-tab updates (`storage` event).
 */
export function useDeviceModelOverrides(): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>(() => listDeviceModelOverrides());
  useEffect(() => {
    const refresh = () => setMap(listDeviceModelOverrides());
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) refresh(); };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return map;
}

/** Convenience hook for a single device. */
export function useDeviceModelOverride(deviceId: string | null | undefined): string | null {
  const map = useDeviceModelOverrides();
  if (!deviceId) return null;
  return map[deviceId.toLowerCase()] ?? null;
}
