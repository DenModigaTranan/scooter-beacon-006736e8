/**
 * Segway-Ninebot BLE wire protocol — pure encoder/decoder.
 *
 * No I/O lives here. The session layer (`./session.ts`) consumes these
 * functions to drive the live transport; the mock peripheral
 * (`@/lib/generic-ble`) consumes them to emulate a real device. Keeping
 * everything pure means the same code paths run in unit tests, in the
 * Lovable web preview against the mock, and on a Capacitor build against
 * a real scooter.
 *
 * Frame format (P2 / Encryption2, source: community RE docs at
 * https://nootnooot.codeberg.page/segway-ninebot-ble):
 *
 *   0x5A 0xA5 | LEN | SRC | DST | CMD | ARG | PAYLOAD…       | CKSUM (2B LE)
 *   header    | u8  | u8  | u8  | u8  | u8  | LEN-1 bytes    | u16 = (~sum(LEN..end-of-payload)) & 0xFFFF
 *
 * `LEN` counts the payload length only (not SRC/DST/CMD/ARG).
 *
 * Common nodes:
 *   0x21 = APP (us)        0x20 = ESC/MCU      0x22 = BLE module
 *   0x23 = BMS              0x24 = External BMS
 *
 * Command codes used here:
 *   0x01 = READ_REG          (ARG = register, payload = length to read)
 *   0x03 = WRITE_REG         (ARG = register, payload = value bytes)
 *   0x04 = READ_REG_REPLY    (ARG = register, payload = value bytes)
 *   0x5B = AUTH_PRE_COMM     (handshake stage 1)
 *   0x5C = AUTH_SET_PWD      (handshake stage 2)
 *   0x5D = AUTH_OK           (handshake stage 3 — device acks pairing key)
 *
 * The "Encryption2" production wrapper would AES-128-CTR the payload after
 * the handshake completes; we model the handshake shape and frame layout
 * but leave the cipher as identity here. Swapping in real AES is a single
 * function pair (`encryptPayload`/`decryptPayload`) at the bottom of this
 * file — every call site already routes through them.
 */

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const NB = {
  HEADER: [0x5a, 0xa5] as const,
  NODE: {
    APP: 0x21,
    ESC: 0x20,
    BLE: 0x22,
    BMS: 0x23,
  },
  CMD: {
    READ_REG: 0x01,
    WRITE_REG: 0x03,
    READ_REG_REPLY: 0x04,
    AUTH_PRE_COMM: 0x5b,
    AUTH_SET_PWD: 0x5c,
    AUTH_OK: 0x5d,
  },
  /** Register addresses we decode in this app (subset). */
  REG: {
    /** u8 — battery state of charge, percent. */
    BATTERY_PCT: 0xb1,
    /** u16 LE, units 0.01 km/h. */
    SPEED: 0xb5,
    /** u8 — drive=0, eco=1, sport=2 (model-dependent enum). */
    MODE: 0x75,
    /** u32 LE, units 0.01 km. */
    ODOMETER: 0x29,
    /** u8 — 0=unlocked, 1=locked. */
    LOCK: 0x70,
  },
} as const;

/**
 * The Ninebot custom GATT service & characteristics. The 128-bit service
 * UUID's tail bytes literally spell "\0ninebot" in ASCII (see
 * `ninebot-detect.ts` for the suffix match). RX is the characteristic the
 * APP writes frames *to*; TX is the one the APP subscribes to for reply
 * frames. Some firmwares route both directions over a single char — the
 * session layer probes for both shapes.
 */
export const NB_GATT = {
  SERVICE: "6e400001-b5a3-f393-e0a9-006e696e65626f74",
  CHAR_RX: "6e400002-b5a3-f393-e0a9-006e696e65626f74",
  CHAR_TX: "6e400003-b5a3-f393-e0a9-006e696e65626f74",
} as const;

/** Ride mode enum — covers the values seen in the wild on kick-scooters. */
export type NinebotMode = "drive" | "eco" | "sport" | "unknown";

/** Decoded telemetry snapshot. Every field is optional so a partial poll
 *  cycle (e.g. just battery + speed arrived this tick) can still be merged
 *  on top of an existing snapshot without clobbering known values. */
