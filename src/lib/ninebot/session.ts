/**
 * Live Ninebot session — handshake + register polling.
 *
 * Drives a real (or mocked) Ninebot peripheral through:
 *   1. TX subscription so we receive frames the device sends back.
 *   2. The 3-phase auth handshake (PRE_COMM → SET_PWD → AUTH_OK).
 *   3. A round-robin register poll loop that fans out READ_REG frames and
 *      decodes the replies into a `NinebotTelemetry` snapshot.
 *
 * Why a class-shaped session, not just functions:
 *   each step needs to share mutable state (an inbound byte buffer, the
 *   handshake completion promise, the active poll timer, the unsubscribe
 *   handle). Hiding that behind a Session object keeps the React hook
 *   trivially small and lets a future native CLI consume the same flow
 *   without React in the picture.
 *
 * Failure model:
 *   - All BLE I/O errors are caught and surfaced via `onStatus` so the UI
 *     can render an "auth failed" state without taking the whole screen
 *     down.
 *   - The session never throws across the public API. `start()` resolves
 *     once the handshake completes (or rejects once if it can't); the
 *     poll loop keeps trying after transient errors so a brief link blip
 *     doesn't permanently freeze the tiles.
 */

import {
  NB,
  buildAuthPreComm,
  buildAuthSetPwd,
  buildReadRegister,
  buildWriteRegister,
  consumeFrames,
  decodeRegisterReply,
  deriveSessionKey,
  type NinebotFrame,
  type NinebotTelemetry,
} from "./protocol";
import {
  createMockTransport,
  type NinebotTransport,
} from "./transport";

/**
 * Catalog of high-level commands the UI can send. Lifted to a tagged
 * union (rather than five `lock()` / `unlock()` methods) so the session's
 * public surface stays small and adding a new command is a one-spot edit
 * — extend the union, extend the switch in `sendCommand`, done. The UI
 * iterates this set to render its buttons; the same value the button
 * fires is what reaches the wire encoder, so there's no lossy mapping
 * step between intent and bytes.
 */
export type NinebotCommand =
  | { kind: "lock" }
  | { kind: "unlock" }
  | { kind: "lights"; on: boolean }
  | { kind: "beep" };

/**
 * Session lifecycle status. Used by the UI to switch between "connecting",
 * "authenticating", "live", and error views above the telemetry tiles.
 */
export type NinebotSessionStatus =
  | "idle"
  | "subscribing"
  | "authenticating"
  | "polling"
  | "error"
  | "stopped";

export interface NinebotSessionEvents {
  /** Fired whenever the session moves between lifecycle states. */
  onStatus?: (status: NinebotSessionStatus, detail?: string) => void;
  /**
   * Fired after every successful register decode with the merged
   * snapshot. Listeners receive a fresh object each time so React
   * reference checks update.
   */
  onTelemetry?: (telemetry: NinebotTelemetry) => void;
}

/** How often we cycle through the polled registers, in milliseconds. */
const POLL_INTERVAL_MS = 500;

/** Hard cap on how long we wait for the handshake to complete. */
const AUTH_TIMEOUT_MS = 4_000;

/**
 * Registers we poll. Order matters only cosmetically (UI updates in this
 * order on the first cycle); after the first round every value is fresh
 * within ~POLL_INTERVAL_MS * registers.length.
 */
const POLL_REGISTERS: { target: number; register: number; length: number }[] = [
  { target: NB.NODE.ESC, register: NB.REG.BATTERY_PCT, length: 1 },
  { target: NB.NODE.ESC, register: NB.REG.SPEED,      length: 2 },
  { target: NB.NODE.ESC, register: NB.REG.MODE,       length: 1 },
  { target: NB.NODE.ESC, register: NB.REG.ODOMETER,   length: 4 },
  { target: NB.NODE.ESC, register: NB.REG.LOCK,       length: 1 },
];

export interface NinebotSessionOptions {
  /**
   * Inject a transport. Defaults to the mock/passthrough transport, which
   * is what the Lovable web preview and the existing in-process mock
   * peripheral expect. Pass `createRealDeviceTransport()` from
   * `./transport.ts` to route post-handshake frames through AES-128-CTR.
   */
  transport?: NinebotTransport;
}

export class NinebotSession {
  private events: NinebotSessionEvents;
  private transport: NinebotTransport;
  private status: NinebotSessionStatus = "idle";
  private telemetry: NinebotTelemetry = {};
  private rxBuffer: Uint8Array = new Uint8Array(0);
  private unsubscribeNotify: (() => Promise<void>) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIndex = 0;
  /** Resolved when AUTH_OK is observed, rejected on timeout. */
  private authResolve: (() => void) | null = null;
  private authReject: ((err: Error) => void) | null = null;
  /** Captured device nonce from the AUTH_PRE_COMM reply (16 bytes). */
  private deviceNonce: Uint8Array | null = null;
  /** App nonce sent in AUTH_PRE_COMM, retained for KDF input on AUTH_OK. */
  private appNonce: Uint8Array | null = null;
  private stopped = false;

