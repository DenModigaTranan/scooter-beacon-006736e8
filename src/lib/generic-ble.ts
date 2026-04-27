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
  /**
   * Optional request/response hook. Invoked when the central writes to
   * this characteristic. Use the `pushNotify` callback to push reply
   * frames out of any sibling `notify` characteristic on the same mock
   * peripheral — this is how the Ninebot RX→TX request/response shape
   * is emulated without needing real BLE round-trips.
   */
  onWrite?: (
    value: Uint8Array,
    ctx: {
      pushNotify: (charUuid: string, bytes: Uint8Array) => void;
    },
  ) => void;
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
 * Build a mock Ninebot peripheral with a working slice of the public BLE
 * protocol: 3-phase auth handshake (PRE_COMM → SET_PWD → AUTH_OK) plus
 * register reads for battery, speed, mode, odometer, and lock — the same
 * registers the production decoder polls. State is held in this closure so
 * a "ride" simulation can drift between polls (battery slowly drains,
 * speed wanders, odometer accumulates) without the catalog entry having
 * to expose its internals.
 *
 * Why this lives next to the mock catalog instead of in `src/lib/ninebot/`:
 *   the simulator IS the mock device — it speaks the same wire protocol
 *   the production decoder consumes, and the only entry point is the
 *   `onWrite` hook on the RX characteristic. Putting it here keeps the
 *   "what does the preview see?" surface in one file.
 */
