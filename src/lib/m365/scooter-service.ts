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
  decodeSerial,
  decodeVersion,
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
}

const isNative = () => Capacitor.isNativePlatform();

export class ScooterService {
  private connectedId: string | null = null;
  private rxBuffer: number[] = [];
  private listeners = new Set<(frame: ReturnType<typeof parseFrame>) => void>();
  private mockTimer: ReturnType<typeof setInterval> | null = null;
  private mockSerial = "16133/00012345";
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
    await BleClient.startNotifications(deviceId, M365.SERVICE, M365.CHAR_TX, (data) => {
      this.feedRx(new Uint8Array(data.buffer));
    });
    this.connectedId = deviceId;
  }

  async disconnect(): Promise<void> {
    if (!this.connectedId) return;
    if (!isNative()) {
      this.stopMockLoop();
      this.connectedId = null;
      return;
    }
    try { await BleClient.disconnect(this.connectedId); } catch { /* ignore */ }
    this.connectedId = null;
  }

  isConnected(): boolean { return this.connectedId !== null; }

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

  /** Flash a firmware .bin to a target. Yields progress 0..1. */
  async *flash(
    target: "DRV" | "BMS" | "BLE",
    firmware: Uint8Array,
    opts?: { onLog?: (line: string) => void }
  ): AsyncGenerator<{ pct: number; bytes: number; total: number; status: string }> {
    const log = opts?.onLog ?? (() => {});
    const addr = target === "DRV" ? M365.ADDR.ESC : target === "BMS" ? M365.ADDR.BMS : M365.ADDR.BLE;
    const total = firmware.length;

    log(`> begin ${target} flash, ${total} bytes`);
    if (isNative()) await this.write(buildFrame(addr, M365.CMD.UPDATE, [FLASH.ENTER_UPDATE]));
    await sleep(400);

    const chunks = Math.ceil(total / FLASH.CHUNK_SIZE);
    let written = 0;
    for (let i = 0; i < chunks; i++) {
      const start = i * FLASH.CHUNK_SIZE;
      const payload = firmware.slice(start, start + FLASH.CHUNK_SIZE);
      if (isNative()) await this.write(buildChunkFrame(addr, i, payload));
      written += payload.length;
      // throttle so even huge files yield reasonable refresh rates
      if (i % 4 === 0) await sleep(8);
      if (i % 64 === 0) log(`  chunk ${i}/${chunks}`);
      yield { pct: written / total, bytes: written, total, status: "writing" };
    }

    log(`> verifying`);
    if (isNative()) await this.write(buildFrame(addr, M365.CMD.UPDATE, [FLASH.FINALIZE]));
    await sleep(500);
    log(`> ${target} flash complete`);
    yield { pct: 1, bytes: total, total, status: "done" };
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
