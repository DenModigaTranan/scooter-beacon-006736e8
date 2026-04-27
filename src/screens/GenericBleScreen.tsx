/**
 * Generic BLE scanner screen.
 *
 * Used when the active profile is `generic-ble`. Lets the user:
 *   • see live scan status (idle / scanning / stopped / error)
 *   • watch nearby BLE peripherals stream in with RSSI, name, UUIDs
 *   • filter the list by name / UUID / address
 *   • tap a row to connect; full connection-state feedback and a discovered
 *     GATT layout once connected
 *   • disconnect cleanly and re-scan
 *
 * This is intentionally *separate* from the M365 ConnectScreen — the M365
 * flow auto-handshakes and reads protocol-specific registers, whereas this
 * screen is a neutral exploration tool that never speaks any proprietary
 * protocol.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Bluetooth, Loader2, RefreshCw, Search, Signal, X, Zap, Check,
  AlertTriangle, WifiOff, Plug, PlugZap, ChevronRight, Download, Upload, Bell, BellOff,
  ChevronDown, ScrollText, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  genericBle, formatBytes, getMockHint, charKey,
  type GenericDevice, type GenericServiceInfo, type GenericCharInfo,
} from "@/lib/generic-ble";

type ScanState = "idle" | "scanning" | "stopped" | "error";
type ConnState = "disconnected" | "connecting" | "connected" | "error";

const SCAN_DURATION_MS = 6000;

/**
 * Connect-retry policy. We never want the UI to hang in "connecting" — if
 * the underlying plugin promise stalls (which happens on flaky links or when
 * the peer fails GATT before the OS notices), each attempt is hard-capped
 * at PER_ATTEMPT_TIMEOUT_MS. After a failure, we wait BACKOFFS_MS[i] and try
 * again, up to MAX_ATTEMPTS total. The whole sequence is abortable by the
 * user from the connecting banner.
 */
const PER_ATTEMPT_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;
const BACKOFFS_MS = [500, 1500] as const; // delays between attempts 1→2, 2→3

/** Phase within a single connect sequence — drives banner UI. */
type ConnectPhase =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number; deadlineAt: number }
  | { kind: "backoff"; nextAttempt: number; resumeAt: number; lastError: string };

/**
 * One entry in the user-visible connection log. We keep the structure flat
 * and tiny so the panel can render hundreds of events without churning.
 *
 * `kind` drives the row icon + color; `at` is captured at push time so the
 * timestamp reflects when the event actually happened, not when React
 * eventually re-rendered.
 */
type LogKind =
  | "attempt-start"
  | "attempt-ok"
  | "timeout"
  | "attempt-fail"
  | "backoff"
  | "cancel"
  | "disconnect"
  | "info";

interface LogEntry {
  id: number;
  at: number;
  kind: LogKind;
  message: string;
}

/** Cap log size — old entries get evicted FIFO so memory stays bounded. */
const LOG_MAX_ENTRIES = 100;

function rssiBars(rssi: number): number {
  if (rssi >= -55) return 4;
  if (rssi >= -65) return 3;
  if (rssi >= -75) return 2;
  return 1;
}

function shortUuid(uuid: string): string {
  // 16-bit-derived UUIDs follow the BT-base pattern; collapse to 0xXXXX.
  const m = uuid.match(/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i);
  return m ? `0x${m[1].toUpperCase()}` : uuid.toUpperCase();
}