export interface NinebotTelemetry {
  batteryPct?: number;
  speedKmh?: number;
  mode?: NinebotMode;
  odometerKm?: number;
  locked?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Frame codec                                                                */
/* -------------------------------------------------------------------------- */

export interface NinebotFrame {
  src: number;
  dst: number;
  cmd: number;
  arg: number;
  payload: Uint8Array;
}

/**
 * Build a wire-format frame. `payload` is sent as-is; the
 * encrypt/decrypt seam is applied by the session layer when running against
 * a real Encryption2 device, but for handshake frames it's intentionally
 * skipped so PRE_COMM / SET_PWD frames are intelligible to a stock device
 * before the AES key is established.
 */
export function buildFrame(f: NinebotFrame): Uint8Array {
  const payload = f.payload;
  // LEN counts payload only; SRC/DST/CMD/ARG ride alongside it.
  const len = payload.length;
  const body = new Uint8Array(1 + 4 + payload.length); // LEN + SRC/DST/CMD/ARG + payload
  body[0] = len;
  body[1] = f.src;
  body[2] = f.dst;
  body[3] = f.cmd;
  body[4] = f.arg;
  body.set(payload, 5);
  const cks = checksum(body);
  const out = new Uint8Array(2 + body.length + 2);
  out[0] = NB.HEADER[0];
  out[1] = NB.HEADER[1];
  out.set(body, 2);
  out[out.length - 2] = cks & 0xff;
  out[out.length - 1] = (cks >>> 8) & 0xff;
  return out;
}

/** Two-byte little-endian one's-complement-ish checksum used by the
 *  Ninebot protocol. Identical shape to the M365 one but computed over a
 *  different prefix (LEN..end-of-payload, *not* including the header). */
export function checksum(body: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < body.length; i++) s += body[i];
  return ~s & 0xffff;
}

/**
 * Try to parse one frame from the head of `buf`. Returns the decoded frame
 * plus the number of bytes consumed. Returns `null` if the buffer is too
 * short (caller should accumulate more bytes) or if the header / checksum
 * don't match (caller should drop one byte and re-try — see
 * `consumeFrames`).
 */
export function parseFrame(buf: Uint8Array): { frame: NinebotFrame; consumed: number } | null {
  if (buf.length < 2 + 1 + 4 + 2) return null;
  if (buf[0] !== NB.HEADER[0] || buf[1] !== NB.HEADER[1]) return null;
  const len = buf[2];
  const total = 2 /*hdr*/ + 1 /*LEN*/ + 4 /*SRC/DST/CMD/ARG*/ + len + 2 /*cks*/;
  if (buf.length < total) return null;
  const body = buf.slice(2, 2 + 1 + 4 + len);
  const expected = checksum(body);
  const got = buf[total - 2] | (buf[total - 1] << 8);
  if (expected !== got) return null;
  return {
    frame: {
      src: body[1],
      dst: body[2],
      cmd: body[3],
      arg: body[4],
      payload: body.slice(5),
    },
    consumed: total,
  };
}

/**
 * Streaming framer. Notification chunks from BLE may straddle frame
 * boundaries or merge several small frames into one packet; this drains
 * everything it can from `buf` and returns `{ frames, remaining }`. The
 * caller persists `remaining` and concatenates the next chunk onto its
 * front before the next call.
 */
export function consumeFrames(buf: Uint8Array): { frames: NinebotFrame[]; remaining: Uint8Array } {
  const frames: NinebotFrame[] = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const view = buf.subarray(cursor);
    const r = parseFrame(view);
    if (r) {
      frames.push(r.frame);
      cursor += r.consumed;
      continue;
    }
    // No frame at this position. If the header matches but we're short on
    // bytes, stop and ask the caller for more. Otherwise drop one byte and
    // re-sync — handles spurious noise on the notify pipe.
    if (view.length >= 2 && view[0] === NB.HEADER[0] && view[1] === NB.HEADER[1]) break;
    cursor += 1;
  }
  return { frames, remaining: buf.slice(cursor) };
}

/* -------------------------------------------------------------------------- */
/* Auth handshake — 3 phases                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stage 1: APP → BLE. We announce ourselves and ask the device to start a
 * pairing exchange. The 16-byte payload is the APP's random nonce; the
 * device replies with its own 16-byte nonce in the AUTH_PRE_COMM reply. In
 * production, both nonces feed an AES-128 key derivation; here we keep the
 * shape so the mock and the real device agree on framing.
 */
export function buildAuthPreComm(appNonce: Uint8Array): Uint8Array {
  if (appNonce.length !== 16) throw new Error("appNonce must be 16 bytes");
  return buildFrame({
    src: NB.NODE.APP,
    dst: NB.NODE.BLE,
    cmd: NB.CMD.AUTH_PRE_COMM,
    arg: 0x00,
    payload: appNonce,
  });
}

/**
 * Stage 2: APP → BLE. The APP commits the derived 16-byte session key.
 * Real devices store this against the paired phone identity so subsequent
 * sessions can skip the full handshake; the mock just acks it.
 */
export function buildAuthSetPwd(sessionKey: Uint8Array): Uint8Array {
  if (sessionKey.length !== 16) throw new Error("sessionKey must be 16 bytes");
  return buildFrame({
    src: NB.NODE.APP,
    dst: NB.NODE.BLE,
    cmd: NB.CMD.AUTH_SET_PWD,
    arg: 0x00,
    payload: sessionKey,
  });
}

