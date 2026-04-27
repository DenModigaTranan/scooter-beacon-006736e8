/**
 * Generic BLE scanner & connector.
 *
 * Independent of the M365 protocol stack — used by the "Generic BLE" profile
 * to let the user scan, inspect, and connect to any nearby BLE peripheral
 * (e.g. for protocol exploration or basic GATT browsing).
 *
 * On native Capacitor builds this uses @capacitor-community/bluetooth-le.
 * In the Lovable web preview BLE is not available, so we synthesise a small
 * fixed list of mock peripherals — each with a realistic GATT layout, live
 * read/write semantics, and periodic notifications — so the entire UI is
 * exercisable without hardware.
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

// ============================================================================
// Mock peripheral catalog (web preview only)
// ============================================================================

/**
 * A single mock characteristic. `value` is the current bytes; for `notify`
 * characteristics, `tick(prev)` returns the next value emitted on the
 * notification interval.
 */
interface MockChar {
  uuid: string;
  properties: ("read" | "write" | "writeWithoutResponse" | "notify" | "indicate")[];
  /** Initial / current value. */
  value: Uint8Array;
  /** Notification cadence (ms). Required when properties include "notify". */
  notifyIntervalMs?: number;
  /** Produces the next notification payload. */
  tick?: (prev: Uint8Array) => Uint8Array;
  /** Pretty-print hint surfaced on the UI. */
  hint?: "utf8" | "uint8" | "uint16le" | "hex";
}

interface MockService {
  uuid: string;
  characteristics: MockChar[];
}

interface MockPeripheral {
  device: GenericDevice;
  services: MockService[];
}

const enc = new TextEncoder();