export function GenericBleScreen() {
  const [scanState, setScanState] = useState<ScanState>("idle");
  const [scanError, setScanError] = useState<string | null>(null);
  const [devices, setDevices] = useState<GenericDevice[]>([]);
  const [filter, setFilter] = useState("");

  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [connError, setConnError] = useState<string | null>(null);
  const [connectedDevice, setConnectedDevice] = useState<GenericDevice | null>(null);
  const [services, setServices] = useState<GenericServiceInfo[]>([]);
  const [discovering, setDiscovering] = useState(false);
  // Drives the per-attempt UI (attempt N/3, "retrying in 1s…", deadline bar).
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>({ kind: "idle" });
  // Tick clock so the banner countdown re-renders every ~250ms while connecting.
  const [now, setNow] = useState(() => Date.now());
  // User-visible connection log. Newest entry first; capped at LOG_MAX_ENTRIES.
  const [log, setLog] = useState<LogEntry[]>([]);
  // Monotonic id generator for log entries — survives re-renders.
  const logIdRef = useRef(0);

  /**
   * Append an entry to the connection log. Stable identity via useCallback so
   * it can be safely depended on inside other callbacks. New entries go to
   * the front so the panel reads top-down (most recent first).
   */
  const pushLog = useCallback((kind: LogKind, message: string) => {
    setLog((prev) => {
      const next: LogEntry = {
        id: ++logIdRef.current,
        at: Date.now(),
        kind,
        message,
      };
      const out = [next, ...prev];
      return out.length > LOG_MAX_ENTRIES ? out.slice(0, LOG_MAX_ENTRIES) : out;
    });
  }, []);

  const clearLog = useCallback(() => setLog([]), []);

  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * AbortController for the ENTIRE connect sequence (all retries + backoffs).
   * Created at the top of `connect()` and consulted at every await boundary
   * so the user can bail at any time.
   */
  const connectAbortRef = useRef<AbortController | null>(null);
  /**
   * Synchronous re-entry guard. React state updates are batched/async, so two
   * rapid clicks on the same (or different) CONNECT button can both pass the
   * `connState === "connecting"` check before either render commits. This ref
   * flips synchronously inside connect() so a second invocation in the same
   * tick is rejected immediately.
   */
  const connectInFlightRef = useRef(false);

  // ---- scanning ----------------------------------------------------------
  const startScan = useCallback(async () => {
    setScanError(null);
    setScanState("scanning");
    setDevices([]);
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    try {
      // Merge updates into a Map keyed by deviceId so duplicate scan records
      // refresh RSSI / name without creating duplicate rows.
      const acc = new Map<string, GenericDevice>();
      await genericBle.scan((d) => {
        acc.set(d.deviceId, { ...acc.get(d.deviceId), ...d });
        setDevices(Array.from(acc.values()).sort((a, b) => b.rssi - a.rssi));
      }, SCAN_DURATION_MS);
      setScanState("stopped");
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
      setScanState("error");
    }
  }, []);

  const stopScan = useCallback(async () => {
    await genericBle.stopScan();
    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
    setScanState("stopped");
  }, []);

  useEffect(() => {
    // auto-scan on first mount
    startScan();
    return () => {
      connectAbortRef.current?.abort();
      genericBle.stopScan().catch(() => {});
      genericBle.disconnect().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-render the banner countdown while a connect sequence is active, and
  // also tick once per second whenever the connection log has any entries so
  // the "Xs ago" relative timestamps stay accurate even when nothing else is
  // happening on the screen.
  useEffect(() => {
    const fast = connectPhase.kind !== "idle";
    if (!fast && log.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), fast ? 250 : 1000);
    return () => clearInterval(id);
  }, [connectPhase.kind, log.length]);

  // ---- connecting --------------------------------------------------------

  /**
   * Cancel the in-flight connect sequence (timeout + retries). Safe to call
   * at any phase. Tears down any partial GATT connection so the OS doesn't
   * keep us in a half-open state.
   */
  const cancelConnect = useCallback(async () => {
    connectAbortRef.current?.abort();
    connectAbortRef.current = null;
    connectInFlightRef.current = false;
    setConnectPhase({ kind: "idle" });
    setConnState("disconnected");
    setConnectedDevice(null);
    setConnError("cancelled by user");
    pushLog("cancel", "Cancelled by user");
    try { await genericBle.disconnect(); } catch { /* ignore */ }
  }, [pushLog]);

  const connect = useCallback(async (d: GenericDevice) => {
    // Synchronous guard — rejects re-entry within the same tick before any
    // React state has had a chance to flush. Combined with the disabled
    // button this makes overlapping connects impossible.
    if (connectInFlightRef.current) return;
    if (connState === "connecting") return;
    connectInFlightRef.current = true;
    // Tear down any previous connect sequence and any existing connection.
    connectAbortRef.current?.abort();
    if (connState === "connected") {
      try { await genericBle.disconnect(); } catch { /* ignore */ }
    }
    await genericBle.stopScan().catch(() => {});
    setScanState("stopped");
    setConnectedDevice(d);
    setConnState("connecting");
    setConnError(null);
    setServices([]);
    pushLog("info", `Connect requested → ${d.name || d.deviceId.slice(0, 17)}`);

    const ac = new AbortController();
    connectAbortRef.current = ac;
    const aborted = () => ac.signal.aborted;

    /**
     * Race the plugin's connect() against a hard timeout. Resolves when the
     * GATT link is up; rejects with a timeout/abort/plugin error otherwise.
     */
    const attemptOnce = (attempt: number): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

        // Captured at the moment we kick off the plugin call so the duration
        // reported in log entries reflects the real wall-clock attempt time,
        // not when React eventually scheduled the log push.
        const startedAt = Date.now();
        const elapsed = () => Date.now() - startedAt;
        const cap = formatMs(PER_ATTEMPT_TIMEOUT_MS);

        const timeoutId = setTimeout(() => {
          finish(() => reject(new Error(`timed out after ${PER_ATTEMPT_TIMEOUT_MS}ms`)));
          pushLog(
            "timeout",
            `Attempt ${attempt} hit timeout (${formatMs(elapsed())} / cap ${cap})`,
          );
          // Best-effort cleanup so the next attempt starts clean.
          genericBle.disconnect().catch(() => {});
        }, PER_ATTEMPT_TIMEOUT_MS);

        const onAbort = () => {
          clearTimeout(timeoutId);
          finish(() => reject(new Error("cancelled")));
          genericBle.disconnect().catch(() => {});
        };
        ac.signal.addEventListener("abort", onAbort, { once: true });

        setConnectPhase({
          kind: "connecting",
          attempt,
          deadlineAt: startedAt + PER_ATTEMPT_TIMEOUT_MS,
        });
        pushLog(
          "attempt-start",
          `Attempt ${attempt}/${MAX_ATTEMPTS} started (timeout ${cap})`,
        );

        genericBle.connect(d.deviceId, () => {
          // Peer-initiated disconnect AFTER we resolved → propagate to UI.
          // Before we resolved, treat it as a failed attempt so the retry
          // loop kicks in.
          if (settled) {
            setConnState("disconnected");
            setConnectedDevice(null);
            setServices([]);
          } else {
            finish(() => reject(new Error(`disconnected before GATT ready (after ${formatMs(elapsed())})`)));
          }
        }).then(
          () => {
            const took = elapsed();
            clearTimeout(timeoutId);
            ac.signal.removeEventListener("abort", onAbort);
            finish(() => resolve());
            pushLog(
              "attempt-ok",
              `Attempt ${attempt} succeeded — link up in ${formatMs(took)} (cap ${cap})`,
            );
          },
          (err) => {
            const took = elapsed();
            clearTimeout(timeoutId);
            ac.signal.removeEventListener("abort", onAbort);
            const e = err instanceof Error ? err : new Error(String(err));
            // Annotate the rejection with timing so the outer loop can render
            // a uniform "took Xs" tail in the FAIL log entry.
            (e as Error & { tookMs?: number }).tookMs = took;
            finish(() => reject(e));
          },
        );
      });

    /**
     * Wait `ms` but resolve early on abort. Used between retry attempts so
     * Cancel always feels instant.
     */
    const sleepOrAbort = (ms: number, resumeAt: number) =>
      new Promise<void>((resolve) => {
        const onAbort = () => { clearTimeout(t); resolve(); };
        const t = setTimeout(() => {
          ac.signal.removeEventListener("abort", onAbort);
          resolve();
        }, ms);
        ac.signal.addEventListener("abort", onAbort, { once: true });
        // Refresh deadline on tick so the banner can show "retrying in Xs".
        void resumeAt;
      });

    let lastError: Error | null = null;
    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (aborted()) throw new Error("cancelled");
        try {
          await attemptOnce(attempt);
          lastError = null;
          // Success log already pushed from inside attemptOnce so it carries
          // the precise wall-clock duration instead of "after the await".
          break;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          if (lastError.message === "cancelled") throw lastError;
          // Avoid double-logging the timeout (already logged inside attemptOnce).
          if (!lastError.message.startsWith("timed out")) {
            const tookMs = (lastError as Error & { tookMs?: number }).tookMs;
            const tail = tookMs !== undefined ? ` (took ${formatMs(tookMs)})` : "";
            pushLog("attempt-fail", `Attempt ${attempt} failed${tail}: ${lastError.message}`);
          }
          if (attempt >= MAX_ATTEMPTS) throw lastError;
          const delay = BACKOFFS_MS[Math.min(attempt - 1, BACKOFFS_MS.length - 1)];
          const resumeAt = Date.now() + delay;
          setConnectPhase({
            kind: "backoff",
            nextAttempt: attempt + 1,
            resumeAt,
            lastError: lastError.message,
          });
          pushLog("backoff", `Backoff ${formatMs(delay)} before attempt ${attempt + 1}`);
          await sleepOrAbort(delay, resumeAt);
          if (aborted()) throw new Error("cancelled");
        }
      }

      // Connected — discover services.
      setConnState("connected");
      setConnectPhase({ kind: "idle" });
      setDiscovering(true);
      try {
        const svcs = await genericBle.discoverServices();
        if (!aborted()) setServices(svcs);
      } finally {
        setDiscovering(false);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setConnectPhase({ kind: "idle" });
      if (msg === "cancelled") {
        // cancelConnect() already wrote disconnected/error message.
        return;
      }
      setConnError(msg);
      setConnState("error");
      pushLog("attempt-fail", `Connect sequence failed: ${msg}`);
      try { await genericBle.disconnect(); } catch { /* ignore */ }
    } finally {
      if (connectAbortRef.current === ac) connectAbortRef.current = null;
      connectInFlightRef.current = false;
    }
  }, [connState, pushLog]);

  const disconnect = useCallback(async () => {
    connectAbortRef.current?.abort();
    connectInFlightRef.current = false;
    await genericBle.disconnect();
    setConnState("disconnected");
    setConnectPhase({ kind: "idle" });
    setConnectedDevice(null);
    setServices([]);
    pushLog("disconnect", "Disconnected by user");
  }, [pushLog]);

  // ---- filtering ---------------------------------------------------------
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter((d) =>
      d.name.toLowerCase().includes(q) ||
      d.deviceId.toLowerCase().includes(q) ||
      d.serviceUuids.some((u) => u.includes(q))
    );
  }, [devices, filter]);

  return (
    <div className="px-4 pt-4 pb-28 max-w-md mx-auto space-y-4 animate-fade-in">
      {/* Connection status banner */}
      <ConnStatusBanner
        connState={connState}
        device={connectedDevice}
        error={connError}
        phase={connectPhase}
        now={now}
        onDisconnect={disconnect}
        onCancel={cancelConnect}
        onRetry={() => connectedDevice && connect(connectedDevice)}
      />

      {/* Connection log — small expandable panel of timestamped events */}
      <ConnectionLogPanel entries={log} onClear={clearLog} now={now} />
      {/* Discovered services panel — only when connected */}
      <AnimatePresence>
        {connState === "connected" && (
          <motion.section
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="panel p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="mono text-[11px] tracking-[0.22em] uppercase text-muted-foreground">
                GATT Services
              </span>
              {discovering ? (
                <span className="mono text-[10px] text-muted-foreground inline-flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> discovering…
                </span>
              ) : (
                <span className="mono text-[10px] text-muted-foreground">{services.length} found</span>
              )}
            </div>
            {!discovering && services.length === 0 && (
              <div className="text-xs text-muted-foreground py-2">
                No services exposed (or discovery not supported on this platform).
              </div>
            )}
            <ul className="space-y-2">
              {services.map((s) => (
                <li key={s.uuid} className="rounded-md bg-secondary/40 p-2">
                  <div className="mono text-[11px] truncate mb-1.5">{shortUuid(s.uuid)}</div>
                  {s.characteristics.length > 0 && (
                    <ul className="space-y-1.5 pl-2 border-l border-border/50">
                      {s.characteristics.map((c) => (
                        <li key={c.uuid}>
                          <CharacteristicRow
                            deviceId={connectedDevice?.deviceId ?? ""}
                            serviceUuid={s.uuid}
                            char={c}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </motion.section>
        )}
      </AnimatePresence>

      {/* Scanner header + filter */}
      <section>
        <div className="flex items-center justify-between mb-2.5">
          <div className="flex items-center gap-2">
            <span className="mono text-[11px] tracking-[0.22em] uppercase text-muted-foreground">
              Nearby BLE
            </span>
            <ScanStateChip state={scanState} count={devices.length} />
          </div>
          <div className="flex items-center gap-2">
            {scanState === "scanning" ? (
              <button
                onClick={stopScan}
                className="text-xs mono uppercase tracking-widest text-muted-foreground hover:text-foreground"
              >
                Stop
              </button>
            ) : (
              <button
                onClick={startScan}
                className="text-muted-foreground hover:text-primary-glow transition-colors"
                aria-label="Rescan"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Filter input */}
        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, address, or UUID…"
            className="mono text-xs pl-8 pr-8 h-9"
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Device list */}
        <div className="space-y-2">
          {scanState === "scanning" && filtered.length === 0 && (
            <div className="panel p-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Scanning the airwaves…
            </div>
          )}

          {scanState !== "scanning" && devices.length === 0 && scanState !== "error" && (
            <div className="panel p-6 text-center text-sm text-muted-foreground">
              No BLE devices found. Move closer and tap rescan.
            </div>
          )}

          {scanState === "error" && (
            <div className="panel p-4 border-destructive/40 bg-destructive/5 text-destructive text-xs mono flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div className="uppercase tracking-widest text-[10px] mb-1">Scan failed</div>
                <div className="leading-relaxed">{scanError}</div>
              </div>
            </div>
          )}

          {filter && devices.length > 0 && filtered.length === 0 && (
            <div className="panel p-4 text-center text-xs text-muted-foreground">
              No results for "{filter}".
            </div>
          )}

          {filtered.map((d) => (
            <DeviceRow
              key={d.deviceId}
              device={d}
              isConnected={connState === "connected" && connectedDevice?.deviceId === d.deviceId}
              isConnecting={connState === "connecting" && connectedDevice?.deviceId === d.deviceId}
              disabled={connState === "connecting"}
              onConnect={() => connect(d)}
              onDisconnect={disconnect}
            />
          ))}
        </div>
      </section>

      {/* Bottom action */}
      <div className="pt-2 flex justify-center">
        <Button
          onClick={startScan}
          disabled={scanState === "scanning"}
          size="lg"
          className="bg-gradient-mint text-primary-foreground shadow-mint hover:opacity-90 mono tracking-widest"
        >
          {scanState === "scanning" ? "SCANNING…" : "SCAN AGAIN"}
        </Button>
      </div>

      <p className="text-[10px] text-muted-foreground/70 text-center pt-1 leading-relaxed">
        Generic mode exposes raw GATT — read, write, and subscribe per
        characteristic. Mock peripherals (preview only) simulate live
        notifications so the UI is fully testable without hardware.
      </p>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

/**
 * Compact, expandable connection log. Collapsed by default to keep the screen
 * clean; once opened, shows a scrollable, color-coded list of every attempt,
 * timeout, backoff, success, cancel and disconnect with absolute timestamps
 * (HH:MM:SS.mmm) and a relative "Xs ago" hint that auto-refreshes.
 *
 * The header always shows the latest event so the user gets a one-line status
 * even without expanding.
 */
function ConnectionLogPanel({
  entries, onClear, now,
}: {
  entries: LogEntry[];
  onClear: () => void;
  now: number;
}) {
  const [open, setOpen] = useState(false);

  // Latest entry in header — `entries` is already newest-first.
  const latest = entries[0];

  const meta: Record<LogKind, { label: string; cls: string; dot: string }> = {
    "attempt-start": { label: "TRY",      cls: "text-primary-glow",      dot: "bg-primary-glow" },
    "attempt-ok":    { label: "OK",       cls: "text-primary-glow",      dot: "bg-primary-glow" },
    "timeout":       { label: "TIMEOUT",  cls: "text-warning",           dot: "bg-warning" },
    "attempt-fail":  { label: "FAIL",     cls: "text-destructive",       dot: "bg-destructive" },
    "backoff":       { label: "BACKOFF",  cls: "text-warning/80",        dot: "bg-warning/80" },
    "cancel":        { label: "CANCEL",   cls: "text-muted-foreground",  dot: "bg-muted-foreground" },
    "disconnect":    { label: "DISC",     cls: "text-muted-foreground",  dot: "bg-muted-foreground" },
    "info":          { label: "INFO",     cls: "text-muted-foreground",  dot: "bg-muted-foreground" },
  };

  return (
    <section className="panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-secondary/30 transition-colors"
        aria-expanded={open}
      >
        <div className="w-7 h-7 rounded-md bg-secondary flex items-center justify-center shrink-0">
          <ScrollText className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground flex items-center gap-2">
            <span>Connection log</span>
            <span className="text-muted-foreground/60 normal-case tracking-normal">
              {entries.length} {entries.length === 1 ? "event" : "events"}
            </span>
          </div>
          {latest ? (
            <div className="mono text-[11px] truncate flex items-center gap-1.5">
              <span className={cn("w-1 h-1 rounded-full shrink-0", meta[latest.kind].dot)} />
              <span className={cn("shrink-0", meta[latest.kind].cls)}>
                [{meta[latest.kind].label}]
              </span>
              <span className="text-foreground/85 truncate">{latest.message}</span>
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground/70">No events yet.</div>
          )}
        </div>
        <ChevronDown
          className={cn(
            "w-4 h-4 text-muted-foreground transition-transform shrink-0",
            open && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="log-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="border-t border-border/50"
          >
            <div className="flex items-center justify-between px-3 py-1.5 bg-secondary/20">
              <span className="mono text-[9px] tracking-widest uppercase text-muted-foreground/80">
                Newest first · max {LOG_MAX_ENTRIES}
              </span>
              <button
                type="button"
                onClick={onClear}
                disabled={entries.length === 0}
                className="mono text-[9px] tracking-widest uppercase text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Clear
              </button>
            </div>
            <ul className="max-h-56 overflow-y-auto divide-y divide-border/30">
              {entries.length === 0 ? (
                <li className="px-3 py-4 text-center text-[11px] text-muted-foreground/70">
                  Trigger a connect to see events appear here.
                </li>
              ) : (
                entries.map((e) => (
                  <li key={e.id} className="px-3 py-1.5 flex items-start gap-2">
                    <span
                      className={cn("w-1.5 h-1.5 rounded-full mt-1.5 shrink-0", meta[e.kind].dot)}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="mono text-[10px] text-muted-foreground/80 flex items-center gap-1.5">
                        <span>{formatLogTime(e.at)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span className={meta[e.kind].cls}>{meta[e.kind].label}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatRelative(e.at, now)}</span>
                      </div>
                      <div className="mono text-[11px] text-foreground/90 break-words leading-snug">
                        {e.message}
                      </div>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** HH:MM:SS.mmm — fixed width so rows align nicely. */
function formatLogTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Short relative age — "now", "3s ago", "1m 12s ago", "2h ago". */
function formatRelative(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 1) return "now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}m ${rem}s ago` : `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

// ============================================================================
// Sub-components
// ============================================================================


function ScanStateChip({ state, count }: { state: ScanState; count: number }) {
  const map: Record<ScanState, { label: string; cls: string; dot: string }> = {
    idle:     { label: "IDLE",     cls: "text-muted-foreground", dot: "bg-muted-foreground" },
    scanning: { label: `SCANNING · ${count}`, cls: "text-primary-glow", dot: "bg-primary-glow animate-pulse" },
    stopped:  { label: `STOPPED · ${count}`,  cls: "text-muted-foreground", dot: "bg-muted-foreground" },
    error:    { label: "ERROR",    cls: "text-destructive", dot: "bg-destructive" },
  };
  const m = map[state];
  return (
    <span className={cn("chip text-[9px] tracking-[0.18em] inline-flex items-center gap-1.5", m.cls)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

function ConnStatusBanner({
  connState, device, error, phase, now, onDisconnect, onCancel, onRetry,
}: {
  connState: ConnState;
  device: GenericDevice | null;
  error: string | null;
  phase: ConnectPhase;
  now: number;
  onDisconnect: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (connState === "disconnected") {
    return (
      <div className="panel p-3 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center">
          <WifiOff className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
            Not connected
          </div>
          <div className="text-xs text-muted-foreground/80">Pick a device below to connect.</div>
        </div>
      </div>
    );
  }

  if (connState === "connecting") {
    // Derive UI from the retry-state-machine phase. While "connecting" we
    // show attempt N/MAX and a slim deadline progress bar; while "backoff"
    // we show "retrying in Xs" with a count-up to the next attempt.
    const isBackoff = phase.kind === "backoff";
    const attempt = phase.kind === "connecting" ? phase.attempt
                  : phase.kind === "backoff"   ? phase.nextAttempt - 1
                  : 1;
    const deadlineAt = phase.kind === "connecting" ? phase.deadlineAt : 0;
    const remainingMs = deadlineAt ? Math.max(0, deadlineAt - now) : 0;
    const elapsedFrac = deadlineAt
      ? Math.min(1, 1 - remainingMs / PER_ATTEMPT_TIMEOUT_MS)
      : 0;
    const resumeIn = phase.kind === "backoff" ? Math.max(0, Math.ceil((phase.resumeAt - now) / 1000)) : 0;

    return (
      <div className="panel-glow p-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-primary/20 flex items-center justify-center">
            <Loader2 className="w-4 h-4 text-primary-glow animate-spin" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="mono text-[10px] tracking-[0.22em] uppercase text-primary-glow flex items-center gap-2">
              <span>{isBackoff ? "Retrying" : "Connecting…"}</span>
              <span className="text-muted-foreground/80">
                attempt {attempt}/{MAX_ATTEMPTS}
              </span>
            </div>
            <div className="mono text-xs truncate">{device?.name}</div>
            {isBackoff && phase.kind === "backoff" && (
              <div className="mono text-[10px] text-warning/90 truncate mt-0.5">
                {phase.lastError} · next try in {resumeIn}s
              </div>
            )}
            {!isBackoff && deadlineAt > 0 && (
              <div className="mono text-[10px] text-muted-foreground mt-0.5">
                timeout in {Math.ceil(remainingMs / 1000)}s
              </div>
            )}
          </div>
          <Button
            onClick={onCancel}
            size="sm"
            variant="outline"
            className="mono text-[10px] tracking-widest shrink-0"
          >
            CANCEL
          </Button>
        </div>
        {/* Slim deadline indicator: fills as the per-attempt timeout approaches. */}
        <div className="mt-2 h-0.5 w-full rounded-full bg-secondary overflow-hidden">
          <div
            className={cn(
              "h-full transition-[width] duration-200 ease-linear",
              isBackoff ? "bg-warning/70" : "bg-primary-glow",
            )}
            style={{
              width: isBackoff
                ? "100%"
                : `${Math.round(elapsedFrac * 100)}%`,
            }}
          />
        </div>
      </div>
    );
  }

  if (connState === "error") {
    return (
      <div className="panel p-3 border-destructive/40 bg-destructive/5">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-md bg-destructive/20 flex items-center justify-center">
            <AlertTriangle className="w-4 h-4 text-destructive" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="mono text-[10px] tracking-[0.22em] uppercase text-destructive">
              Connection failed
            </div>
            <div className="mono text-xs truncate">{device?.name}</div>
          </div>
          <Button onClick={onRetry} size="sm" variant="outline" className="mono text-[10px] tracking-widest">
            RETRY
          </Button>
        </div>
        {error && (
          <div className="mt-2 mono text-[10px] text-destructive leading-relaxed break-all">
            {error}
          </div>
        )}
      </div>
    );
  }

  // connected
  return (
    <div className="panel-glow p-3 flex items-center gap-2.5">
      <div className="w-8 h-8 rounded-md bg-primary/20 flex items-center justify-center">
        <PlugZap className="w-4 h-4 text-primary-glow" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="mono text-[10px] tracking-[0.22em] uppercase text-primary-glow">
          Connected
        </div>
        <div className="mono text-xs truncate">{device?.name}</div>
        <div className="mono text-[10px] text-muted-foreground tracking-widest truncate">
          {device?.deviceId.slice(0, 17).toUpperCase()}
        </div>
      </div>
      <Button onClick={onDisconnect} size="sm" variant="outline" className="mono text-[10px] tracking-widest">
        DISCONNECT
      </Button>
    </div>
  );
}

function DeviceRow({
  device, isConnected, isConnecting, disabled, onConnect, onDisconnect,
}: {
  device: GenericDevice;
  isConnected: boolean;
  isConnecting: boolean;
  disabled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const bars = rssiBars(device.rssi);
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      className={cn(
        "panel p-3.5 transition-all",
        isConnected && "panel-glow",
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn(
          "w-10 h-10 rounded-md flex items-center justify-center shrink-0",
          isConnected ? "bg-primary/20" : "bg-secondary",
        )}>
          {isConnecting ? (
            <Loader2 className="w-5 h-5 text-primary-glow animate-spin" />
          ) : isConnected ? (
            <Check className="w-5 h-5 text-primary-glow" />
          ) : (
            <Bluetooth className="w-5 h-5 text-primary-glow" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="mono text-sm truncate">{device.name}</span>
            {device.mock && (
              <span className="chip text-[8px] tracking-widest text-warning">MOCK</span>
            )}
          </div>
          <div className="mono text-[10px] text-muted-foreground tracking-widest truncate">
            {device.deviceId.slice(0, 17).toUpperCase()} · {device.rssi} dBm
          </div>
        </div>
        <div className="flex items-end gap-0.5 h-4">
          <Signal className="w-3.5 h-3.5 text-muted-foreground mr-1" />
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={cn(
                "w-1 rounded-sm",
                i <= bars ? "bg-primary-glow" : "bg-muted",
              )}
              style={{ height: `${i * 25}%` }}
            />
          ))}
        </div>
      </div>

      {device.serviceUuids.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {device.serviceUuids.slice(0, 4).map((u) => (
            <span key={u} className="chip text-[9px] tracking-widest text-muted-foreground">
              {shortUuid(u)}
            </span>
          ))}
          {device.serviceUuids.length > 4 && (
            <span className="chip text-[9px] tracking-widest text-muted-foreground">
              +{device.serviceUuids.length - 4}
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex justify-end">
        {isConnected ? (
          <Button
            onClick={onDisconnect}
            size="sm"
            variant="outline"
            className="mono text-[10px] tracking-widest"
          >
            DISCONNECT
          </Button>
        ) : (
          <Button
            onClick={onConnect}
            disabled={disabled || isConnecting}
            aria-busy={isConnecting}
            title={
              disabled && !isConnecting
                ? "Another connect attempt is in progress"
                : undefined
            }
            size="sm"
            className={cn(
              "mono text-[10px] tracking-widest",
              "bg-gradient-mint text-primary-foreground shadow-mint hover:opacity-90",
              disabled && !isConnecting && "opacity-50 cursor-not-allowed",
            )}
          >
            {isConnecting ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> CONNECTING</>
            ) : disabled ? (
              <><Plug className="w-3 h-3 mr-1" /> BUSY</>
            ) : (
              <><Plug className="w-3 h-3 mr-1" /> CONNECT <ChevronRight className="w-3 h-3 ml-0.5" /></>
            )}
          </Button>
        )}
      </div>
    </motion.div>
  );
}

// ============================================================================
// Characteristic row — interactive read / write / notify controls
// ============================================================================

/**
 * Renders a single GATT characteristic with controls appropriate to its
 * declared properties. Reads and writes execute against the live mock (or
 * native plugin); notifications stream into a small ring buffer of the most
 * recent samples so the UI exercises subscribe / unsubscribe paths.
 */
function CharacteristicRow({
  deviceId, serviceUuid, char,
}: {
  deviceId: string;
  serviceUuid: string;
  char: GenericCharInfo;
}) {
  const canRead = char.properties.includes("read");
  const canWrite = char.properties.includes("write") || char.properties.includes("writewithoutresponse");
  const writeAcked = char.properties.includes("write");
  const canNotify = char.properties.includes("notify") || char.properties.includes("indicate");

  const hint = getMockHint(deviceId, serviceUuid, char.uuid) ?? "hex";

  const [busy, setBusy] = useState<"read" | "write" | "subscribe" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readValue, setReadValue] = useState<Uint8Array | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [writeText, setWriteText] = useState("");
  const [writeOpen, setWriteOpen] = useState(false);
  const [notifyOn, setNotifyOn] = useState(false);
  const [samples, setSamples] = useState<{ value: Uint8Array; at: number }[]>([]);
  const unsubRef = useRef<null | (() => Promise<void>)>(null);

  // Auto-stop notifications when the row unmounts (e.g. on disconnect).
  useEffect(() => () => { unsubRef.current?.().catch(() => {}); }, []);

  const onRead = async () => {
    setBusy("read");
    setError(null);
    try {
      const v = await genericBle.readCharacteristic(serviceUuid, char.uuid);
      setReadValue(v);
      setReadAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onWrite = async () => {
    const bytes = parseWritePayload(writeText, hint);
    if (!bytes) {
      setError(`Invalid ${hint} payload`);
      return;
    }
    setBusy("write");
    setError(null);
    try {
      await genericBle.writeCharacteristic(serviceUuid, char.uuid, bytes, writeAcked);
      setWriteOpen(false);
      // If readable, refresh the cached value to reflect the write landed.
      if (canRead) {
        try {
          const v = await genericBle.readCharacteristic(serviceUuid, char.uuid);
          setReadValue(v);
          setReadAt(Date.now());
        } catch { /* ignore */ }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const onToggleNotify = async () => {
    setError(null);
    if (notifyOn) {
      try { await unsubRef.current?.(); } catch { /* ignore */ }
      unsubRef.current = null;
      setNotifyOn(false);
      return;
    }
    setBusy("subscribe");
    try {
      const unsub = await genericBle.startNotifications(serviceUuid, char.uuid, (v) => {
        setSamples((prev) => {
          const next = [...prev, { value: v, at: Date.now() }];
          return next.length > 6 ? next.slice(next.length - 6) : next;
        });
      });
      unsubRef.current = unsub;
      setNotifyOn(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-sm bg-background/40 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[10px] text-muted-foreground truncate">
          {shortUuid(char.uuid)}
        </span>
        <span className="mono text-[9px] text-muted-foreground/80 tracking-widest uppercase shrink-0">
          {char.properties.join("·") || "—"}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1">
        {canRead && (
          <button
            onClick={onRead}
            disabled={busy !== null}
            className="chip text-[9px] tracking-widest text-primary-glow hover:bg-primary/15 inline-flex items-center gap-1 disabled:opacity-50"
          >
            {busy === "read"
              ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
              : <Download className="w-2.5 h-2.5" />}
            READ
          </button>
        )}
        {canWrite && (
          <button
            onClick={() => { setWriteOpen((o) => !o); setError(null); }}
            disabled={busy !== null}
            className="chip text-[9px] tracking-widest text-primary-glow hover:bg-primary/15 inline-flex items-center gap-1 disabled:opacity-50"
          >
            <Upload className="w-2.5 h-2.5" />
            WRITE{writeAcked ? "" : "-NR"}
          </button>
        )}
        {canNotify && (
          <button
            onClick={onToggleNotify}
            disabled={busy !== null && busy !== "subscribe"}
            className={cn(
              "chip text-[9px] tracking-widest inline-flex items-center gap-1 disabled:opacity-50",
              notifyOn ? "text-warning bg-warning/10" : "text-primary-glow hover:bg-primary/15",
            )}
          >
            {busy === "subscribe"
              ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
              : notifyOn
                ? <BellOff className="w-2.5 h-2.5" />
                : <Bell className="w-2.5 h-2.5" />}
            {notifyOn ? "STOP" : "NOTIFY"}
          </button>
        )}
      </div>

      {/* Read value */}
      {readValue && (
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="mono text-[10px] text-foreground truncate" title={formatBytes(readValue, "hex")}>
            ⇣ {formatBytes(readValue, hint)}
          </span>
          {readAt && (
            <span className="mono text-[9px] text-muted-foreground/70 shrink-0">
              {formatAge(readAt)}
            </span>
          )}
        </div>
      )}

      {/* Inline write composer */}
      {writeOpen && (
        <div className="mt-1.5 space-y-1">
          <Input
            value={writeText}
            onChange={(e) => setWriteText(e.target.value)}
            placeholder={writePlaceholder(hint)}
            className="mono text-[10px] h-7 px-2"
            autoFocus
          />
          <div className="flex items-center justify-between gap-2">
            <span className="mono text-[9px] text-muted-foreground">
              format: {hint}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => { setWriteOpen(false); setError(null); }}
                className="chip text-[9px] tracking-widest text-muted-foreground"
              >CANCEL</button>
              <button
                onClick={onWrite}
                disabled={busy === "write" || !writeText}
                className="chip text-[9px] tracking-widest text-primary-glow bg-primary/15 disabled:opacity-50 inline-flex items-center gap-1"
              >
                {busy === "write" && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
                SEND
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live notification stream */}
      {notifyOn && samples.length > 0 && (
        <div className="mt-1.5 rounded-sm bg-primary/5 border border-primary/20 px-1.5 py-1">
          <div className="mono text-[9px] text-primary-glow tracking-widest mb-0.5 inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-primary-glow animate-pulse" />
            LIVE · {samples.length}
          </div>
          <ul className="space-y-0.5">
            {samples.slice().reverse().map((s, i) => (
              <li key={`${s.at}-${i}`} className="flex items-center justify-between gap-2">
                <span className="mono text-[10px] text-foreground truncate">
                  {formatBytes(s.value, hint)}
                </span>
                <span className="mono text-[9px] text-muted-foreground/70 shrink-0">
                  {formatAge(s.at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="mt-1 mono text-[10px] text-destructive break-all">
          ! {error}
        </div>
      )}
    </div>
  );
}

function formatAge(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 1) return "now";
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

function writePlaceholder(hint: "utf8" | "uint8" | "uint16le" | "hex"): string {
  switch (hint) {
    case "utf8": return "hello";
    case "uint8": return "0..255";
    case "uint16le": return "0..65535";
    default: return "hex e.g. 01 a0 ff";
  }
}

/**
 * Parse free-text into bytes per the format hint. Returns null on invalid
 * input (e.g. a UTF-8 string is always valid; hex must be even-length).
 */
function parseWritePayload(text: string, hint: "utf8" | "uint8" | "uint16le" | "hex"): Uint8Array | null {
  const t = text.trim();
  if (!t) return null;
  switch (hint) {
    case "utf8":
      return new TextEncoder().encode(t);
    case "uint8": {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0 || n > 0xff) return null;
      return Uint8Array.from([n]);
    }
    case "uint16le": {
      const n = Number(t);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
      return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff]);
    }
    case "hex": {
      const hex = t.replace(/[^0-9a-f]/gi, "");
      if (!hex || hex.length % 2 !== 0) return null;
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }
  }
}
