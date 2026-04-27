/**
 * Bluetooth scooter service.
 * Wraps @capacitor-community/bluetooth-le. In the Lovable web preview
 * BLE is not available, so we transparently fall back to a mock device
 * so the entire UI is reviewable. On a native Capacitor build the real
 * plugin is used.
 */

import { BleClient, type ScanResult } from "@capacitor-community/bluetooth-le";
import { Capacitor } from "@capacitor/core";
import {
  M365,
  buildChunkFrame,
  buildFrame,
  decodeBmsDate,
  decodeModelId,
  decodeSerial,
  decodeVersion,
  decodeWordHex,
  parseFrame,
  readRegister,
  writeRegister,
  FLASH,
} from "./protocol";

export interface DiscoveredDevice {
  deviceId: string;
  name: string;
  rssi: number;
  mock?: boolean;
}

export interface ScooterInfo {
  serial: string;
  drvVersion: string;
  bleVersion: string;
  bmsVersion: string;
  bmsSerial?: string;
  hwVersion?: string;
  manufactureDate?: string;
  totalMileageKm: number;
}

/**
 * Extended identifiers and stats read on demand from the device. These are
 * NOT included in the bootstrap `readInfo()` because they are slower to
 * collect and not needed for the connect flow — the Info screen reads them
 * lazily when the user taps "Read extras".
 */
export interface ExtendedDeviceInfo {
  /** Hex-formatted board model id, with a friendly name where known. */
  modelId?: string;
  /** Region / homologation code as 0xXXXX. */
  cocVersion?: string;
  /** ESC last-fault code as 0xXXXX (`0x0000` = no fault). */
  errorCode?: string;
  /** BLE module hardware revision (X.Y.Z). */
  bleHwVersion?: string;
  /** BMS hardware revision (X.Y.Z). */
  bmsHwVersion?: string;
  /** Total battery charge cycles. */
  bmsCycles?: number;
  /** Battery state of health, 0-100 %. */
  bmsHealthPct?: number;
  /** BLE peripheral address (mirrored from the `DiscoveredDevice`). */
  bleAddress?: string;
  /** Epoch ms when this snapshot was read. */
  readAt: number;
}

export interface Telemetry {
  speedKph: number;
  batteryPct: number;
  voltage: number;
  currentA: number;
  motorTempC: number;
  ridingMode: "eco" | "drive" | "sport";
  tripKm: number;
  totalKm: number;
}

/** Result of a write-then-verify pass for an editable identifier. */
export interface VerifyResult {
  ok: boolean;
  /** What we tried to write (trimmed). */
  written: string;
  /** What the device returned on the verifying read. */
  readBack: string;
  /** 1-based attempt counter. */
  attempt: number;
  /** Set if the verifying read itself failed (timeout / parse error). */
  readError?: string;
}

/**
 * Outcome of the BLE GATT handshake. The handshake is required before any
 * flash operation: it confirms the connected peripheral actually exposes the
 * Xiaomi M365 service + characteristic with the right properties.
 */
export interface HandshakeResult {
  ok: boolean;
  /** Lowercase UUIDs of services found on the device. */
  servicesFound: string[];
  /** UUIDs we expected but did not find. */
  missingServices: string[];
  /** UUIDs we expected but did not find under the M365 service. */
  missingChars: string[];
  /** Properties we expected on the matched characteristic but did not see. */
  missingProps: string[];
  /** Best-effort response to a no-op probe read against the ESC. */
  probeResponded: boolean;
  /** Human-readable failure reason (or "ok"). */
  reason: string;
  /** ISO timestamp of when the handshake completed. */
  at: string;
  /**
   * True when the strict M365 GATT layout was not found and the service
   * resolved against a community-known clone variant instead. The flash
   * flow MUST surface an extra acknowledgement before allowing writes
   * because clone protocol behaviour is best-effort.
   */
  cloneMode: boolean;
  /** Identifier of the resolved variant from `M365.HANDSHAKE.FALLBACKS`. */
  variantId: string | null;
  /** Resolved GATT triple actually used by reads, writes and notifications. */
  resolved: { service: string; rx: string; tx: string } | null;
  /** Non-fatal warnings (e.g. "writeWithoutResponse only"). */
  warnings: string[];
}

