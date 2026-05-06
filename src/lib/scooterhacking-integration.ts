/**
 * Placeholder integration module for the (unpublished) `scooterhacking-protocol`
 * library. The real package isn't installed, so this file just defines the
 * surface area we'll eventually implement against. Methods throw until wired
 * up to a concrete protocol implementation.
 */

interface FrameEncoding {
  bytes: Uint8Array;
}

interface AuthHandshake {
  ok: boolean;
  reason?: string;
}

interface FirmwareUpdate {
  version: string;
  started: boolean;
}

export class ScooterHackingIntegration {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public encodeFrame(_data: unknown): FrameEncoding {
    throw new Error("ScooterHackingIntegration.encodeFrame: not implemented");
  }

  public authenticate(): AuthHandshake {
    throw new Error("ScooterHackingIntegration.authenticate: not implemented");
  }

  public updateFirmware(_version: string): FirmwareUpdate {
    throw new Error("ScooterHackingIntegration.updateFirmware: not implemented");
  }
}