function buildNinebotMockServices(): MockService[] {
  // Lazy import to avoid pulling the protocol module into bundles that
  // never touch a Ninebot — the catalog is module-evaluated at startup.
  // Synchronous require would create a cycle; we rely on the encoder
  // helpers being pure to inline the small subset we need below.
  const NB_SERVICE = "6e400001-b5a3-f393-e0a9-006e696e65626f74";
  const NB_RX      = "6e400002-b5a3-f393-e0a9-006e696e65626f74";
  const NB_TX      = "6e400003-b5a3-f393-e0a9-006e696e65626f74";

  // ---- Wire helpers (kept local to avoid a circular import) ------------
  const HDR = [0x5a, 0xa5];
  const APP = 0x21, ESC = 0x20, BLE = 0x22;
  const CMD_READ = 0x01, CMD_REPLY = 0x04;
  const CMD_PRE = 0x5b, CMD_SETPWD = 0x5c, CMD_AUTH_OK = 0x5d;
  const REG = { BATTERY: 0xb1, SPEED: 0xb5, MODE: 0x75, ODO: 0x29, LOCK: 0x70 };

  const cks = (body: Uint8Array): number => {
    let s = 0; for (let i = 0; i < body.length; i++) s += body[i];
    return ~s & 0xffff;
  };
  const buildFrame = (src: number, dst: number, cmd: number, arg: number, payload: Uint8Array): Uint8Array => {
    const body = new Uint8Array(1 + 4 + payload.length);
    body[0] = payload.length; body[1] = src; body[2] = dst; body[3] = cmd; body[4] = arg;
    body.set(payload, 5);
    const c = cks(body);
    const out = new Uint8Array(2 + body.length + 2);
    out[0] = HDR[0]; out[1] = HDR[1];
    out.set(body, 2);
    out[out.length - 2] = c & 0xff;
    out[out.length - 1] = (c >>> 8) & 0xff;
    return out;
  };
  const parseFrame = (buf: Uint8Array): { src: number; dst: number; cmd: number; arg: number; payload: Uint8Array; consumed: number } | null => {
    if (buf.length < 9) return null;
    if (buf[0] !== HDR[0] || buf[1] !== HDR[1]) return null;
    const len = buf[2];
    const total = 2 + 1 + 4 + len + 2;
    if (buf.length < total) return null;
    const body = buf.slice(2, 2 + 1 + 4 + len);
    const got = buf[total - 2] | (buf[total - 1] << 8);
    if (cks(body) !== got) return null;
    return { src: body[1], dst: body[2], cmd: body[3], arg: body[4], payload: body.slice(5), consumed: total };
  };

  // ---- Simulated rolling state ----------------------------------------
  // Initial values picked to look like a half-charged scooter at rest;
  // every poll cycle nudges them so the tiles visibly animate even when
  // nothing else on the screen is updating.
  const state = {
    authed: false,
    batteryPct: 73,
    speedHundredths: 0,        // units: 0.01 km/h
    mode: 1,                   // 0=drive, 1=eco, 2=sport
    odoHundredths: 1284_55,    // units: 0.01 km → starts at 1284.55 km
    locked: 1 as 0 | 1,
    sessionKey: null as Uint8Array | null,
    lastPollAt: Date.now(),
  };

  /** Drift the simulated values a small amount on every poll so the UI
   *  shows something plausible without becoming a strobe. Time-based so
   *  variations don't depend on poll cadence. */
  const driftRide = () => {
    const now = Date.now();
    const dt = Math.min(2_000, now - state.lastPollAt);
    state.lastPollAt = now;
    // Speed: random walk in [0, 28] km/h, biased toward the previous value.
    const target = Math.random() < 0.4 ? 0 : 12 + Math.random() * 14;
    const cur = state.speedHundredths / 100;
    const next = cur + (target - cur) * (dt / 1500);
    state.speedHundredths = Math.round(Math.max(0, Math.min(28, next)) * 100);
    // Odometer accumulates from the average speed over `dt`.
    const avgKmh = (cur + next) / 2;
    state.odoHundredths += Math.round((avgKmh * (dt / 3_600_000)) * 100);
    // Battery: drain ~1% every ~45s of "ride", clamp at 5 so the tile
    // never goes empty in a demo session.
    if (Math.random() < dt / 45_000) {
      state.batteryPct = Math.max(5, state.batteryPct - 1);
    }
  };

  const replyRead = (target: number, register: number): Uint8Array | null => {
    driftRide();
    switch (register) {
      case REG.BATTERY:
        return buildFrame(target, APP, CMD_REPLY, register, Uint8Array.from([state.batteryPct]));
      case REG.SPEED: {
        const v = state.speedHundredths;
        return buildFrame(target, APP, CMD_REPLY, register, Uint8Array.from([v & 0xff, (v >>> 8) & 0xff]));
      }
      case REG.MODE:
        return buildFrame(target, APP, CMD_REPLY, register, Uint8Array.from([state.mode]));
      case REG.ODO: {
        const v = state.odoHundredths >>> 0;
        return buildFrame(target, APP, CMD_REPLY, register, Uint8Array.from([
          v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff,
        ]));
      }
      case REG.LOCK:
        return buildFrame(target, APP, CMD_REPLY, register, Uint8Array.from([state.locked]));
      default:
        return null;
    }
  };

  // ---- RX onWrite handler — the heart of the simulator ----------------
  // Buffers incoming bytes so the framer survives writes that span
  // multiple ATT MTUs (real-world Ninebot frames hit 30+ bytes; small
  // MTUs split them across two writes).
  let rxBuffer = new Uint8Array(0);
  const onRxWrite = (
    value: Uint8Array,
    ctx: { pushNotify: (charUuid: string, bytes: Uint8Array) => void },
  ) => {
    const merged = new Uint8Array(rxBuffer.length + value.length);
    merged.set(rxBuffer, 0); merged.set(value, rxBuffer.length);
    rxBuffer = merged;
    while (rxBuffer.length > 0) {
      const r = parseFrame(rxBuffer);
      if (!r) {
        // Resync: drop a byte if we don't even have a header alignment.
        if (rxBuffer.length >= 2 && (rxBuffer[0] !== HDR[0] || rxBuffer[1] !== HDR[1])) {
          rxBuffer = rxBuffer.slice(1);
          continue;
        }
        break;
      }
      rxBuffer = rxBuffer.slice(r.consumed);
      // Auth handshake — accept either order, gate register reads on it.
      if (r.cmd === CMD_PRE && r.dst === BLE) {
        // Echo the APP nonce back as the device nonce; production firmware
        // would mix it into a key derivation, but for the mock we just
        // need the shape to round-trip cleanly.
        const deviceNonce = r.payload.length === 16
          ? r.payload
          : new Uint8Array(16);
        ctx.pushNotify(NB_TX, buildFrame(BLE, APP, CMD_PRE, 0x01, deviceNonce));
        continue;
      }
      if (r.cmd === CMD_SETPWD && r.dst === BLE) {
        state.sessionKey = r.payload.length === 16 ? new Uint8Array(r.payload) : null;
        state.authed = true;
        ctx.pushNotify(NB_TX, buildFrame(BLE, APP, CMD_AUTH_OK, 0x00, Uint8Array.from([0x01])));
        continue;
      }
      // Register reads — gated on completed auth, mirroring real firmware.
      if (r.cmd === CMD_READ) {
        if (!state.authed) {
          // Silently drop pre-auth reads; the session layer's per-poll
          // timeout will surface as "—" in the UI until the handshake
          // lands, matching real device behaviour.
          continue;
        }
        const reply = replyRead(r.dst, r.arg);
        if (reply) ctx.pushNotify(NB_TX, reply);
      }
    }
  };

  return [
    {
      uuid: "00001800-0000-1000-8000-00805f9b34fb",
      characteristics: [
        { uuid: "00002a00-0000-1000-8000-00805f9b34fb", properties: ["read"], value: enc.encode("Ninebot_Max_5F2A"), hint: "utf8" },
      ],
    },
    {
      uuid: NB_SERVICE,
      characteristics: [
        // RX: APP → device. Writable; produces TX notifications via onWrite.
        {
          uuid: NB_RX,
          properties: ["write", "writeWithoutResponse"],
          value: u8(),
          hint: "hex",
          onWrite: onRxWrite,
        },
        // TX: device → APP. Pure notify — no tick/interval; the simulator
        // pushes here in response to RX writes (request/response shape).
        {
          uuid: NB_TX,
          properties: ["notify"],
          value: u8(),
          hint: "hex",
        },
      ],
    },
  ];
}


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
      // Request/response hook: lets a writable char synthesize a reply on
      // any sibling notify characteristic. We resolve by service+char on
      // every push so adding new mock characteristics is local to the
      // catalog entry — no plumbing here.
      if (c.onWrite) {
        const deviceId = this.connectedId;
        const pushNotify = (replyCharUuid: string, bytes: Uint8Array) => {
          const replyChar = findMockChar(p, serviceUuid, replyCharUuid);
          if (!replyChar) return;
          replyChar.value = new Uint8Array(bytes);
          const key = charKey(serviceUuid, replyCharUuid);
          const compositeKey = `${deviceId}::${key}`;
          const out = new Uint8Array(bytes);
          this.mockListeners.get(compositeKey)?.forEach((l) => {
            try { l(out, deviceId, key); } catch { /* swallow */ }
          });
        };
        try { c.onWrite(new Uint8Array(value), { pushNotify }); }
        catch { /* swallow — mock-only diagnostic */ }
      }
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
      // until the first tick lands. Skipped for request/response-style
      // notify chars (no `tick` and no `notifyIntervalMs`) — those only
      // emit in response to writes, and an empty initial push would just
      // confuse a stateful framer (e.g. the Ninebot session decoder).
      const isRequestResponse = !c.tick && c.notifyIntervalMs == null;
      if (!isRequestResponse) {
        queueMicrotask(() => listener(new Uint8Array(c.value), deviceId, key));
      }

      if (!isRequestResponse && !this.mockTimers.has(compositeKey)) {
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