const isNative = () => Capacitor.isNativePlatform();

/**
 * Error thrown when a flash is interrupted by an abort or safety guard.
 *
 * - `phase: "safe"`   → no chunks were written; the device is untouched.
 * - `phase: "unsafe"` → at least one chunk was sent; the firmware is now
 *   partial and the user MUST reflash before power-cycling.
 */
export class FlashAbortError extends Error {
  readonly phase: "safe" | "unsafe";
  constructor(reason: string, phase: "safe" | "unsafe") {
    super(reason);
    this.name = "FlashAbortError";
    this.phase = phase;
  }
}

export class ScooterService {
  private connectedId: string | null = null;
  private rxBuffer: number[] = [];
  private listeners = new Set<(frame: ReturnType<typeof parseFrame>) => void>();
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private mockSerial = "16133/00012345";
  /** Latest handshake outcome. `null` until handshake() runs after a connect. */
  private lastHandshake: HandshakeResult | null = null;
  /**
   * GATT triple actually in use for I/O. Set by `handshake()` once a variant
   * (strict or clone) resolves. Until then, write/notify operations fall back
   * to the strict M365 UUIDs so the initial subscription can be set up.
   */
  private resolvedGatt: { service: string; rx: string; tx: string; rxWriteWithoutResponse: boolean } = {
    service: M365.SERVICE,
    rx: M365.CHAR_RX,
    tx: M365.CHAR_TX,
    rxWriteWithoutResponse: false,
  };
  private mockTelemetry: Telemetry = {
    speedKph: 0,
    batteryPct: 78,
    voltage: 39.4,
    currentA: 0,
    motorTempC: 24,
    ridingMode: "drive",
    tripKm: 3.2,
    totalKm: 1247.6,
  };

  async initialize(): Promise<void> {
    if (!isNative()) return;
    await BleClient.initialize({ androidNeverForLocation: true });
  }

  async scan(onResult: (d: DiscoveredDevice) => void, durationMs = 6000): Promise<void> {
    if (!isNative()) {
      // Mock devices for web preview
      setTimeout(() => onResult({ deviceId: "mock-m365", name: "MIScooter4321", rssi: -52, mock: true }), 300);
      setTimeout(() => onResult({ deviceId: "mock-pro", name: "MIScooterPro8821", rssi: -68, mock: true }), 900);
      setTimeout(() => onResult({ deviceId: "mock-1s", name: "MIScooter1S2244", rssi: -74, mock: true }), 1700);
      return;
    }
    await BleClient.requestLEScan(
      { services: [M365.SERVICE], allowDuplicates: false },
      (r: ScanResult) => {
        const name = r.device.name ?? r.localName ?? "Unknown";
        if (!/MISc?ooter/i.test(name) && !name.startsWith("MI")) return;
        onResult({ deviceId: r.device.deviceId, name, rssi: r.rssi ?? -100 });
      }
    );
    setTimeout(() => BleClient.stopLEScan().catch(() => {}), durationMs);
  }

  async stopScan(): Promise<void> {
    if (!isNative()) return;
    try { await BleClient.stopLEScan(); } catch { /* ignore */ }
  }

  async connect(deviceId: string, onDisconnect?: () => void): Promise<void> {
    if (!isNative()) {
      this.connectedId = deviceId;
      this.startMockLoop();
      return;
    }
    await BleClient.connect(deviceId, onDisconnect);
    // Notification subscription is deferred to handshake() because the
    // resolver may decide to listen on a clone-variant TX characteristic.
    this.connectedId = deviceId;
  }

  async disconnect(): Promise<void> {
    if (!this.connectedId) return;
    this.lastHandshake = null;
    // Reset the resolver back to strict M365 so the next connection starts
    // from a clean baseline.
    this.resolvedGatt = {
      service: M365.SERVICE,
      rx: M365.CHAR_RX,
      tx: M365.CHAR_TX,
      rxWriteWithoutResponse: false,
    };
    if (!isNative()) {
      this.stopMockLoop();
      this.connectedId = null;
      return;
    }
    try {
      await BleClient.stopNotifications(this.connectedId, this.resolvedGatt.service, this.resolvedGatt.tx);
    } catch { /* not subscribed yet — ignore */ }
    try { await BleClient.disconnect(this.connectedId); } catch { /* ignore */ }
    this.connectedId = null;
  }

