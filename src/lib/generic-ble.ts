/**
 * Generic BLE scanner & connector.
 *
 * Independent of the M365 protocol stack — used by the "Generic BLE" profile
 * to let the user scan, inspect, and connect to any nearby BLE peripheral
 * (e.g. for protocol exploration or basic GATT browsing).
 *
 * On native Capacitor builds this uses @capacitor-community/bluetooth-le.
 * In the Lovable web preview BLE is not available, so we synthesise a small
 * fixed list of mock peripherals so the UI is fully reviewable.
 */

import { BleClient, type ScanResult } from "@capacitor-community/bluetooth-le";
import { Capacitor } from "@capacitor/core";

export interface GenericDevice {
  /** OS-supplied device id / BLE address. Stable per device. */
  deviceId: string;
  /** Local name as advertised, or "(unnamed)". */
  name: string;
  /** dBm. */
  rssi: number;
  /** Lowercased UUIDs advertised in the scan record. */
  serviceUuids: string[];
  /** Manufacturer ids → byte length (we don't surface payload here). */
  manufacturerIds: number[];
  /** True for entries fabricated in the web preview. */
  mock?: boolean;
}

export interface GenericServiceInfo {
  uuid: string;
  characteristics: GenericCharInfo[];
}

export interface GenericCharInfo {
  uuid: string;
  /** Properties as reported by the platform (lower-case strings). */
  properties: string[];
}

const isNative = Capacitor.isNativePlatform();

/** Lowercase + de-dup helper for advertised UUIDs. */
function normalizeUuids(uuids?: string[]): string[] {
  if (!uuids?.length) return [];
  return Array.from(new Set(uuids.map((u) => u.toLowerCase())));
}

class GenericBleService {
  private initialized = false;
  private connectedId: string | null = null;

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (isNative) {
      await BleClient.initialize({ androidNeverForLocation: true });
    }
    this.initialized = true;
  }

  /**
   * Start a scan for `durationMs`. The callback fires for every scan record;
   * the same device may be reported multiple times (RSSI updates).
   * Always resolves; rejection only on platform errors.
   */
  async scan(onDevice: (d: GenericDevice) => void, durationMs = 6000): Promise<void> {
    await this.initialize();

    if (!isNative) {
      // Web preview: emit a small fixture set spread over the scan window so
      // the UI shows progressive discovery instead of a single batch.
      const fixtures: GenericDevice[] = [
        { deviceId: "AA:BB:CC:00:00:01", name: "MIScooter1234", rssi: -52,
          serviceUuids: ["0000fe95-0000-1000-8000-00805f9b34fb"], manufacturerIds: [0x038f], mock: true },
        { deviceId: "AA:BB:CC:00:00:02", name: "Tile_1A2B", rssi: -71,
          serviceUuids: ["0000feed-0000-1000-8000-00805f9b34fb"], manufacturerIds: [0x004c], mock: true },
        { deviceId: "AA:BB:CC:00:00:03", name: "BT-Headset", rssi: -64,
          serviceUuids: ["0000110b-0000-1000-8000-00805f9b34fb"], manufacturerIds: [], mock: true },
        { deviceId: "AA:BB:CC:00:00:04", name: "(unnamed)", rssi: -88,
          serviceUuids: [], manufacturerIds: [0x0006], mock: true },
        { deviceId: "AA:BB:CC:00:00:05", name: "Garmin_Watch", rssi: -59,
          serviceUuids: ["0000180d-0000-1000-8000-00805f9b34fb"], manufacturerIds: [0x0087], mock: true },
      ];
      const step = Math.max(200, Math.floor(durationMs / (fixtures.length + 1)));
      for (let i = 0; i < fixtures.length; i++) {
        await new Promise((r) => setTimeout(r, step));
        onDevice(fixtures[i]);
      }
      return;
    }

    await BleClient.requestLEScan({ allowDuplicates: false }, (res: ScanResult) => {
      const ad = res.scanRecord?.manufacturerData ?? {};
      onDevice({
        deviceId: res.device.deviceId,
        name: res.device.name || res.localName || "(unnamed)",
        rssi: res.rssi ?? -100,
        serviceUuids: normalizeUuids(res.scanRecord?.serviceUuids),
        manufacturerIds: Object.keys(ad).map((k) => Number(k)).filter((n) => !Number.isNaN(n)),
      });
    });

    await new Promise((r) => setTimeout(r, durationMs));
    try { await BleClient.stopLEScan(); } catch { /* ignore */ }
  }

  /** Best-effort cancel of an in-flight scan. */
  async stopScan(): Promise<void> {
    if (!isNative) return;
    try { await BleClient.stopLEScan(); } catch { /* ignore */ }
  }

  /**
   * Connect to a peripheral. Resolves once GATT is connected, or rejects with
   * a human-readable Error. Calls `onDisconnect` if the link drops later.
   */
  async connect(deviceId: string, onDisconnect?: () => void): Promise<void> {
    await this.initialize();
    if (!isNative) {
      // Web preview: simulate a brief connect handshake.
      await new Promise((r) => setTimeout(r, 800));
      this.connectedId = deviceId;
      return;
    }
    await BleClient.connect(deviceId, () => {
      if (this.connectedId === deviceId) this.connectedId = null;
      onDisconnect?.();
    });
    this.connectedId = deviceId;
  }

  async disconnect(): Promise<void> {
    if (!this.connectedId) return;
    const id = this.connectedId;
    this.connectedId = null;
    if (!isNative) return;
    try { await BleClient.disconnect(id); } catch { /* ignore */ }
  }

  getConnectedId(): string | null {
    return this.connectedId;
  }

  /**
   * Discover all services + characteristics on the connected peripheral.
   * Returns an empty array on the web preview.
   */
  async discoverServices(): Promise<GenericServiceInfo[]> {
    if (!this.connectedId) return [];
    if (!isNative) {
      // Mock GATT layout for the web preview.
      return [
        { uuid: "00001800-0000-1000-8000-00805f9b34fb", characteristics: [
          { uuid: "00002a00-0000-1000-8000-00805f9b34fb", properties: ["read"] },
          { uuid: "00002a01-0000-1000-8000-00805f9b34fb", properties: ["read"] },
        ]},
        { uuid: "0000180a-0000-1000-8000-00805f9b34fb", characteristics: [
          { uuid: "00002a29-0000-1000-8000-00805f9b34fb", properties: ["read"] },
          { uuid: "00002a24-0000-1000-8000-00805f9b34fb", properties: ["read"] },
        ]},
      ];
    }
    try {
      const services = await BleClient.getServices(this.connectedId);
      return services.map((s) => ({
        uuid: s.uuid.toLowerCase(),
        characteristics: s.characteristics.map((c) => ({
          uuid: c.uuid.toLowerCase(),
          properties: Object.entries(c.properties)
            .filter(([, v]) => v)
            .map(([k]) => k.toLowerCase()),
        })),
      }));
    } catch {
      return [];
    }
  }
}

export const genericBle = new GenericBleService();
