/**
 * Centralised https-only guard for any URL we're about to fetch firmware,
 * catalog JSON, or other supply-chain-sensitive bytes from.
 *
 * Keeping this in one place means the rule is enforced identically in:
 *   - catalog.setCatalogUrl (user-configured catalog endpoint)
 *   - FlashScreen firmware download (catalog-entry url)
 *   - trusted-sources.normalisePrefix (allowlist entries)
 *
 * Plaintext http:// would let a MITM swap bytes; combined with placeholder
 * SHA-256 entries that would silently flash attacker-controlled firmware.
 */

export function isHttpsUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export class InsecureUrlError extends Error {
  constructor(message = "URL must be https://") {
    super(message);
    this.name = "InsecureUrlError";
  }
}

/**
 * Throws InsecureUrlError if `url` is missing, unparseable, or not https.
 * Returns the parsed URL on success so callers can reuse it.
 */
export function assertHttpsUrl(url: string | undefined | null, label = "URL"): URL {
  if (!url) throw new InsecureUrlError(`${label} is required`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InsecureUrlError(`Invalid ${label}`);
  }
  if (parsed.protocol !== "https:") {
    throw new InsecureUrlError(`${label} must be https://`);
  }
  return parsed;
}