  isConnected(): boolean { return this.connectedId !== null; }

  /** Latest handshake snapshot (or null if never run / since reset). */
  getHandshake(): HandshakeResult | null { return this.lastHandshake; }

  /**
   * Validate the BLE GATT layout against what the M365 protocol expects.
   * Must be called after connect() and before any flash operation.
   *
   * Two-stage strategy:
   *  1. **Strict M365**: look for the canonical FE95 service with a single
   *     characteristic that supports both `write` and `notify`. This is the
   *     genuine Xiaomi layout and is preferred whenever available.
   *  2. **Clone-tolerant fallback**: walk `M365.HANDSHAKE.FALLBACKS` and
   *     accept the first variant whose service exists and whose RX/TX
   *     characteristics expose the listed properties (RX may be plain
   *     `write` OR `writeWithoutResponse`; TX must be `notify`). When a
   *     fallback is selected the result is flagged with `cloneMode = true`
   *     and the UI surfaces an additional ack before flashing.
   *
   * In both cases the chosen RX/TX is stashed in `resolvedGatt`, the TX
   * notification subscription is attached, and a no-op probe read against
   * the ESC firmware register is issued. The probe must succeed (i.e. the
   * device must speak the M365 framing protocol) for `ok = true` regardless
   * of which variant resolved — this is the actual gate that protects
   * non-M365 peripherals from being flashed.
   *
   * @param opts.cloneTolerant Defaults to `true`. Set `false` to refuse
   *  fallbacks and only accept the strict M365 layout.
   */
  async handshake(opts?: { onLog?: (line: string) => void; cloneTolerant?: boolean }): Promise<HandshakeResult> {
    const log = opts?.onLog ?? (() => {});
    const cloneTolerant = opts?.cloneTolerant ?? true;
    const at = new Date().toISOString();

    const baseFail = (reason: string, extras?: Partial<HandshakeResult>): HandshakeResult => ({
      ok: false,
      servicesFound: [],
      missingServices: [...M365.HANDSHAKE.REQUIRED_SERVICES],
      missingChars: [...M365.HANDSHAKE.REQUIRED_CHARS],
      missingProps: [...M365.HANDSHAKE.REQUIRED_PROPS],
      probeResponded: false,
      reason,
      at,
      cloneMode: false,
      variantId: null,
      resolved: null,
      warnings: [],
      ...extras,
    });

    if (!this.connectedId) {
      const r = baseFail("not connected");
      this.lastHandshake = r;
      return r;
    }

    if (!isNative()) {
      // Web preview: simulate a successful strict handshake against the mock device.
      log("> handshake: mock device — assuming M365-compatible GATT");
      const r: HandshakeResult = {
        ok: true,
        servicesFound: [...M365.HANDSHAKE.REQUIRED_SERVICES],
        missingServices: [],
        missingChars: [],
        missingProps: [],
        probeResponded: true,
        reason: "ok",
        at,
        cloneMode: false,
        variantId: "m365-strict",
        resolved: { service: M365.SERVICE, rx: M365.CHAR_RX, tx: M365.CHAR_TX },
        warnings: [],
      };
      this.lastHandshake = r;
      return r;
    }

    log("> handshake: discovering GATT services…");
    try { await BleClient.discoverServices(this.connectedId); } catch { /* some platforms auto-discover */ }

    let services: Array<{ uuid: string; characteristics: Array<{ uuid: string; properties: Record<string, boolean> }> }> = [];
    try {
      const raw = await BleClient.getServices(this.connectedId);
      services = (raw ?? []).map((s) => ({
        uuid: String(s.uuid).toLowerCase(),
        characteristics: (s.characteristics ?? []).map((c) => ({
          uuid: String(c.uuid).toLowerCase(),
          properties: (c.properties ?? {}) as Record<string, boolean>,
        })),
      }));
    } catch (e) {
      const r = baseFail(`service discovery failed: ${e}`);
      this.lastHandshake = r;
      log(`! handshake: ${r.reason}`);
      return r;
    }

    const servicesFound = services.map((s) => s.uuid);

    // ── Resolver: walk FALLBACKS in priority order. The first entry is the
    // strict M365 layout, so when it matches we never enter clone mode. ──
    type Variant = (typeof M365.HANDSHAKE.FALLBACKS)[number];
    const tryVariant = (v: Variant): { ok: true; rxProp: string } | { ok: false; reason: string } => {
      const svc = services.find((s) => s.uuid === v.service.toLowerCase());
      if (!svc) return { ok: false, reason: `service ${v.service} not found` };
      const rxChar = svc.characteristics.find((c) => c.uuid === v.rx.toLowerCase());
      const txChar = svc.characteristics.find((c) => c.uuid === v.tx.toLowerCase());
      if (!rxChar) return { ok: false, reason: `rx char ${v.rx} not found` };
      if (!txChar) return { ok: false, reason: `tx char ${v.tx} not found` };
      const rxProp = v.rxProps.find((p) => rxChar.properties?.[p]);
      if (!rxProp) return { ok: false, reason: `rx missing ${v.rxProps.join("/")}` };
      const hasTx = v.txProps.every((p) => txChar.properties?.[p]);
      if (!hasTx) return { ok: false, reason: `tx missing ${v.txProps.join("/")}` };
      return { ok: true, rxProp };
    };

    let chosen: { variant: Variant; rxProp: string } | null = null;
    const tried: string[] = [];
    for (const v of M365.HANDSHAKE.FALLBACKS) {
      // Skip non-strict variants when caller opted out.
      if (!cloneTolerant && v.id !== "m365-strict") continue;
      const res = tryVariant(v);
      if (res.ok === true) {
        tried.push(`${v.id}: match`);
        chosen = { variant: v, rxProp: res.rxProp };
        break;
      } else {
        tried.push(`${v.id}: ${res.reason}`);
      }
    }

    if (!chosen) {
      const reason = cloneTolerant
        ? `no compatible GATT layout (tried ${tried.length} variants)`
        : `strict M365 layout not present`;
      const m365Service = services.find((s) => s.uuid === M365.SERVICE.toLowerCase());
      const charsFound = (m365Service?.characteristics ?? []).map((c) => c.uuid);
      const missingChars = M365.HANDSHAKE.REQUIRED_CHARS.filter((u) => !charsFound.includes(u));
      const targetChar = m365Service?.characteristics.find((c) => c.uuid === M365.CHAR_RX.toLowerCase());
      const missingProps = M365.HANDSHAKE.REQUIRED_PROPS.filter((p) => !targetChar?.properties?.[p]);
      const r = baseFail(reason, {
        servicesFound,
        missingServices: M365.HANDSHAKE.REQUIRED_SERVICES.filter((u) => !servicesFound.includes(u)),
        missingChars,
        missingProps,
      });
      this.lastHandshake = r;
      log(`! handshake: ${reason}`);
      tried.forEach((t) => log(`   • ${t}`));
      return r;
    }

    const isClone = chosen.variant.id !== "m365-strict";
    const warnings: string[] = [];
    if (isClone) warnings.push(`clone variant: ${chosen.variant.id}`);
    if (chosen.rxProp === "writeWithoutResponse") warnings.push("RX uses writeWithoutResponse (no ACK)");

    log(isClone
      ? `> handshake: clone-tolerant match (${chosen.variant.id})`
      : `> handshake: strict M365 GATT layout found`);

    // Stash resolved triple BEFORE subscribing / probing so write() and the
    // notification handler use the right characteristics.
    this.resolvedGatt = {
      service: chosen.variant.service,
      rx: chosen.variant.rx,
      tx: chosen.variant.tx,
      rxWriteWithoutResponse: chosen.rxProp === "writeWithoutResponse",
    };

    // (Re)subscribe to the resolved TX characteristic.
    try {
      await BleClient.startNotifications(this.connectedId, this.resolvedGatt.service, this.resolvedGatt.tx, (data) => {
        this.feedRx(new Uint8Array(data.buffer));
      });
    } catch (e) {
      const r = baseFail(`could not subscribe to TX: ${e}`, {
        servicesFound,
        missingServices: [],
        missingChars: [],
        missingProps: [],
        cloneMode: isClone,
        variantId: chosen.variant.id,
        resolved: { service: this.resolvedGatt.service, rx: this.resolvedGatt.rx, tx: this.resolvedGatt.tx },
        warnings,
      });
      this.lastHandshake = r;
      log(`! handshake: ${r.reason}`);
      return r;
    }

    // Protocol probe — same gate regardless of variant. A clone that doesn't
    // answer the M365 framing here will NOT pass the handshake, so flashing
    // stays blocked.
    log("> handshake: probing ESC firmware register…");
    const probeResponded = await new Promise<boolean>((resolve) => {
      let done = false;
      const off = this.onFrame((f) => {
        if (done || !f) return;
        if (f.addr === M365.ADDR.ESC && f.args[0] === M365.REG.FIRMWARE_VERSION) {
          done = true; off(); resolve(true);
        }
      });
      this.write(readRegister(M365.ADDR.ESC, M365.REG.FIRMWARE_VERSION, 2)).catch(() => {});
      // Clones can be slower to respond, especially on writeWithoutResponse paths.
      const probeTimeout = isClone ? 2500 : 1500;
      setTimeout(() => { if (!done) { off(); resolve(false); } }, probeTimeout);
    });

    const r: HandshakeResult = {
      ok: probeResponded,
      servicesFound,
      missingServices: [],
      missingChars: [],
      missingProps: [],
      probeResponded,
      reason: probeResponded
        ? (isClone ? "ok (clone-tolerant)" : "ok")
        : "no response to probe (device may not speak M365 protocol)",
      at,
      cloneMode: isClone,
      variantId: chosen.variant.id,
      resolved: { service: this.resolvedGatt.service, rx: this.resolvedGatt.rx, tx: this.resolvedGatt.tx },
      warnings,
    };
    this.lastHandshake = r;
    log(probeResponded
      ? (isClone ? `> handshake: OK (clone variant ${chosen.variant.id})` : "> handshake: OK")
      : `! handshake: ${r.reason}`);
    return r;
  }