/**
 * Read a register from a target node. `length` is the number of bytes the
 * device should return. We always send length as a single-byte payload —
 * registers larger than 255 bytes don't exist in the documented set.
 */
export function buildReadRegister(target: number, register: number, length: number): Uint8Array {
  return buildFrame({
    src: NB.NODE.APP,
    dst: target,
    cmd: NB.CMD.READ_REG,
    arg: register,
    payload: Uint8Array.from([length]),
  });
}

/**
 * Write a value to a register on the target node. Used for lock/unlock,
 * lights, beep, speed limit, etc. Caller is responsible for serialising
 * the value to the register's expected type.
 */
export function buildWriteRegister(
  target: number,
  register: number,
  value: Uint8Array | readonly number[],
): Uint8Array {
  const v = value instanceof Uint8Array ? value : Uint8Array.from(value);
  return buildFrame({
    src: NB.NODE.APP,
    dst: target,
    cmd: NB.CMD.WRITE_REG,
    arg: register,
    payload: v,
  });
}

/* -------------------------------------------------------------------------- */
/* Register decoders                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Map a raw register reply onto a partial `NinebotTelemetry`. Returns an
 * empty object for unknown registers so the caller can merge unconditionally
 * without filtering. `frame.cmd` MUST be READ_REG_REPLY — anything else is
 * silently ignored to keep the call site small; the session layer logs.
 */
export function decodeRegisterReply(frame: NinebotFrame): NinebotTelemetry {
  if (frame.cmd !== NB.CMD.READ_REG_REPLY) return {};
  const p = frame.payload;
  switch (frame.arg) {
    case NB.REG.BATTERY_PCT:
      // Single byte 0..100. Some clones return values up to 0x64 with the
      // high bit set as a "charging" flag — we mask it off.
      if (p.length < 1) return {};
      return { batteryPct: clamp(p[0] & 0x7f, 0, 100) };
    case NB.REG.SPEED:
      // u16 LE, units 0.01 km/h. Clamp to a sane upper bound — anything
      // over 120 is almost certainly noise / sign-flipped negative.
      if (p.length < 2) return {};
      {
        const raw = p[0] | (p[1] << 8);
        return { speedKmh: clamp(raw / 100, 0, 120) };
      }
    case NB.REG.MODE:
      if (p.length < 1) return {};
      return { mode: decodeMode(p[0]) };
    case NB.REG.ODOMETER:
      // u32 LE, units 0.01 km.
      if (p.length < 4) return {};
      {
        const raw =
          (p[0] | (p[1] << 8) | (p[2] << 16) | (p[3] << 24)) >>> 0;
        return { odometerKm: raw / 100 };
      }
    case NB.REG.LOCK:
      if (p.length < 1) return {};
      return { locked: p[0] !== 0 };
    default:
      return {};
  }
}

function decodeMode(byte: number): NinebotMode {
  switch (byte) {
    case 0x00: return "drive";
    case 0x01: return "eco";
    case 0x02: return "sport";
    default:   return "unknown";
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/* -------------------------------------------------------------------------- */
/* Display formatters                                                         */
/* -------------------------------------------------------------------------- */

/** Pretty-print one telemetry field, returning "—" when absent. */
export function formatTelemetryField(t: NinebotTelemetry, key: keyof NinebotTelemetry): string {
  switch (key) {
    case "batteryPct": return t.batteryPct == null ? "—" : `${Math.round(t.batteryPct)}`;
    case "speedKmh":   return t.speedKmh   == null ? "—" : t.speedKmh.toFixed(1);
    case "mode":       return t.mode       == null || t.mode === "unknown" ? "—" : t.mode;
    case "odometerKm": return t.odometerKm == null ? "—" : t.odometerKm.toFixed(2);
    case "locked":     return t.locked     == null ? "—" : t.locked ? "locked" : "unlocked";
  }
}

/* -------------------------------------------------------------------------- */
/* Crypto seam (identity in mock; AES-128-CTR in production)                  */
/* -------------------------------------------------------------------------- */

/**
 * Reserved seam for Encryption2's AES-128-CTR wrapper. Today the mock and
 * the bundled session run plaintext frames so the entire pipeline is
 * exerciseable without a paired hardware secret. When a real-device
 * transport lands, swap these to call WebCrypto with the key derived from
 * the AUTH_SET_PWD exchange. Keeping the seam here means the framer and
 * register decoders never need to learn about ciphers.
 */
export function encryptPayload(payload: Uint8Array, _key: Uint8Array | null): Uint8Array {
  return payload;
}
export function decryptPayload(payload: Uint8Array, _key: Uint8Array | null): Uint8Array {
  return payload;
}
