import { useCallback, useEffect, useRef } from "react";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Capacitor } from "@capacitor/core";
import { scooter } from "@/lib/m365/scooter-service";
import { useScooterStore } from "@/store/scooter-store";
import type { DiscoveredDevice } from "@/lib/m365/scooter-service";

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
      });
      await haptic(ImpactStyle.Medium);
      store.setState("connected");

      // Validate the GATT layout BEFORE any read/write so we never talk
      // M365 protocol to a non-M365 peripheral that just happens to advertise
      // a similar name.
      const hs = await scooter.handshake({ onLog: store.appendLog });
      store.setHandshake(hs);
      if (!hs.ok) {
        store.setError(`Handshake failed: ${hs.reason}`);
        return;
      }

      const info = await scooter.readInfo();
      store.setInfo(info);
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

  return {
    ...store,
    scan,
    connect,
    disconnect,
    writeSerialAndVerify,
    refreshInfo,
    isNative: Capacitor.isNativePlatform(),
  };
}
