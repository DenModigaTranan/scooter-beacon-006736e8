import { useCallback, useEffect, useRef } from "react";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Capacitor } from "@capacitor/core";
import { scooter } from "@/lib/m365/scooter-service";
import { useScooterStore } from "@/store/scooter-store";
import type { DiscoveredDevice } from "@/lib/m365/scooter-service";
import { upsertPairedProfile } from "@/lib/paired-profiles";
import { discoverServiceUuids } from "@/lib/gatt-discover";

const haptic = async (style: ImpactStyle = ImpactStyle.Light) => {
  if (!Capacitor.isNativePlatform()) return;
  try { await Haptics.impact({ style }); } catch { /* ignore */ }
};

export function useScooter() {
  const store = useScooterStore();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    scooter.initialize().catch((e) => store.setError(String(e)));
    return () => { scooter.disconnect().catch(() => {}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scan = useCallback(async () => {
    store.clearDevices();
    store.setState("scanning");
    store.setError(null);
    try {
      await scooter.scan((d) => store.addDevice(d), 6000);
      setTimeout(() => useScooterStore.getState().state === "scanning" && store.setState("idle"), 6200);
    } catch (e) {
      store.setError(String(e));
    }
  }, [store]);

  const connect = useCallback(async (device: DiscoveredDevice) => {
    store.setSelected(device);
    store.setState("connecting");
    store.setHandshake(null);
    try {
      await scooter.connect(device.deviceId, () => {
        store.setState("disconnected");
        store.setInfo(null);
        store.setTelemetry(null);
        store.setHandshake(null);
        store.setExtendedInfo(null);
      });
      await haptic(ImpactStyle.Medium);
      store.setState("connected");

      // Augment the device record with GATT-discovered service UUIDs. Many
      // peripherals (especially Ninebot/EWA/E-wheels rebadges) don't list
      // their primary service in the scan advertisement, so this fallback
      // gives CompatibilityBadge & profile detection a much stronger signal
      // than the BLE name alone.
      const gattUuids = await discoverServiceUuids(device.deviceId);
      if (gattUuids.length) {
        const advUuids = device.serviceUuids ?? [];
        const merged = Array.from(new Set([...advUuids, ...gattUuids]));
        store.setSelected({ ...device, serviceUuids: merged, gattServiceUuids: gattUuids });
      }

      // Validate the GATT layout BEFORE any read/write so we never talk
      // M365 protocol to a non-M365 peripheral that just happens to advertise
      // a similar name. Some peripherals (notably E-wheels rebadges and
      // first-connect-after-pairing on iOS) intermittently reject the ESC
      // probe on the very first attempt — give them one short retry before
      // giving up and tearing the link down.
      let hs = await scooter.handshake({ onLog: store.appendLog });
      if (!hs.ok) {
        store.appendLog(`! handshake: first attempt failed (${hs.reason}) — retrying once in 350ms`);
        await new Promise((r) => setTimeout(r, 350));
        hs = await scooter.handshake({ onLog: store.appendLog });
        if (hs.ok) store.appendLog(`✓ handshake: retry succeeded`);
      }
      store.setHandshake(hs);
      if (!hs.ok) {
        // Misclassification recovery: the badge / name suggested an M365-family
        // peripheral but the GATT layout (or ESC probe) disagreed. Tear the
        // link down completely so the user lands back at a clean "idle" state
        // — leaving a half-open BLE connection on a non-M365 device blocks
        // the next scan/connect on iOS and confuses our store, which would
        // still show the device as "connected" with stale `selected` data.
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        try { await scooter.disconnect(); } catch { /* link may already be gone */ }
        await haptic(ImpactStyle.Heavy);
        store.appendLog(`! handshake: aborting session — ${hs.reason}`);
        store.setSelected(null);
        store.setInfo(null);
        store.setTelemetry(null);
        store.setExtendedInfo(null);
        store.setError(
          `Handshake failed: ${hs.reason}. This device doesn't expose the expected M365 GATT layout — it may be misclassified by name. Disconnected.`
        );
        return;
      }

      const info = await scooter.readInfo();
      store.setInfo(info);
      // Persist (or refresh) the paired profile keyed by BLE address so the
      // user can re-connect with one tap from the Connect screen.
      upsertPairedProfile({ deviceId: device.deviceId, name: device.name }, info);
      // start telemetry polling
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        if (document.visibilityState !== "visible") return;
        const t = await scooter.pollTelemetry();
        store.setTelemetry(t);
      }, 600);
    } catch (e) {
      store.setError(String(e));
    }
  }, [store]);

  const disconnect = useCallback(async () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    await scooter.disconnect();
    store.setState("idle");
    store.setSelected(null);
    store.setInfo(null);
    store.setTelemetry(null);
    store.setHandshake(null);
    store.setExtendedInfo(null);
  }, [store]);

  const writeSerialAndVerify = useCallback(async (s: string, maxAttempts = 1) => {
    const result = await scooter.writeSerialAndVerify(s, maxAttempts);
    // Always refresh the panel from the latest read so the UI reflects truth,
    // success or failure.
    const info = await scooter.readInfo();
    store.setInfo(info);
    if (result.ok) await haptic(ImpactStyle.Heavy);
    return result;
  }, [store]);

  const refreshInfo = useCallback(async () => {
    const info = await scooter.readInfo();
    store.setInfo(info);
  }, [store]);

  const rerunHandshake = useCallback(async () => {
    const hs = await scooter.handshake({ onLog: store.appendLog });
    store.setHandshake(hs);
    return hs;
  }, [store]);

  /**
   * Read the extended identifier set (model id, COC, BLE/BMS hw versions,
   * BMS health & cycles, last error code) and stash it in the store.
   * Returns the snapshot so callers can also display it inline.
   */
  const refreshExtendedInfo = useCallback(async () => {
    const selected = useScooterStore.getState().selected;
    const ext = await scooter.readExtendedInfo(selected?.deviceId);
    store.setExtendedInfo(ext);
    return ext;
  }, [store]);

  return {
    ...store,
    scan,
    connect,
    disconnect,
    writeSerialAndVerify,
    refreshInfo,
    rerunHandshake,
    refreshExtendedInfo,
    isNative: Capacitor.isNativePlatform(),
  };
}
