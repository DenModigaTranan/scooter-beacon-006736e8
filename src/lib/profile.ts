/**
 * Scooter brand / protocol profile.
 *
 * Persisted as a single string in localStorage, mirroring the convention
 * used by `catalog.ts`. Other modules read the active profile via
 * `getProfile()` or subscribe with the `useProfile()` hook.
 */

import { useEffect, useState } from "react";

export type ScooterProfile =
  | "xiaomi-m365"
  | "ninebot"
  | "ewheels"
  | "ewa"
  | "generic-ble";

/**
 * Profiles that ride on the Ninebot BLE protocol stack. E-wheels and EWA
 * scooters are commonly Ninebot-platform rebadges (especially the Max G30
 * and ES-series derivatives sold under those Nordic brand names), so they
 * route through the Ninebot screen and session.
 */
export const NINEBOT_COMPATIBLE_PROFILES: ScooterProfile[] = [
  "ninebot",
  "ewheels",
  "ewa",
];

export function isNinebotCompatible(p: ScooterProfile | null): boolean {
  return p !== null && NINEBOT_COMPATIBLE_PROFILES.includes(p);
}

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
    description:
      "M365, Pro, 1S, Essential, Pro 2, Mi 3 / 3 Lite, Mi 4 / 4 Pro / 4 Lite / 4 Ultra and common clones.",
    status: "supported",
  },
  {
    key: "ewheels",
    label: "E-wheels",
    shortLabel: "E-wheels",
    description:
      "E-wheels (Nordic rebadged Ninebot platform) — Max-class, ES-class and similar models. Uses the Ninebot BLE stack.",
    status: "supported",
  },
  {
    key: "ewa",
    label: "EWA",
    shortLabel: "EWA",
    description:
      "EWA scooters built on the Ninebot platform. Uses the Ninebot BLE stack for telemetry and controls.",
    status: "supported",
  },
  {
    key: "generic-ble",
    label: "Other / Generic BLE",
    shortLabel: "Generic",
    description: "Any BLE peripheral. Live scanner with GATT discovery — no protocol writes.",
    status: "supported",
  },
];

const STORAGE_KEY = "scootflash:profile";
const CHANGE_EVENT = "scootflash:profile-changed";

const VALID_PROFILES: ScooterProfile[] = [
  "xiaomi-m365",
  "ninebot",
  "ewheels",
  "ewa",
  "generic-ble",
];

/** Read the saved profile, or `null` if the user hasn't picked one yet. */
export function getProfile(): ScooterProfile | null {
  if (typeof localStorage === "undefined") return null;
  const v = localStorage.getItem(STORAGE_KEY) as ScooterProfile | null;
  if (v && VALID_PROFILES.includes(v)) return v;
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
