/**
 * Scooter brand / protocol profile.
 *
 * Persisted as a single string in localStorage, mirroring the convention
 * used by `catalog.ts`. Other modules read the active profile via
 * `getProfile()` or subscribe with the `useProfile()` hook.
 */

import { useEffect, useState } from "react";

export type ScooterProfile = "xiaomi-m365" | "ninebot" | "generic-ble";

export interface ProfileMeta {
  key: ScooterProfile;
  label: string;
  shortLabel: string;
  description: string;
  status: "supported" | "coming-soon";
}

export const PROFILES: ProfileMeta[] = [
  {
    key: "xiaomi-m365",
    label: "Xiaomi M365 family",
    shortLabel: "M365",
    description: "M365, Pro, 1S, Essential, Pro 2 — full BLE protocol support.",
    status: "supported",
  },
  {
    key: "ninebot",
    label: "Ninebot / Segway",
    shortLabel: "Ninebot",
    description: "ES, Max, F-series. Encrypted protocol — implementation in progress.",
    status: "coming-soon",
  },
  {
    key: "generic-ble",
    label: "Other / Generic BLE",
    shortLabel: "Generic",
    description: "Any BLE peripheral. Manual service & characteristic browsing.",
    status: "coming-soon",
  },
];

const STORAGE_KEY = "scootflash:profile";
const CHANGE_EVENT = "scootflash:profile-changed";

/** Read the saved profile, or `null` if the user hasn't picked one yet. */
export function getProfile(): ScooterProfile | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "xiaomi-m365" || v === "ninebot" || v === "generic-ble") return v;
  return null;
}

/** Save the profile and notify all `useProfile()` subscribers in this tab. */
export function setProfile(p: ScooterProfile): void {
  localStorage.setItem(STORAGE_KEY, p);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: p }));
}

export function getProfileMeta(p: ScooterProfile): ProfileMeta {
  return PROFILES.find((x) => x.key === p) ?? PROFILES[0];
}

/**
 * React hook returning `[profile, setProfile]`.
 * Re-renders whenever the profile changes (in this tab via the custom
 * event, or in another tab via the standard `storage` event).
 */
export function useProfile(): [ScooterProfile | null, (p: ScooterProfile) => void] {
  const [profile, setLocal] = useState<ScooterProfile | null>(() => getProfile());

  useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<ScooterProfile>).detail;
      setLocal(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setLocal(getProfile());
    };
    window.addEventListener(CHANGE_EVENT, onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return [profile, setProfile];
}
