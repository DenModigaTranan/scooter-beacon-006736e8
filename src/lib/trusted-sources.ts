/**
 * Trusted firmware sources.
 *
 * When a catalog entry has no valid SHA-256, the app normally refuses to
 * flash unless the user ticks the "I accept unverified firmware" box on the
 * pre-flight screen. Power users who self-host firmware behind a URL they
 * control can instead add that URL's origin (or a `https://host/path/`
 * prefix) to this allowlist; matching downloads are then treated as trusted
 * and the unverified-firmware ack is bypassed.
 *
 * NOTE: this is a UX convenience, not a cryptographic guarantee. A trusted
 * source still doesn't prove the bytes haven't been tampered with in
 * transit — but TLS + an origin you control is a reasonable trust anchor
 * for community catalogs that don't ship hashes.
 */

const STORAGE_KEY = "scootflash:trusted-sources";

export interface TrustedSource {
  /** User-visible label, e.g. "My self-hosted catalog". */
  label: string;
  /**
   * Either a bare origin (`https://fw.example.com`) or an origin + path
   * prefix (`https://fw.example.com/m365/`). Match is prefix-based after
   * normalising the URL, so a path prefix lets you trust only a subtree.
   */
  prefix: string;
  addedAt: number;
}

function read(): TrustedSource[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is TrustedSource =>
        s && typeof s.label === "string" && typeof s.prefix === "string",
    );
  } catch {
    return [];
  }
}

function write(list: TrustedSource[]): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Normalise a user-entered prefix to `scheme://host[:port]/path` (no query, no fragment). */
export function normalisePrefix(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    // Keep an explicit trailing slash for path-prefix entries so
    // "https://x.com/m365" doesn't accidentally match "https://x.com/m365-evil/...".
    let path = u.pathname || "/";
    if (path !== "/" && !path.endsWith("/")) path += "/";
    return `${u.protocol}//${u.host}${path === "/" ? "" : path}`;
  } catch {
    return null;
  }
}

export function listTrustedSources(): TrustedSource[] {
  return read();
}

export function addTrustedSource(label: string, prefix: string): TrustedSource | null {
  const norm = normalisePrefix(prefix);
  if (!norm) return null;
  const list = read();
  if (list.some((s) => s.prefix === norm)) return list.find((s) => s.prefix === norm) ?? null;
  const entry: TrustedSource = {
    label: label.trim() || norm,
    prefix: norm,
    addedAt: Date.now(),
  };
  write([entry, ...list]);
  return entry;
}

export function removeTrustedSource(prefix: string): void {
  write(read().filter((s) => s.prefix !== prefix));
}

/**
 * Returns the matching trusted source for a given firmware URL, or null.
 * A URL matches when it begins with a stored prefix (origin-only entries
 * match any path on that origin; path entries match that subtree only).
 */
export function findTrustedSource(url: string | undefined): TrustedSource | null {
  if (!url) return null;
  let normalised: string;
  try {
    const u = new URL(url);
    normalised = `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
  const list = read();
  for (const s of list) {
    // Origin-only entry ends at host; treat it as matching any path.
    const isOriginOnly = (() => {
      try {
        const p = new URL(s.prefix);
        return p.pathname === "" || p.pathname === "/";
      } catch {
        return false;
      }
    })();
    if (isOriginOnly) {
      const origin = s.prefix.replace(/\/$/, "");
      if (normalised.startsWith(origin + "/") || normalised === origin) return s;
    } else if (normalised.startsWith(s.prefix)) {
      return s;
    }
  }
  return null;
}

export function isUrlTrusted(url: string | undefined): boolean {
  return !!findTrustedSource(url);
}

/**
 * Versioned export envelope so future schema changes can be detected on
 * import without silently corrupting the user's allowlist.
 */
export interface TrustedSourcesExport {
  kind: "scootflash:trusted-sources";
  version: 1;
  exportedAt: string;
  sources: TrustedSource[];
}

export function exportTrustedSources(): TrustedSourcesExport {
  return {
    kind: "scootflash:trusted-sources",
    version: 1,
    exportedAt: new Date().toISOString(),
    sources: read(),
  };
}

export function exportTrustedSourcesJson(): string {
  return JSON.stringify(exportTrustedSources(), null, 2);
}

export interface ImportResult {
  added: number;
  skipped: number;
  total: number;
}

/**
 * Import a previously-exported allowlist. Existing entries are preserved;
 * new ones are merged in by normalised prefix. Returns counts so the UI can
 * surface a meaningful toast.
 */
export function importTrustedSources(
  raw: string,
  opts: { replace?: boolean } = {},
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Not valid JSON");
  }

  // Accept both the envelope and a bare array for forgiving imports.
  let incoming: unknown[];
  if (Array.isArray(parsed)) {
    incoming = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as { kind?: string }).kind === "scootflash:trusted-sources" &&
    Array.isArray((parsed as { sources?: unknown }).sources)
  ) {
    incoming = (parsed as { sources: unknown[] }).sources;
  } else {
    throw new Error("Unrecognised export format");
  }

  const existing = opts.replace ? [] : read();
  const byPrefix = new Map(existing.map((s) => [s.prefix, s]));
  let added = 0;
  let skipped = 0;

  for (const item of incoming) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as TrustedSource).prefix !== "string"
    ) {
      skipped++;
      continue;
    }
    const candidate = item as Partial<TrustedSource>;
    const norm = normalisePrefix(candidate.prefix ?? "");
    if (!norm) {
      skipped++;
      continue;
    }
    if (byPrefix.has(norm)) {
      skipped++;
      continue;
    }
    const entry: TrustedSource = {
      label: (candidate.label ?? "").trim() || norm,
      prefix: norm,
      addedAt:
        typeof candidate.addedAt === "number" ? candidate.addedAt : Date.now(),
    };
    byPrefix.set(norm, entry);
    added++;
  }

  const merged = Array.from(byPrefix.values()).sort(
    (a, b) => b.addedAt - a.addedAt,
  );
  write(merged);
  return { added, skipped, total: merged.length };
}
