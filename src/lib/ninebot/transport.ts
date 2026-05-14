/**
 * Ninebot transport abstraction.
 *
 * Two implementations live behind one interface:
 *
 *   - `createMockTransport()` — passthrough over `genericBle`. Frames are
 *     written and received verbatim. This is what the in-process mock
 *     peripheral consumes today and is the default for the Lovable web
 *     preview.
 *
 *   - `createRealDeviceTransport()` — same `genericBle` calls, but every
 *     non-handshake frame's payload is routed through the AES-128-CTR
 *     seam in `./protocol.ts`. Outgoing: parse → encrypt payload →
 *     re-checksum → write. Incoming: parse → decrypt payload → re-emit
 *     bytes upstream so the existing `consumeFrames` reader in
 *     `./session.ts` keeps working unchanged on plaintext frames.
 *
 * The session layer flips the active key via `setSessionKey()` once the
 * AUTH_OK reply lands; before that, both transports behave as identity
 * (handshake frames are never enciphered).
 *
 * This module is *transport-only* — it doesn't know about registers,
 * polling, or React. That keeps it unit-testable in isolation and lets a
 * future Capacitor-only build swap the underlying BLE driver without
 * touching session/state.
 */

import { genericBle } from "@/lib/generic-ble";
import {
  HANDSHAKE_CMDS,
  NB_GATT,
  buildFrame,
  consumeFrames,
  decryptPayload,
  encryptPayload,
} from "./protocol";

export interface NinebotTransport {
  /** Subscribe to inbound frame bytes. Returns an unsubscribe handle. */
  subscribe(onBytes: (bytes: Uint8Array) => void): Promise<() => Promise<void>>;
  /**
   * Write a fully-formed wire frame. Implementations may re-cipher the
   * payload before handing it to the BLE write characteristic.
   */
  send(frame: Uint8Array): Promise<void>;
  /**
   * Install (or clear, with `null`) the session key used to cipher
   * post-handshake frames. Has no effect on the mock transport.
   */
  setSessionKey(key: Uint8Array | null): void;
  /** Identifier for diagnostics / logging. */
  readonly kind: "mock" | "real-device";
}

/**
 * Mock / passthrough transport — what every page in the Lovable preview
 * uses today. No cipher, no frame rewriting; just forwards bytes to the
 * `genericBle` adapter (which itself dispatches to the in-process mock or
 * to native BLE on Capacitor builds).
 */
export function createMockTransport(): NinebotTransport {
  return {
    kind: "mock",
    async subscribe(onBytes) {
      return genericBle.startNotifications(
        NB_GATT.SERVICE, NB_GATT.CHAR_TX, onBytes,
      );
    },
    async send(frame) {
      await genericBle.writeCharacteristic(
        NB_GATT.SERVICE, NB_GATT.CHAR_RX, frame, false,
      );
    },
    setSessionKey() { /* no-op */ },
  };
}

/**
 * Real-device transport — same wire path, but applies the AES-128-CTR
 * cipher to every non-handshake frame. Today this is a *stub*: it's
 * functionally complete (you can flip a session over to it), but the key
 * derivation and counter-block layout in `./protocol.ts` are best-effort
 * until validated against a paired scooter. Use behind an explicit opt-in
 * flag, never as the default.
 */
export function createRealDeviceTransport(): NinebotTransport {
  let sessionKey: Uint8Array | null = null;
  let inboundLeftover: Uint8Array = new Uint8Array(0);

  return {
    kind: "real-device",
    setSessionKey(key) { sessionKey = key; },

    async subscribe(onBytes) {
      // We have to re-frame inbound bytes ourselves so we can decrypt
      // each frame's payload before forwarding. Anything that isn't a
      // complete frame yet stays in `inboundLeftover` until the next
      // notification arrives.
      return genericBle.startNotifications(
        NB_GATT.SERVICE, NB_GATT.CHAR_TX,
        async (chunk) => {
          const merged = new Uint8Array(inboundLeftover.length + chunk.length);
          merged.set(inboundLeftover, 0);
          merged.set(chunk, inboundLeftover.length);
          const { frames, remaining } = consumeFrames(merged);
          inboundLeftover = remaining;
          for (const f of frames) {
            const decrypted = HANDSHAKE_CMDS.has(f.cmd)
              ? f.payload
              : await decryptPayload(f.payload, sessionKey);
            // Re-emit a wire-format frame with the deciphered payload so
            // the upstream session keeps using its own framer/decoder
            // unchanged. Slightly wasteful (we framed → unframed →
            // re-framed), but it keeps the seam tight and means the
            // decoder is the single source of truth for parsing.
            const replayed = buildFrame({
              src: f.src, dst: f.dst, cmd: f.cmd, arg: f.arg,
              payload: new Uint8Array(decrypted),
            });
            onBytes(replayed);
          }
        },
      );
    },

    async send(frame) {
      // Handshake frames go through verbatim — no key exists yet, and
      // the device firmware is in plaintext mode until AUTH_OK.
      const parsed = consumeFrames(frame).frames[0];
      if (!parsed || HANDSHAKE_CMDS.has(parsed.cmd)) {
        await genericBle.writeCharacteristic(
          NB_GATT.SERVICE, NB_GATT.CHAR_RX, frame, false,
        );
        return;
      }
      const cipherPayload = await encryptPayload(parsed.payload, sessionKey);
      const ciphered = buildFrame({
        src: parsed.src, dst: parsed.dst, cmd: parsed.cmd, arg: parsed.arg,
        payload: cipherPayload,
      });
      await genericBle.writeCharacteristic(
        NB_GATT.SERVICE, NB_GATT.CHAR_RX, ciphered, false,
      );
    },
  };
}
