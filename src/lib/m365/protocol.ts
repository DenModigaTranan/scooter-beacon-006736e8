/**
 * Xiaomi M365 family BLE protocol.
 *
 * Frame format (little-endian):
 *   0x55 0xAA  | LEN | ADDR | CMD | ARGS...        | CHKSUM (2 bytes, LE)
 *   header     | u8  | u8   | u8  | LEN-2 bytes    | u16 = ~sum(LEN..end of args)
 *
 * Common addresses:
 *   0x20 = ESC/DRV (motor controller)
 *   0x21 = BLE module
 *   0x22 = BMS (battery)
 *   0x23 = App
 *
 * Common commands:
 *   0x01 = Read
 *   0x03 = Write
 *   0x09 = Update (firmware chunk)
 *
 * This module is pure — no BLE I/O. The caller writes the resulting
 * Uint8Array to the FE95 RX characteristic.
 */

export const M365 = {
  HEADER: [0x55, 0xaa] as const,
  ADDR: { ESC: 0x20, BLE: 0x21, BMS: 0x22, APP: 0x23 },
  CMD: { READ: 0x01, WRITE: 0x03, UPDATE: 0x09 },

  /** Primary service & characteristics (community-documented). */
  SERVICE: "0000fe95-0000-1000-8000-00805f9b34fb",
  CHAR_RX: "0000fe95-0000-1000-8000-00805f9b34fb", // write
  CHAR_TX: "0000fe95-0000-1000-8000-00805f9b34fb", // notify

  /** Known register offsets for read commands (subset, ESC unless noted). */
  REG: {
    SERIAL: 0x10,           // 14 bytes ASCII
    HARDWARE_VERSION: 0x19, // u16 -> v X.Y.Z (ESC)
    FIRMWARE_VERSION: 0x1a, // u16 -> v X.Y.Z
    BATTERY_PCT: 0x22,
    REMAINING_CAPACITY: 0x32,
    BATTERY_VOLTAGE: 0x34,
    BATTERY_CURRENT: 0x33,
    SPEED: 0xb5,
    MOTOR_TEMP: 0xb0,
    MILEAGE_TOTAL: 0x29,
    MILEAGE_TRIP: 0x2b,
    RIDING_MODE: 0x75,
    BMS_DATE: 0xb2,         // u16 packed Y/M/D (BMS)
  },
} as const;

export type M365Address = (typeof M365.ADDR)[keyof typeof M365.ADDR];
export type M365Command = (typeof M365.CMD)[keyof typeof M365.CMD];

export interface M365Frame {
  addr: M365Address;
  cmd: M365Command;
  args: Uint8Array;
}

/** Build a frame ready to write to the BLE RX characteristic. */
export function buildFrame(addr: number, cmd: number, args: Uint8Array | number[] = []): Uint8Array {
  const argBytes = args instanceof Uint8Array ? args : Uint8Array.from(args);
  const len = argBytes.length + 2; // ADDR + CMD
  const body = new Uint8Array(1 + 1 + 1 + argBytes.length); // LEN ADDR CMD ARGS
  body[0] = len;
  body[1] = addr;
  body[2] = cmd;
  body.set(argBytes, 3);

  const cks = checksum(body);
  const out = new Uint8Array(2 + body.length + 2);
  out[0] = M365.HEADER[0];
  out[1] = M365.HEADER[1];
  out.set(body, 2);
  out[out.length - 2] = cks & 0xff;
  out[out.length - 1] = (cks >> 8) & 0xff;
  return out;
}

/** ~sum of LEN..end-of-args, kept as 16 bits. */
export function checksum(body: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < body.length; i++) s += body[i];
  return (~s) & 0xffff;
}

/** Parse one frame from a buffer. Returns null if buffer is incomplete or invalid. */
export function parseFrame(buf: Uint8Array): M365Frame | null {
  if (buf.length < 7) return null;
  if (buf[0] !== M365.HEADER[0] || buf[1] !== M365.HEADER[1]) return null;
  const len = buf[2];
  const total = 2 + 1 + len + 2; // header + LEN + body + checksum
  if (buf.length < total) return null;

  const body = buf.slice(2, 2 + 1 + len);
  const expected = checksum(body);
  const got = buf[total - 2] | (buf[total - 1] << 8);
  if (expected !== got) return null;

  return {
    addr: buf[3] as M365Address,
    cmd: buf[4] as M365Command,
    args: buf.slice(5, 2 + 1 + len),
  };
}

/** Convenience: read N bytes from a register on a target. */
export function readRegister(addr: number, register: number, length: number): Uint8Array {
  return buildFrame(addr, M365.CMD.READ, [register, length]);
}

/** Convenience: write payload to a register on a target. */
export function writeRegister(addr: number, register: number, payload: Uint8Array | number[]): Uint8Array {
  const p = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const args = new Uint8Array(1 + p.length);
  args[0] = register;
  args.set(p, 1);
  return buildFrame(addr, M365.CMD.WRITE, args);
}

/** Decode a 14-byte ASCII serial number response. */
export function decodeSerial(args: Uint8Array): string {
  // first byte echoes the register
  const sliced = args[0] === M365.REG.SERIAL ? args.slice(1) : args;
  return new TextDecoder("ascii").decode(sliced).replace(/[^\x20-\x7e]/g, "").trim();
}

/** Decode the X.Y.Z version word. */
export function decodeVersion(word: number): string {
  const a = (word >> 8) & 0x0f;
  const b = (word >> 4) & 0x0f;
  const c = word & 0x0f;
  return `${a}.${b}.${c}`;
}

/**
 * Decode a packed BMS manufacture date word.
 * Community-documented packing (16 bits, little-endian on the wire):
 *   bits 15..9 = year offset from 2000  (7 bits)
 *   bits  8..5 = month                  (4 bits)
 *   bits  4..0 = day                    (5 bits)
 * Returns "YYYY-MM-DD" or "—" if implausible.
 */
export function decodeBmsDate(word: number): string {
  const year = 2000 + ((word >> 9) & 0x7f);
  const month = (word >> 5) & 0x0f;
  const day = word & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31) return "—";
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Build firmware update chunks. The community DRV flash sequence boils down to:
 *  1) write ENTER_UPDATE to target
 *  2) for each 16-byte chunk send CMD 0x09 with [seq_lo, seq_hi, ...payload]
 *  3) write FINALIZE / verify
 *
 *  The exact sub-commands differ per target (ESC/BMS/BLE) — the constants below
 *  are the documented community values; the actual flashing flow lives in the
 *  scooter service so this stays a pure encoder.
 */
export const FLASH = {
  CHUNK_SIZE: 16,
  ENTER_UPDATE: 0xfe,
  FINALIZE: 0xff,
} as const;

export function buildChunkFrame(addr: number, seq: number, payload: Uint8Array): Uint8Array {
  const args = new Uint8Array(2 + payload.length);
  args[0] = seq & 0xff;
  args[1] = (seq >> 8) & 0xff;
  args.set(payload, 2);
  return buildFrame(addr, M365.CMD.UPDATE, args);
}