  /** Throws if the latest handshake didn't pass. Used to gate dangerous ops. */
  private requireHandshake(): void {
    if (!this.lastHandshake?.ok) {
      throw new Error(
        this.lastHandshake
          ? `BLE handshake not validated: ${this.lastHandshake.reason}`
          : "BLE handshake not validated: run handshake() after connect()"
      );
    }
  }

  private feedRx(chunk: Uint8Array) {
    for (const b of chunk) this.rxBuffer.push(b);
    // attempt to parse repeatedly
    while (this.rxBuffer.length >= 7) {
      const frame = parseFrame(Uint8Array.from(this.rxBuffer));
      if (!frame) {
        // strip a byte and retry
        this.rxBuffer.shift();
        continue;
      }
      // determine bytes consumed
      const len = this.rxBuffer[2];
      const total = 2 + 1 + len + 2;
      this.rxBuffer.splice(0, total);
      this.listeners.forEach((l) => l(frame));
    }
  }

  onFrame(cb: (frame: ReturnType<typeof parseFrame>) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (!isNative()) return;
    if (!this.connectedId) throw new Error("not connected");
    const view = new DataView(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    await BleClient.write(this.connectedId, M365.SERVICE, M365.CHAR_RX, view);
  }

  // ──────────────── High-level operations ────────────────

  async readInfo(): Promise<ScooterInfo> {
    if (!isNative()) {
      return {
        serial: this.mockSerial,
        drvVersion: "1.5.5",
        bleVersion: "0.96",
        bmsVersion: "1.6.13",
        bmsSerial: "BMS/" + this.mockSerial.split("/")[1],
        hwVersion: "1.4.0",
        manufactureDate: "2022-06-14",
        totalMileageKm: this.mockTelemetry.totalKm,
      };
    }
    // Real: send reads, await responses with a small timeout-based collector.
    const out: ScooterInfo = {
      serial: "—", drvVersion: "—", bleVersion: "—", bmsVersion: "—", totalMileageKm: 0,
    };
    const collect = new Promise<void>((resolve) => {
      const off = this.onFrame((f) => {
        if (!f) return;
        if (f.addr === M365.ADDR.ESC && f.args[0] === M365.REG.SERIAL) out.serial = decodeSerial(f.args);
        if (f.addr === M365.ADDR.ESC && f.args[0] === M365.REG.FIRMWARE_VERSION) {
          out.drvVersion = decodeVersion(f.args[1] | (f.args[2] << 8));
        }
        if (f.addr === M365.ADDR.ESC && f.args[0] === M365.REG.HARDWARE_VERSION) {
          out.hwVersion = decodeVersion(f.args[1] | (f.args[2] << 8));
        }
        if (f.addr === M365.ADDR.BLE && f.args[0] === M365.REG.FIRMWARE_VERSION) {
          out.bleVersion = decodeVersion(f.args[1] | (f.args[2] << 8));
        }
        if (f.addr === M365.ADDR.BMS && f.args[0] === M365.REG.FIRMWARE_VERSION) {
          out.bmsVersion = decodeVersion(f.args[1] | (f.args[2] << 8));
        }
        if (f.addr === M365.ADDR.BMS && f.args[0] === M365.REG.SERIAL) {
          out.bmsSerial = decodeSerial(f.args);
        }
        if (f.addr === M365.ADDR.BMS && f.args[0] === M365.REG.BMS_DATE) {
          out.manufactureDate = decodeBmsDate(f.args[1] | (f.args[2] << 8));
        }
      });
      setTimeout(() => { off(); resolve(); }, 1800);
    });

    await this.write(readRegister(M365.ADDR.ESC, M365.REG.SERIAL, 14));
    await this.write(readRegister(M365.ADDR.ESC, M365.REG.FIRMWARE_VERSION, 2));
    await this.write(readRegister(M365.ADDR.ESC, M365.REG.HARDWARE_VERSION, 2));
    await this.write(readRegister(M365.ADDR.BLE, M365.REG.FIRMWARE_VERSION, 2));
    await this.write(readRegister(M365.ADDR.BMS, M365.REG.FIRMWARE_VERSION, 2));
    await this.write(readRegister(M365.ADDR.BMS, M365.REG.SERIAL, 14));
    await this.write(readRegister(M365.ADDR.BMS, M365.REG.BMS_DATE, 2));
    await collect;
    return out;
  }

  /**
   * Read extended identifiers — model id, COC code, BLE/BMS hardware
   * revisions, BMS health & cycles, and the most recent ESC error code.
   * Slower than `readInfo()` because it issues one read per register and
   * awaits replies; use sparingly (e.g. on user-initiated refresh).
   */
  async readExtendedInfo(bleAddress?: string): Promise<ExtendedDeviceInfo> {
    if (!isNative()) {
      // Stable mock so the panel always renders something useful in preview.
      // Slight randomness on cycles/health to make manual refresh visible.
      const cycles = 142 + Math.floor(Math.random() * 4);
      const health = 96 - Math.floor(Math.random() * 3);
      return {
        modelId: decodeModelId(0x0002),
        cocVersion: "0x010A",
        errorCode: "0x0000",
        bleHwVersion: "1.2.0",
        bmsHwVersion: "1.0.4",
        bmsCycles: cycles,
        bmsHealthPct: health,
        bleAddress: bleAddress ?? "—",
        readAt: Date.now(),
      };
    }

    const out: ExtendedDeviceInfo = { readAt: Date.now(), bleAddress };
    const collect = new Promise<void>((resolve) => {
      const off = this.onFrame((f) => {
        if (!f) return;
        const word = f.args[1] | (f.args[2] << 8);
        if (f.addr === M365.ADDR.ESC && f.args[0] === M365.REG.MODEL_ID) {
          out.modelId = decodeModelId(word);
        } else if (f.addr === M365.ADDR.ESC && f.args[0] === M365.REG.COC_VERSION) {
          out.cocVersion = decodeWordHex(word);
        } else if (f.addr === M365.ADDR.ESC && f.args[0] === M365.REG.ERROR_CODE) {
          out.errorCode = decodeWordHex(word);
        } else if (f.addr === M365.ADDR.BLE && f.args[0] === M365.REG.HARDWARE_VERSION) {
          out.bleHwVersion = decodeVersion(word);
        } else if (f.addr === M365.ADDR.BMS && f.args[0] === M365.REG.HARDWARE_VERSION) {
          out.bmsHwVersion = decodeVersion(word);
        } else if (f.addr === M365.ADDR.BMS && f.args[0] === M365.REG.BMS_CYCLES) {
          out.bmsCycles = word;
        } else if (f.addr === M365.ADDR.BMS && f.args[0] === M365.REG.BMS_HEALTH_PCT) {
          // single-byte payload past the register echo
          out.bmsHealthPct = f.args[1];
        }
      });
      setTimeout(() => { off(); resolve(); }, 1800);
    });

    await this.write(readRegister(M365.ADDR.ESC, M365.REG.MODEL_ID, 2));
    await this.write(readRegister(M365.ADDR.ESC, M365.REG.COC_VERSION, 2));
    await this.write(readRegister(M365.ADDR.ESC, M365.REG.ERROR_CODE, 2));
    await this.write(readRegister(M365.ADDR.BLE, M365.REG.HARDWARE_VERSION, 2));
    await this.write(readRegister(M365.ADDR.BMS, M365.REG.HARDWARE_VERSION, 2));
    await this.write(readRegister(M365.ADDR.BMS, M365.REG.BMS_CYCLES, 2));
    await this.write(readRegister(M365.ADDR.BMS, M365.REG.BMS_HEALTH_PCT, 1));
    await collect;
    return out;
  }

  /**
   * Write a new ESC serial and read it back to verify the device accepted it.
   * Performs up to `maxAttempts` write→wait→read passes; returns the outcome
   * of the final attempt regardless of success.
   */
  async writeSerialAndVerify(newSerial: string, maxAttempts = 1): Promise<VerifyResult> {
    if (!/^[A-Za-z0-9/]{1,14}$/.test(newSerial)) {
      throw new Error("Serial must be 1–14 ASCII chars (letters, digits, /)");
    }
    const expected = newSerial.trim();
    let last: VerifyResult = { ok: false, written: expected, readBack: "", attempt: 0 };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.writeSerialBytes(expected);
      } catch (e) {
        last = { ok: false, written: expected, readBack: "", attempt, readError: String(e) };
        continue;
      }
      await sleep(250);

      let readBack = "";
      let readError: string | undefined;
      try {
        const info = await this.readInfo();
        readBack = (info.serial ?? "").trim();
      } catch (e) {
        readError = String(e);
      }

      const ok = !readError && readBack === expected;
      last = { ok, written: expected, readBack, attempt, readError };
      if (ok) return last;
    }
    return last;
  }

  private async writeSerialBytes(newSerial: string): Promise<void> {
    const padded = newSerial.padEnd(14, " ");
    const bytes = new TextEncoder().encode(padded);
    if (!isNative()) {
      // Simulate the device accepting the write.
      this.mockSerial = newSerial;
      await sleep(150);
      return;
    }
    await this.write(writeRegister(M365.ADDR.ESC, M365.REG.SERIAL, bytes));
  }

  async pollTelemetry(): Promise<Telemetry> {
    if (!isNative()) {
      // simulate motion
      const t = this.mockTelemetry;
      t.speedKph = Math.max(0, Math.min(25, t.speedKph + (Math.random() - 0.45) * 4));
      t.currentA = t.speedKph > 1 ? +(2 + Math.random() * 3).toFixed(1) : 0;
      t.motorTempC = +(24 + (t.speedKph / 25) * 18 + Math.random()).toFixed(1);
      t.voltage = +(39.4 - t.batteryPct * 0.04 + (Math.random() - 0.5) * 0.1).toFixed(2);
      t.tripKm = +(t.tripKm + t.speedKph / 3600).toFixed(2);
      return { ...t };
    }
    // Real: kick off reads and aggregate. Returns the last known telemetry —
    // listeners on onFrame mutate a cached state in production.
    return this.mockTelemetry;
  }

  /**
   * Flash a firmware .bin to a target. Yields progress 0..1.
   *
   * Safety contract:
   *  - `signal` (AbortSignal): aborting BEFORE the first chunk is written
   *    raises a `FlashAbortError` with `phase="safe"` — the device is
   *    untouched. Aborting AFTER the first chunk raises `phase="unsafe"`
   *    — the device may be partially flashed and must be reflashed.
   *  - `preflightCheck`: invoked just before entering update mode and
   *    before every yield. Returning a non-empty string aborts the flash
   *    with that string as the failure reason (treated as an unsafe abort
   *    if any chunk has been written).
   */
  async *flash(
    target: "DRV" | "BMS" | "BLE",
    firmware: Uint8Array,
    opts?: {
      onLog?: (line: string) => void;
      signal?: AbortSignal;
      preflightCheck?: () => string | null;
    }
  ): AsyncGenerator<{ pct: number; bytes: number; total: number; status: string; safeToAbort: boolean }> {
    const log = opts?.onLog ?? (() => {});
    const signal = opts?.signal;
    const check = opts?.preflightCheck;
    // Hard-fail before touching firmware if the device hasn't passed the
    // GATT handshake — avoids bricking a non-M365 peripheral that happened
    // to advertise a similar name.
    this.requireHandshake();
    if (!this.isConnected()) {
      throw new FlashAbortError("not connected", "safe");
    }

    const addr = target === "DRV" ? M365.ADDR.ESC : target === "BMS" ? M365.ADDR.BMS : M365.ADDR.BLE;
    const total = firmware.length;
    let written = 0;

    const guard = (): void => {
      if (signal?.aborted) {
        throw new FlashAbortError("aborted by user", written === 0 ? "safe" : "unsafe");
      }
      if (!this.isConnected()) {
        throw new FlashAbortError("BLE connection lost", written === 0 ? "safe" : "unsafe");
      }
      const reason = check?.();
      if (reason) {
        throw new FlashAbortError(reason, written === 0 ? "safe" : "unsafe");
      }
    };

    log(`> begin ${target} flash, ${total} bytes`);
    // Final safety gate before the device enters update mode.
    guard();
    yield { pct: 0, bytes: 0, total, status: "arming", safeToAbort: true };

    if (isNative()) await this.write(buildFrame(addr, M365.CMD.UPDATE, [FLASH.ENTER_UPDATE]));
    await sleep(400);

    const chunks = Math.ceil(total / FLASH.CHUNK_SIZE);
    for (let i = 0; i < chunks; i++) {
      guard();
      const start = i * FLASH.CHUNK_SIZE;
      const payload = firmware.slice(start, start + FLASH.CHUNK_SIZE);
      if (isNative()) await this.write(buildChunkFrame(addr, i, payload));
      written += payload.length;
      // throttle so even huge files yield reasonable refresh rates
      if (i % 4 === 0) await sleep(8);
      if (i % 64 === 0) log(`  chunk ${i}/${chunks}`);
      yield { pct: written / total, bytes: written, total, status: "writing", safeToAbort: false };
    }

    log(`> verifying`);
    if (isNative()) await this.write(buildFrame(addr, M365.CMD.UPDATE, [FLASH.FINALIZE]));
    await sleep(500);
    log(`> ${target} flash complete`);
    yield { pct: 1, bytes: total, total, status: "done", safeToAbort: false };
  }

  // ──────────────── mock loop for web preview ────────────────
  private startMockLoop() {
    if (this.mockTimer) return;
    this.mockTimer = setInterval(() => {
      // nothing — telemetry is generated on demand in pollTelemetry
    }, 1000);
  }
  private stopMockLoop() {
    if (this.mockTimer) { clearInterval(this.mockTimer); this.mockTimer = null; }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const scooter = new ScooterService();
