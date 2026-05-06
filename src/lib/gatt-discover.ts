/**
 * Post-connect GATT service discovery helper.
 *
 * Many BLE peripherals don't include their primary service UUIDs in the
 * advertisement payload (especially when the local name uses up the limited
 * 31-byte advert space). For those devices, name-only profile detection is
 * the best we can do at scan time — but once we've actually connected, the
 * platform exposes the full GATT service table, which we can fold back into
 * the detection signals to dramatically improve accuracy.
 *
 * This module is a thin, isolated wrapper around `BleClient.getServices` so
 * the call site doesn't have to know about platform availability. On the
 * Lovable web preview (no native BLE) it's a no-op and returns an empty list.
 */

import { BleClient } from "@capacitor-community/bluetooth-le";
import { Capacitor } from "@capacitor/core";

/**
 * Read the primary service UUIDs exposed by an already-connected peripheral.
 * Always returns lowercase UUIDs for stable comparison. Errors are swallowed
 * — this is a best-effort augmentation, not a hard requirement.
 */
export async function discoverServiceUuids(deviceId: string): Promise<string[]> {
  if (!Capacitor.isNativePlatform()) return [];
  try {
    const services = await BleClient.getServices(deviceId);
    const out = new Set<string>();
    for (const s of services) {
      if (s?.uuid) out.add(s.uuid.toLowerCase());
    }
    return Array.from(out);
  } catch {
    return [];
  }
}