function u8(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}
function u16le(n: number): Uint8Array {
  return u8(n & 0xff, (n >>> 8) & 0xff);
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Pre-built mock catalog. Each entry models a distinct device class so the
 * preview exercises read-only metadata, periodic telemetry notifications,
 * and writable control points.
 */
const MOCK_CATALOG: MockPeripheral[] = [
  // 1) Xiaomi-style scooter — advertises FE95 only (intentionally no GATT
  //    write so the M365 handshake cannot succeed against it from this
  //    Generic screen — keeps mock semantics realistic).
  {
    device: {
      deviceId: "AA:BB:CC:00:00:01", name: "MIScooter1234", rssi: -52,
      serviceUuids: ["0000fe95-0000-1000-8000-00805f9b34fb"],
      manufacturerIds: [0x038f], mock: true,
    },
    services: [
      {
        uuid: "00001800-0000-1000-8000-00805f9b34fb",
        characteristics: [
          { uuid: "00002a00-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("MIScooter1234"), hint: "utf8" },
        ],
      },
      {
        uuid: "0000fe95-0000-1000-8000-00805f9b34fb",
        characteristics: [
          // Looks like the M365 frame characteristic but without a notify pump.
          { uuid: "00000016-0000-1000-8000-00805f9b34fb", properties: ["read"], value: u8(0x55, 0xaa), hint: "hex" },
        ],
      },
    ],
  },

  // 2) Tile-style tracker — battery + ringer control point.
  {
    device: {
      deviceId: "AA:BB:CC:00:00:02", name: "Tile_1A2B", rssi: -71,
      serviceUuids: ["0000feed-0000-1000-8000-00805f9b34fb", "0000180f-0000-1000-8000-00805f9b34fb"],
      manufacturerIds: [0x004c], mock: true,
    },
    services: [
      {
        uuid: "0000180a-0000-1000-8000-00805f9b34fb",
        characteristics: [
          { uuid: "00002a29-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("Tile, Inc."), hint: "utf8" },
          { uuid: "00002a24-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("Mate Pro"),   hint: "utf8" },
        ],
      },
      {
        uuid: "0000180f-0000-1000-8000-00805f9b34fb",
        characteristics: [
          {
            uuid: "00002a19-0000-1000-8000-00805f9b34fb",
            properties: ["read", "notify"],
            value: u8(87),
            notifyIntervalMs: 4000,
            // Slowly drifts down to 5%, then resets to 100 — looks alive.
            tick: (prev) => {
              const v = prev[0] <= 5 ? 100 : prev[0] - 1;
              return u8(v);
            },
            hint: "uint8",
          },
        ],
      },
      {
        uuid: "0000feed-0000-1000-8000-00805f9b34fb",
        characteristics: [
          // Control point: write 0x01 to "ring", anything else logs.
          { uuid: "0000feee-0000-1000-8000-00805f9b34fb", properties: ["write", "writeWithoutResponse"], value: u8(0x00), hint: "hex" },
        ],
      },
    ],
  },

  // 3) Garmin-style heart-rate monitor — fast HR notifications.
  {
    device: {
      deviceId: "AA:BB:CC:00:00:05", name: "Garmin_Watch", rssi: -59,
      serviceUuids: ["0000180d-0000-1000-8000-00805f9b34fb"],
      manufacturerIds: [0x0087], mock: true,
    },
    services: [
      {
        uuid: "0000180d-0000-1000-8000-00805f9b34fb",
        characteristics: [
          {
            uuid: "00002a37-0000-1000-8000-00805f9b34fb",
            properties: ["notify"],
            value: u8(0x00, 72),
            notifyIntervalMs: 1000,
            // Walks BPM in [55, 165] using a small random step.
            tick: (prev) => {
              const cur = prev[1] || 70;
              const step = Math.round((Math.random() - 0.5) * 6);
              const next = clamp(cur + step, 55, 165);
              return u8(0x00, next);
            },
            hint: "uint8",
          },
          { uuid: "00002a38-0000-1000-8000-00805f9b34fb", properties: ["read"], value: u8(0x01), hint: "uint8" },
        ],
      },
      {
        uuid: "0000180a-0000-1000-8000-00805f9b34fb",
        characteristics: [
          { uuid: "00002a29-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("Garmin"),       hint: "utf8" },
          { uuid: "00002a24-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("Forerunner"),   hint: "utf8" },
          { uuid: "00002a26-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("v12.04"),       hint: "utf8" },
        ],
      },
    ],
  },

  // 4) Generic BLE headset — environmental temp sensor that ramps a uint16.
  {
    device: {
      deviceId: "AA:BB:CC:00:00:03", name: "BT-Headset", rssi: -64,
      serviceUuids: ["0000110b-0000-1000-8000-00805f9b34fb", "0000181a-0000-1000-8000-00805f9b34fb"],
      manufacturerIds: [], mock: true,
    },
    services: [
      {
        uuid: "0000181a-0000-1000-8000-00805f9b34fb",
        characteristics: [
          {
            // Temperature, units 0.01 °C, uint16 little-endian.
            uuid: "00002a6e-0000-1000-8000-00805f9b34fb",
            properties: ["read", "notify"],
            value: u16le(2150),
            notifyIntervalMs: 2000,
            tick: (prev) => {
              const v = prev[0] | (prev[1] << 8);
              const next = clamp(v + Math.round((Math.random() - 0.5) * 30), 1800, 2600);
              return u16le(next);
            },
            hint: "uint16le",
          },
        ],
      },
    ],
  },

  // 5) Ninebot-style scooter — advertises the custom Ninebot service UUID
  //    whose tail bytes spell "\0ninebot" in ASCII, plus the Segway company
  //    ID (0x0810). Used to verify the scan-time Ninebot detector renders a
  //    confident "Ninebot" badge in the device list.
  {
    device: {
      deviceId: "AA:BB:CC:00:00:06", name: "Ninebot_Max_5F2A", rssi: -63,
      serviceUuids: ["6e400001-b5a3-f393-e0a9-006e696e65626f74"],
      manufacturerIds: [0x0810], mock: true,
    },
    services: [
      {
        uuid: "00001800-0000-1000-8000-00805f9b34fb",
        characteristics: [
          { uuid: "00002a00-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("Ninebot_Max_5F2A"), hint: "utf8" },
        ],
      },
    ],
  },

  // 6) Unnamed beacon — read-only manufacturer payload.
  {
    device: {
      deviceId: "AA:BB:CC:00:00:04", name: "(unnamed)", rssi: -88,
      serviceUuids: [], manufacturerIds: [0x0006], mock: true,
    },
    services: [
      {
        uuid: "00001800-0000-1000-8000-00805f9b34fb",
        characteristics: [
          { uuid: "00002a00-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("Beacon"), hint: "utf8" },
        ],
      },
    ],
  },
];

function findMock(deviceId: string): MockPeripheral | null {
  const k = deviceId.toUpperCase();
  return MOCK_CATALOG.find((p) => p.device.deviceId.toUpperCase() === k) ?? null;
}

function findMockChar(p: MockPeripheral, serviceUuid: string, charUuid: string): MockChar | null {
  const s = p.services.find((x) => x.uuid.toLowerCase() === serviceUuid.toLowerCase());
  if (!s) return null;
  return s.characteristics.find((c) => c.uuid.toLowerCase() === charUuid.toLowerCase()) ?? null;
}

// ============================================================================
// Public types: characteristic I/O
// ============================================================================

export type NotifyListener = (value: Uint8Array, deviceId: string, charKey: string) => void;

/** Stable string key for a (service, characteristic) pair. */
export function charKey(service: string, characteristic: string): string {
  return `${service.toLowerCase()}::${characteristic.toLowerCase()}`;
}

// ============================================================================
// Service implementation
// ============================================================================

class GenericBleService {
  private initialized = false;
  private connectedId: string | null = null;

  // Mock-only state ---------------------------------------------------------
  /** Active notification timers per (deviceId, charKey). */
  private mockTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Listeners per (deviceId, charKey). */
  private mockListeners = new Map<string, Set<NotifyListener>>();

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (isNative) {
      await BleClient.initialize({ androidNeverForLocation: true });
    }
    this.initialized = true;
  }

  // --- scanning -----------------------------------------------------------

  async scan(onDevice: (d: GenericDevice) => void, durationMs = 6000): Promise<void> {
    await this.initialize();

    if (!isNative) {
      // Web preview: emit fixtures spread over the scan window so the UI
      // shows progressive discovery instead of a single batch.
      const fixtures = MOCK_CATALOG.map((p) => p.device);
      const step = Math.max(200, Math.floor(durationMs / (fixtures.length + 1)));
      for (let i = 0; i < fixtures.length; i++) {
        await new Promise((r) => setTimeout(r, step));
        onDevice(fixtures[i]);
      }
      return;
    }

    await BleClient.requestLEScan({ allowDuplicates: false }, (res: ScanResult) => {
      const ad = res.manufacturerData ?? {};
      onDevice({
        deviceId: res.device.deviceId,
        name: res.device.name || res.localName || "(unnamed)",
        rssi: res.rssi ?? -100,
        serviceUuids: normalizeUuids(res.uuids),
        manufacturerIds: Object.keys(ad).map((k) => Number(k)).filter((n) => !Number.isNaN(n)),
      });
    });

    await new Promise((r) => setTimeout(r, durationMs));
    try { await BleClient.stopLEScan(); } catch { /* ignore */ }
  }

  async stopScan(): Promise<void> {
    if (!isNative) return;
    try { await BleClient.stopLEScan(); } catch { /* ignore */ }
  }

  // --- connection ---------------------------------------------------------

  async connect(deviceId: string, onDisconnect?: () => void): Promise<void> {
    await this.initialize();
    if (!isNative) {
      // Mock: brief handshake delay so the UI shows a real "connecting" state.
      await new Promise((r) => setTimeout(r, 600 + Math.floor(Math.random() * 400)));
      // Tiny chance of a simulated failure for the unnamed beacon, just so
      // the error UI is reachable in preview without code changes.
      if (deviceId === "AA:BB:CC:00:00:04" && Math.random() < 0.25) {
        throw new Error("GATT connect failed: peer terminated link (mock)");
      }
      this.connectedId = deviceId;
      // Schedule a stochastic disconnect for the headset so subscribers can
      // observe the disconnect callback path. Bail if the user disconnects
      // first.
      if (deviceId === "AA:BB:CC:00:00:03") {
        setTimeout(() => {
          if (this.connectedId === deviceId) {
            this.tearDownMockNotifications(deviceId);
            this.connectedId = null;
            onDisconnect?.();
          }
        }, 30_000);
      }
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
    if (!isNative) {
      this.tearDownMockNotifications(id);
      return;
    }
    try { await BleClient.disconnect(id); } catch { /* ignore */ }
  }

  getConnectedId(): string | null {
    return this.connectedId;
  }

  // --- discovery ----------------------------------------------------------

  async discoverServices(): Promise<GenericServiceInfo[]> {
    if (!this.connectedId) return [];
    if (!isNative) {
      const p = findMock(this.connectedId);
      if (!p) return [];
      return p.services.map((s) => ({
        uuid: s.uuid,
        characteristics: s.characteristics.map((c) => ({
          uuid: c.uuid,
          properties: c.properties.map((x) => x.toLowerCase()),
        })),
      }));
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

  // --- characteristic I/O -------------------------------------------------

  /**
   * Read the current value of a characteristic. Throws on platform errors,
   * "not connected", "char not found", or "property not supported".
   */
  async readCharacteristic(serviceUuid: string, charUuid: string): Promise<Uint8Array> {
    if (!this.connectedId) throw new Error("Not connected");
    if (!isNative) {
      const p = findMock(this.connectedId);
      if (!p) throw new Error("Mock peripheral missing");
      const c = findMockChar(p, serviceUuid, charUuid);
      if (!c) throw new Error("Characteristic not found");
      if (!c.properties.includes("read")) throw new Error("Read not supported on this characteristic");
      // Simulate a tiny round-trip and a fresh copy so callers can't mutate
      // the live mock buffer.
      await new Promise((r) => setTimeout(r, 80));
      return new Uint8Array(c.value);
    }
    const dv = await BleClient.read(this.connectedId, serviceUuid, charUuid);
    return new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
  }

  /**
   * Write to a characteristic. `withResponse=true` uses the acknowledged
   * write path. Updates the mock characteristic buffer; if the buffer is
   * also readable, subsequent reads observe the new value.
   */
  async writeCharacteristic(
    serviceUuid: string,
    charUuid: string,
    value: Uint8Array,
    withResponse = true,
  ): Promise<void> {
    if (!this.connectedId) throw new Error("Not connected");
    if (!isNative) {
      const p = findMock(this.connectedId);
      if (!p) throw new Error("Mock peripheral missing");
      const c = findMockChar(p, serviceUuid, charUuid);
      if (!c) throw new Error("Characteristic not found");
      const wantedProp = withResponse ? "write" : "writeWithoutResponse";
      if (!c.properties.includes(wantedProp) && !c.properties.includes("write")) {
        throw new Error(`${wantedProp} not supported on this characteristic`);
      }
      await new Promise((r) => setTimeout(r, withResponse ? 90 : 30));
      c.value = new Uint8Array(value);
      return;
    }
    const dv = new DataView(value.buffer, value.byteOffset, value.byteLength);
    if (withResponse) {
      await BleClient.write(this.connectedId, serviceUuid, charUuid, dv);
    } else {
      await BleClient.writeWithoutResponse(this.connectedId, serviceUuid, charUuid, dv);
    }
  }

  /**
   * Subscribe to notifications/indications. Returns an unsubscribe function.
   * Mock peripherals tick on their declared `notifyIntervalMs`. Multiple
   * listeners on the same characteristic share a single timer.
   */
  async startNotifications(
    serviceUuid: string,
    charUuid: string,
    listener: NotifyListener,
  ): Promise<() => Promise<void>> {
    if (!this.connectedId) throw new Error("Not connected");
    const deviceId = this.connectedId;
    const key = charKey(serviceUuid, charUuid);
    const compositeKey = `${deviceId}::${key}`;

    if (!isNative) {
      const p = findMock(deviceId);
      if (!p) throw new Error("Mock peripheral missing");
      const c = findMockChar(p, serviceUuid, charUuid);
      if (!c) throw new Error("Characteristic not found");
      if (!c.properties.includes("notify") && !c.properties.includes("indicate")) {
        throw new Error("Notify/indicate not supported on this characteristic");
      }

      let set = this.mockListeners.get(compositeKey);
      if (!set) {
        set = new Set();
        this.mockListeners.set(compositeKey, set);
      }
      set.add(listener);

      // Push the current value immediately so the UI doesn't sit blank
      // until the first tick lands.
      queueMicrotask(() => listener(new Uint8Array(c.value), deviceId, key));

      if (!this.mockTimers.has(compositeKey)) {
        const interval = c.notifyIntervalMs ?? 1500;
        const timer = setInterval(() => {
          if (this.connectedId !== deviceId) {
            this.tearDownMockNotifications(deviceId);
            return;
          }
          c.value = c.tick ? c.tick(c.value) : c.value;
          const out = new Uint8Array(c.value);
          this.mockListeners.get(compositeKey)?.forEach((l) => {
            try { l(out, deviceId, key); } catch { /* swallow */ }
          });
        }, interval);
        this.mockTimers.set(compositeKey, timer);
      }

      return async () => {
        const s = this.mockListeners.get(compositeKey);
        s?.delete(listener);
        if (!s || s.size === 0) {
          const t = this.mockTimers.get(compositeKey);
          if (t) clearInterval(t);
          this.mockTimers.delete(compositeKey);
          this.mockListeners.delete(compositeKey);
        }
      };
    }

    await BleClient.startNotifications(deviceId, serviceUuid, charUuid, (dv) => {
      const out = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      listener(out, deviceId, key);
    });
    return async () => {
      try { await BleClient.stopNotifications(deviceId, serviceUuid, charUuid); } catch { /* ignore */ }
    };
  }

  /** Internal: tear down all mock timers + listener sets for a device. */
  private tearDownMockNotifications(deviceId: string): void {
    const prefix = `${deviceId}::`;
    for (const [k, t] of this.mockTimers) {
      if (k.startsWith(prefix)) {
        clearInterval(t);
        this.mockTimers.delete(k);
      }
    }
    for (const k of Array.from(this.mockListeners.keys())) {
      if (k.startsWith(prefix)) this.mockListeners.delete(k);
    }
  }

  /** True when the active session is a fabricated peripheral. */
  isMockSession(): boolean {
    return !isNative && !!this.connectedId && !!findMock(this.connectedId);
  }
}

export const genericBle = new GenericBleService();

// ============================================================================
// Formatting helpers (re-exported so the screen and any future logger share)
// ============================================================================

export function formatBytes(value: Uint8Array, hint?: GenericCharInfo["uuid"] | "utf8" | "uint8" | "uint16le" | "hex"): string {
  if (value.length === 0) return "(empty)";
  switch (hint) {
    case "utf8":
      try { return new TextDecoder("utf-8", { fatal: false }).decode(value); }
      catch { /* fallthrough */ }
      break;
    case "uint8":
      return String(value[0]);
    case "uint16le":
      if (value.length >= 2) return String(value[0] | (value[1] << 8));
      break;
  }
  // Default: hex.
  return Array.from(value).map((b) => b.toString(16).padStart(2, "0")).join(" ").toUpperCase();
}

/** Look up the rendering hint for a (service, characteristic) on a mock device. */
export function getMockHint(
  deviceId: string,
  serviceUuid: string,
  charUuid: string,
): "utf8" | "uint8" | "uint16le" | "hex" | undefined {
  const p = findMock(deviceId);
  if (!p) return undefined;
  const c = findMockChar(p, serviceUuid, charUuid);
  return c?.hint;
}
