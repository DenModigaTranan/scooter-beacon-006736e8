/**
 * Centralised firmware fetcher. The https-only assertion happens BEFORE
 * we touch the network, so an http:// (or any non-https) catalog entry
 * can never cause a request to be issued.
 *
 * Used by FlashScreen as the single firmware-download path so the
 * supply-chain guard cannot be bypassed by a future refactor that
 * forgets to re-check the protocol.
 */
import { assertHttpsUrl } from "@/lib/https-url";

export async function downloadFirmware(
  url: string,
  init?: { signal?: AbortSignal },
): Promise<Uint8Array> {
  // Throws InsecureUrlError synchronously for non-https URLs — guaranteed
  // to run before `fetch` is invoked.
  assertHttpsUrl(url, "Firmware URL");
  const res = await fetch(url, { signal: init?.signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