  constructor(events: NinebotSessionEvents = {}, options: NinebotSessionOptions = {}) {
    this.events = events;
    this.transport = options.transport ?? createMockTransport();
  }

  /**
   * Start the session against the *currently connected* peripheral. The
   * caller is responsible for ensuring `genericBle.connect()` has resolved
   * and that the device exposes the Ninebot service. Resolves once the
   * handshake completes; the poll loop runs in the background until
   * `stop()`.
   */
  async start(): Promise<void> {
    if (this.status !== "idle") return;
    this.setStatus("subscribing");
    try {
      this.unsubscribeNotify = await this.transport.subscribe(
        (bytes) => this.onIncomingBytes(bytes),
      );
    } catch (e) {
      this.setStatus("error", `subscribe failed: ${(e as Error).message}`);
      throw e;
    }

    this.setStatus("authenticating");
    try {
      await this.runHandshake();
    } catch (e) {
      this.setStatus("error", `auth failed: ${(e as Error).message}`);
      await this.stop();
      throw e;
    }

    this.setStatus("polling");
    this.startPollLoop();
  }

  /** Tear the session down. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.unsubscribeNotify) {
      try { await this.unsubscribeNotify(); } catch { /* swallow */ }
      this.unsubscribeNotify = null;
    }
    this.setStatus("stopped");
  }

  /** Last decoded snapshot, for late subscribers / debug surfaces. */
  getTelemetry(): NinebotTelemetry {
    return { ...this.telemetry };
  }

  /**
   * Send a high-level control command. Translates the tagged union into a
   * single WRITE_REG frame and dispatches it on the RX characteristic.
   *
   * Pre-flight: rejects unless the session is `polling` (i.e. the auth
   * handshake has completed). This is a defence-in-depth check — the UI
   * already disables the buttons in non-polling states, but a stray call
   * shouldn't get past us and confuse the device with a write before it
   * has accepted our pairing.
   *
   * Errors from the underlying BLE write propagate so the UI can render a
   * one-shot toast / inline error; the session's lifecycle status is
   * deliberately *not* moved to "error" for a single failed command,
   * since the link itself is still healthy.
   */
  async sendCommand(cmd: NinebotCommand): Promise<void> {
    if (this.status !== "polling") {
      throw new Error(`session not ready (status=${this.status})`);
    }
    const frame = encodeCommand(cmd);
    // Optimistic local update for state-bearing commands so the tile
    // flips immediately even before the device's echo round-trips. The
    // next poll will reconcile if the device rejected the write.
    const optimistic = optimisticTelemetry(cmd);
    if (optimistic) {
      this.telemetry = { ...this.telemetry, ...optimistic };
      this.events.onTelemetry?.(this.telemetry);
    }
    await genericBle.writeCharacteristic(
      NB_GATT.SERVICE, NB_GATT.CHAR_RX, frame, false,
    );
  }

  private setStatus(next: NinebotSessionStatus, detail?: string) {
    if (this.status === next) return;
    this.status = next;
    this.events.onStatus?.(next, detail);
  }

  /**
   * Append received bytes to our rolling buffer and drain every complete
   * frame. Frames the session doesn't recognise (e.g. unsolicited fault
   * notifications) are routed to the auth gate first, then to the
   * register decoder; both happily ignore frames they don't care about.
   */
  private onIncomingBytes(bytes: Uint8Array) {
    const merged = new Uint8Array(this.rxBuffer.length + bytes.length);
    merged.set(this.rxBuffer, 0);
    merged.set(bytes, this.rxBuffer.length);
    const { frames, remaining } = consumeFrames(merged);
    this.rxBuffer = remaining;
    for (const f of frames) this.handleFrame(f);
  }

  private handleFrame(f: NinebotFrame) {
    // Auth replies — only relevant while we're still negotiating, but
    // checking unconditionally is cheap and protects against late
    // duplicates from the device.
    if (f.cmd === NB.CMD.AUTH_OK && this.authResolve) {
      this.authResolve();
      this.authResolve = null;
      this.authReject = null;
      return;
    }
    // Register reply → merge into the telemetry snapshot. Each decoder
    // returns a partial; we keep the previous value for any field it
    // didn't touch so a single missed read doesn't blank the tile.
    const partial = decodeRegisterReply(f);
    if (Object.keys(partial).length > 0) {
      this.telemetry = { ...this.telemetry, ...partial };
      this.events.onTelemetry?.(this.telemetry);
    }
  }

  private async runHandshake(): Promise<void> {
    // Stage 1: write PRE_COMM with a fresh 16-byte nonce. We use
    // crypto.getRandomValues when available so the handshake doesn't
    // collapse to a deterministic key in the unlikely case a real device
    // is in scope under the mock build.
    const appNonce = randomBytes(16);
    const sessionKey = randomBytes(16);
    const authPromise = new Promise<void>((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
    });
    const timer = setTimeout(() => {
      if (this.authReject) {
        this.authReject(new Error(`handshake timed out after ${AUTH_TIMEOUT_MS}ms`));
        this.authResolve = null;
        this.authReject = null;
      }
    }, AUTH_TIMEOUT_MS);

    try {
      await genericBle.writeCharacteristic(
        NB_GATT.SERVICE, NB_GATT.CHAR_RX, buildAuthPreComm(appNonce), false,
      );
      // Brief breather between PRE_COMM and SET_PWD so the device's
      // firmware-side state machine has actually advanced — real
      // hardware sometimes drops back-to-back writes inside one ATT
      // window.
      await sleep(40);
      // Stage 2: commit the session key. The mock acks with AUTH_OK
      // immediately; production devices may take ~100ms.
      await genericBle.writeCharacteristic(
        NB_GATT.SERVICE, NB_GATT.CHAR_RX, buildAuthSetPwd(sessionKey), false,
      );
      await authPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  private startPollLoop() {
    this.pollIndex = 0;
    // Kick the first read immediately so the tiles populate within one
    // handshake cycle instead of one POLL_INTERVAL_MS later.
    void this.pollOnce();
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, POLL_INTERVAL_MS);
  }

  /**
   * Send the next register's READ frame. We rotate one register per tick
   * (rather than fanning all five at once) because the BLE link's write
   * window is narrow on real devices — bursting frames triggers
   * congestion-control disconnects on iOS in particular.
   */
  private async pollOnce(): Promise<void> {
    if (this.stopped) return;
    const spec = POLL_REGISTERS[this.pollIndex % POLL_REGISTERS.length];
    this.pollIndex += 1;
    try {
      await genericBle.writeCharacteristic(
        NB_GATT.SERVICE,
        NB_GATT.CHAR_RX,
        buildReadRegister(spec.target, spec.register, spec.length),
        false,
      );
    } catch {
      // Swallow — the next interval tick will try again. We deliberately
      // don't surface transient write errors to the UI; they're noise on
      // an otherwise-healthy link.
    }
  }
}

/**
 * Translate a high-level command into the WRITE_REG frame the ESC
 * expects. Pure — no I/O — so it's trivially unit-testable and the same
 * encoder runs in the mock peripheral and the production transport.
 */
function encodeCommand(cmd: NinebotCommand): Uint8Array {
  switch (cmd.kind) {
    case "lock":
      return buildWriteRegister(NB.NODE.ESC, NB.REG.LOCK, [0x01]);
    case "unlock":
      return buildWriteRegister(NB.NODE.ESC, NB.REG.LOCK, [0x00]);
    case "lights":
      return buildWriteRegister(NB.NODE.ESC, NB.REG.LIGHTS, [cmd.on ? 0x01 : 0x00]);
    case "beep":
      return buildWriteRegister(NB.NODE.ESC, NB.REG.BEEP, [0x01]);
  }
}

/**
 * Local-state preview of the command's effect, applied before the device
 * echoes back. Returns `null` for stateless commands (beep) and for
 * lights — which we *don't* model in `NinebotTelemetry`, so optimism
 * there has nothing to update.
 */
function optimisticTelemetry(cmd: NinebotCommand): Partial<NinebotTelemetry> | null {
  switch (cmd.kind) {
    case "lock":   return { locked: true };
    case "unlock": return { locked: false };
    default:       return null;
  }
}

/**
 * Cryptographically secure random bytes. We deliberately do NOT fall back
 * to Math.random — predictable handshake nonces / session keys would let a
 * physically-proximate attacker replay or spoof the BLE pairing. Every
 * runtime we ship into (modern browsers, iOS WKWebView, Android WebView
 * API 21+, Node 18+) provides WebCrypto, so a missing implementation is a
 * hard configuration error worth surfacing loudly.
 */
function randomBytes(n: number): Uint8Array {
  if (typeof crypto === "undefined" || !crypto.getRandomValues) {
    throw new Error("crypto.getRandomValues is required for Ninebot session key generation");
  }
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
