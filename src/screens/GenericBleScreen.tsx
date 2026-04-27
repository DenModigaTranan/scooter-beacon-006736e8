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
  ChevronDown, ScrollText, Trash2, Copy, ClipboardCheck,
  Clock, Unplug, ShieldAlert, HelpCircle,
  type LucideIcon,
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
 * Per-attempt outcome tile shown in the connect progress strip. `pending` is
 * the initial blank state, `active` is the in-flight attempt, and the rest
 * are terminal. The strip is a fixed-length array of MAX_ATTEMPTS entries so
 * the UI can render N tiles up front and just recolor them in place.
 */
type AttemptOutcome = "pending" | "active" | "ok" | "failed" | "timeout";

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
  | "summary"
  | "info";

interface LogEntry {
  id: number;
  at: number;
  kind: LogKind;
  message: string;
}

/** Cap log size — old entries get evicted FIFO so memory stays bounded. */
const LOG_MAX_ENTRIES = 100;

/**
 * Visual metadata for each log kind. Lifted to module scope so the
 * connection-log panel and the failure-details drawer render identical
 * colors/labels for the same event types without duplicating the table.
 */
const LOG_KIND_META: Record<LogKind, { label: string; cls: string; dot: string }> = {
  "attempt-start": { label: "TRY",      cls: "text-primary-glow",      dot: "bg-primary-glow" },
  "attempt-ok":    { label: "OK",       cls: "text-primary-glow",      dot: "bg-primary-glow" },
  "timeout":       { label: "TIMEOUT",  cls: "text-warning",           dot: "bg-warning" },
  "attempt-fail":  { label: "FAIL",     cls: "text-destructive",       dot: "bg-destructive" },
  "backoff":       { label: "BACKOFF",  cls: "text-warning/80",        dot: "bg-warning/80" },
  "cancel":        { label: "CANCEL",   cls: "text-muted-foreground",  dot: "bg-muted-foreground" },
  "disconnect":    { label: "DISC",     cls: "text-muted-foreground",  dot: "bg-muted-foreground" },
  "info":          { label: "INFO",     cls: "text-muted-foreground",  dot: "bg-muted-foreground" },
  "summary":       { label: "SUMMARY",  cls: "text-foreground",        dot: "bg-foreground/70" },
};

/**
 * Visual + copywriting metadata for the failure-summary chip. Each category
 * picks its own icon, headline, and tone so the user can tell at a glance
 * whether the run died because the device never answered (timeout), the link
 * dropped mid-handshake (disconnect), the OS denied access (auth/permission),
 * the device couldn't be located (not-found), or something else entirely.
 */
type FailureCategory = "timeout" | "disconnect" | "auth" | "not-found" | "cancelled" | "generic";

interface FailureClassification {
  category: FailureCategory;
  icon: LucideIcon;
  label: string;
  tone: "warning" | "destructive" | "muted";
}

const FAILURE_TONE: Record<FailureClassification["tone"], {
  border: string; bg: string; iconBg: string; icon: string; header: string;
}> = {
  warning: {
    border: "border-warning/40",
    bg: "bg-warning/5",
    iconBg: "bg-warning/20",
    icon: "text-warning",
    header: "text-warning",
  },
  destructive: {
    border: "border-destructive/40",
    bg: "bg-destructive/5",
    iconBg: "bg-destructive/20",
    icon: "text-destructive",
    header: "text-destructive",
  },
  muted: {
    border: "border-border/60",
    bg: "bg-secondary/30",
    iconBg: "bg-secondary",
    icon: "text-muted-foreground",
    header: "text-muted-foreground",
  },
};

/**
 * Best-effort classification of a connect failure based on the log entry's
 * kind + cleaned reason text. Patterns intentionally lean permissive — both
 * iOS-style ("Authorization") and Android-style ("permission denied",
 * "GATT_INSUFFICIENT_AUTH") wordings are matched so the chip works across
 * platforms without us having to plumb structured error codes through every
 * layer.
 */
function classifyFailure(kind: LogKind, reason: string): FailureClassification {
  const r = reason.toLowerCase();
  if (kind === "timeout" || r.includes("timed out") || r.includes("timeout")) {
    return { category: "timeout", icon: Clock, label: "Timeout", tone: "warning" };
  }
  if (kind === "cancel" || r === "cancelled" || r.startsWith("cancelled")) {
    return { category: "cancelled", icon: X, label: "Cancelled", tone: "muted" };
  }
  if (
    r.includes("disconnected before gatt") ||
    (r.includes("gatt") && (r.includes("disconnect") || r.includes("dropped"))) ||
    r.includes("link lost") ||
    r.includes("peer disconnected")
  ) {
    return { category: "disconnect", icon: Unplug, label: "Link dropped", tone: "destructive" };
  }
  if (
    r.includes("auth") ||
    r.includes("permission") ||
    r.includes("denied") ||
    r.includes("unauthorized") ||
    r.includes("not authorized") ||
    r.includes("encryption") ||
    r.includes("bonding") ||
    r.includes("pair")
  ) {
    return { category: "auth", icon: ShieldAlert, label: "Auth required", tone: "destructive" };
  }
  if (
    r.includes("not found") ||
    r.includes("unreachable") ||
    r.includes("no such device") ||
    r.includes("device gone")
  ) {
    return { category: "not-found", icon: HelpCircle, label: "Device unreachable", tone: "warning" };
  }
  return { category: "generic", icon: AlertTriangle, label: "Last failure", tone: "destructive" };
}

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
  // Fixed-length progress strip rendered in the connect banner. Index i is the
  // outcome of attempt i+1. Reset to all-"pending" at the start of every new
  // connect sequence; mutated in place as attempts start/finish.
  const [attemptOutcomes, setAttemptOutcomes] = useState<AttemptOutcome[]>(
    () => Array.from({ length: MAX_ATTEMPTS }, () => "pending" as const),
  );
  const setAttemptOutcome = useCallback(
    (attempt: number, outcome: AttemptOutcome) => {
      setAttemptOutcomes((prev) => {
        const idx = attempt - 1;
        if (idx < 0 || idx >= prev.length || prev[idx] === outcome) return prev;
        const next = prev.slice();
        next[idx] = outcome;
        return next;
      });
    },
    [],
  );
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
    // Fresh progress strip — every attempt starts as "pending" so the banner
    // shows N empty tiles immediately on click instead of carrying over the
    // outcomes from the previous connect run.
    setAttemptOutcomes(Array.from({ length: MAX_ATTEMPTS }, () => "pending" as const));
    pushLog("info", `Connect requested → ${d.name || d.deviceId.slice(0, 17)}`);

    const ac = new AbortController();
    connectAbortRef.current = ac;
    const aborted = () => ac.signal.aborted;

    // Sequence-wide counters used to render a final "summary" log entry once
    // the orchestration terminates (success, exhaustion, or cancellation).
    const sequenceStartedAt = Date.now();
    let attemptsTried = 0;       // every attempt that actually started
    let attemptsSucceeded = 0;   // exactly 0 or 1 in current design
    let attemptsFailed = 0;      // timeouts + plugin errors + early disconnects
    let attemptsTimedOut = 0;    // subset of attemptsFailed
    // Wall-clock duration of every attempt that actually started (ok or not).
    // Used to surface min/max attempt time in the closing summary so bug
    // reports show how the configured PER_ATTEMPT_TIMEOUT_MS cap compares to
    // what actually happened in the field.
    const attemptDurationsMs: number[] = [];

    /**
     * Emit the closing summary entry. Called from every terminal branch
     * (success, failure-after-retries, cancellation) so the log always ends
     * with a one-line "what just happened overall" recap.
     */
    const emitSummary = (
      outcome: "success" | "failed" | "cancelled",
    ) => {
      const total = formatMs(Date.now() - sequenceStartedAt);
      const verb =
        outcome === "success"   ? "Connected"
        : outcome === "cancelled" ? "Cancelled"
        : "Failed";
      const cap = formatMs(PER_ATTEMPT_TIMEOUT_MS);
      const counts =
        `${attemptsSucceeded} ok · ${attemptsFailed} failed` +
        (attemptsTimedOut ? ` (${attemptsTimedOut} timeout${attemptsTimedOut === 1 ? "" : "s"})` : "");
      // Only show min/max once we have ≥1 finished attempt. With a single
      // attempt, "min == max" is noise so collapse to a single value.
      let timing = ` · cap ${cap}/attempt`;
      if (attemptDurationsMs.length === 1) {
        timing += ` · attempt ${formatMs(attemptDurationsMs[0])}`;
      } else if (attemptDurationsMs.length > 1) {
        const min = Math.min(...attemptDurationsMs);
        const max = Math.max(...attemptDurationsMs);
        timing += ` · attempts ${formatMs(min)}–${formatMs(max)}`;
      }
      pushLog(
        "summary",
        `${verb} after ${total} · ${attemptsTried}/${MAX_ATTEMPTS} attempt${attemptsTried === 1 ? "" : "s"} · ${counts}${timing}`,
      );
    };

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
          attemptsFailed++;
          attemptsTimedOut++;
          attemptDurationsMs.push(elapsed());
          setAttemptOutcome(attempt, "timeout");
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
        attemptsTried++;
        setAttemptOutcome(attempt, "active");
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
            const took = elapsed();
            attemptDurationsMs.push(took);
            // Mark the strip BEFORE finishing so the early-disconnect tile
            // turns red even though the late plugin rejection arrives after
            // we've already settled.
            setAttemptOutcome(attempt, "failed");
            finish(() => reject(new Error(`disconnected before GATT ready (after ${formatMs(took)})`)));
          }
        }).then(
          () => {
            const took = elapsed();
            clearTimeout(timeoutId);
            ac.signal.removeEventListener("abort", onAbort);
            // If we already settled (timeout / abort), the attempt has already
            // been counted and its duration recorded — don't double-count even
            // though the underlying plugin call eventually resolved.
            if (settled) return;
            attemptsSucceeded++;
            attemptDurationsMs.push(took);
            setAttemptOutcome(attempt, "ok");
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
            // Same guard as the success branch: timeout/abort paths already
            // recorded the duration before forcing the reject.
            if (!settled) {
              attemptDurationsMs.push(took);
              setAttemptOutcome(attempt, "failed");
            }
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
          // Avoid double-counting / double-logging timeouts: the timeout
          // path already incremented counters and logged from inside
          // attemptOnce. Anything else (plugin error, early disconnect) is
          // counted here as a generic failure.
          if (!lastError.message.startsWith("timed out")) {
            attemptsFailed++;
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
      // Final recap for the success branch — emitted after discovery so the
      // total time covers the full "user clicks → ready to use" experience.
      emitSummary("success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setConnectPhase({ kind: "idle" });
      if (msg === "cancelled") {
        // cancelConnect() already wrote the "Cancelled by user" entry; here
        // we add the wrap-up summary so the log still ends with totals.
        emitSummary("cancelled");
        return;
      }
      setConnError(msg);
      setConnState("error");
      pushLog("attempt-fail", `Connect sequence failed: ${msg}`);
      try { await genericBle.disconnect(); } catch { /* ignore */ }
      emitSummary("failed");
    } finally {
      if (connectAbortRef.current === ac) connectAbortRef.current = null;
      connectInFlightRef.current = false;
    }
  }, [connState, pushLog, setAttemptOutcome]);

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

  /**
   * Most recent failure recap, derived purely from the log so it stays in
   * sync with whatever's already been pushed.
   *
   * Strategy: walk the log newest-first and stop at the first terminal marker
   * for the current run. We only return a summary when the most recent run
   * actually ended badly (`failed` or `cancelled`). A successful run is
   * terminated by a `summary` of outcome "Connected", which suppresses the
   * chip — the connection banner already shows that state.
   */
  const lastFailure = useMemo(() => {
    if (log.length === 0) return null;
    let lastFail: LogEntry | null = null;
    let lastSummary: LogEntry | null = null;
    // Every attempt-fail/timeout entry from the current run, ordered
    // chronologically (oldest first) so the drawer reads top-down like a
    // post-mortem.
    const runFailures: LogEntry[] = [];
    for (const e of log) {
      // Newest-first iteration; stop as soon as we hit a sequence boundary
      // ("info" = "Connect requested" begins a new run).
      if (e.kind === "info" && e.message.startsWith("Connect requested")) break;
      if (!lastSummary && e.kind === "summary") lastSummary = e;
      if (!lastFail && (e.kind === "attempt-fail" || e.kind === "timeout")) lastFail = e;
      if (e.kind === "attempt-fail" || e.kind === "timeout") runFailures.unshift(e);
    }
    if (!lastFail) return null;
    // If the run ended in success, don't surface the prior failure — the
    // current state is "connected" and the chip would just be noise.
    if (lastSummary?.message.startsWith("Connected")) return null;

    // Parse "Attempt N …" out of the message to render a compact chip.
    const m = lastFail.message.match(/^Attempt\s+(\d+)\b/i);
    const attempt = m ? Number(m[1]) : null;
    // Strip the "Attempt N failed (took Xs):" / "Attempt N hit timeout (…)"
    // prefix so the reason reads cleanly on its own.
    const reason = lastFail.message
      .replace(/^Attempt\s+\d+\s+failed(?:\s+\([^)]*\))?:\s*/i, "")
      .replace(/^Attempt\s+\d+\s+hit timeout\s*\(?[^)]*\)?\s*/i, "timed out")
      .trim();
    const isTimeout = lastFail.kind === "timeout";
    const totalMs = lastSummary ? lastSummary.at - lastFail.at + 0 : null;
    void totalMs;
    // Prefer the sequence's own duration if a summary exists; otherwise
    // approximate "since failure" relative to now.
    const totalLabel = lastSummary
      ? lastSummary.message.match(/after\s+([0-9.]+(?:ms|s))/i)?.[1] ?? null
      : null;
    return { entry: lastFail, attempt, reason, isTimeout, totalLabel, ended: !!lastSummary, failures: runFailures };
  }, [log]);

  return (
    <div className="px-4 pt-4 pb-28 max-w-md mx-auto space-y-4 animate-fade-in">
      {/* Connection status banner */}
      <ConnStatusBanner
        connState={connState}
        device={connectedDevice}
        error={connError}
        phase={connectPhase}
        now={now}
        attemptOutcomes={attemptOutcomes}
        onDisconnect={disconnect}
        onCancel={cancelConnect}
        onRetry={() => connectedDevice && connect(connectedDevice)}
      />

      {/* One-line failure summary — only shown when the latest run ended badly */}
      <FailureSummaryChip data={lastFailure} now={now} />

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
/**
 * Compact one-liner shown above the log panel summarizing the most recent
 * failure: attempt number, reason, and (when the sequence has fully ended)
 * the total duration of that run. Auto-hides on success.
 */
function FailureSummaryChip({
  data, now,
}: {
  data: {
    entry: LogEntry;
    attempt: number | null;
    reason: string;
    isTimeout: boolean;
    totalLabel: string | null;
    ended: boolean;
    failures: LogEntry[];
  } | null;
  now: number;
}) {
  // Click-to-expand drawer state. Auto-collapses when the chip is hidden
  // (data === null) so a fresh successful run doesn't reopen with stale rows
  // the next time a failure surfaces.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!data) setOpen(false);
  }, [data]);

  if (!data) return null;
  const { entry, attempt, reason, totalLabel, ended, failures } = data;
  const ageSec = Math.max(0, Math.round((now - entry.at) / 1000));
  const ageLabel =
    ageSec < 1 ? "just now"
    : ageSec < 60 ? `${ageSec}s ago`
    : ageSec < 3600 ? `${Math.floor(ageSec / 60)}m ago`
    : `${Math.floor(ageSec / 3600)}h ago`;
  // Show the chevron whenever there is at least one failure entry — even a
  // single one is useful in the drawer because it carries the raw timestamp
  // and unstripped message for bug reports.
  const expandable = failures.length >= 1;

  // Pick icon + headline + tone from the latest failure's kind & cleaned
  // reason text. This is what makes a "timed out" run read differently from
  // an auth/permission denial or a peer disconnect mid-handshake.
  const cls = classifyFailure(entry.kind, reason);
  const tone = FAILURE_TONE[cls.tone];
  const Icon = cls.icon;

  return (
    <motion.section
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("panel border overflow-hidden", tone.border, tone.bg)}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={() => expandable && setOpen((o) => !o)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          "w-full p-2.5 flex items-start gap-2.5 text-left transition-colors",
          expandable && "hover:bg-foreground/[0.03] cursor-pointer",
          !expandable && "cursor-default",
        )}
      >
        <div className={cn(
          "w-7 h-7 rounded-md flex items-center justify-center shrink-0",
          tone.iconBg,
        )}>
          <Icon className={cn("w-3.5 h-3.5", tone.icon)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className={cn(
            "mono text-[10px] tracking-[0.22em] uppercase flex items-center gap-2 flex-wrap",
            tone.header,
          )}>
            <span>{cls.label}</span>
            {attempt !== null && (
              <span className="text-muted-foreground/80 normal-case tracking-normal">
                attempt {attempt}/{MAX_ATTEMPTS}
              </span>
            )}
            {totalLabel && (
              <span className="text-muted-foreground/80 normal-case tracking-normal">
                · total {totalLabel}
              </span>
            )}
            {!ended && (
              <span className="text-muted-foreground/80 normal-case tracking-normal">
                · in progress
              </span>
            )}
            {expandable && (
              <span className="text-muted-foreground/80 normal-case tracking-normal">
                · {failures.length} {failures.length === 1 ? "entry" : "entries"}
              </span>
            )}
            <span className="text-muted-foreground/60 normal-case tracking-normal">· {ageLabel}</span>
          </div>
          <div className="mono text-[11px] text-foreground/90 leading-snug break-words">
            {reason}
          </div>
        </div>
        {expandable && (
          <ChevronDown
            className={cn(
              "w-4 h-4 mt-1 shrink-0 transition-transform",
              tone.icon,
              open && "rotate-180",
            )}
            aria-hidden
          />
        )}
      </button>

      <AnimatePresence initial={false}>
        {open && expandable && (
          <motion.div
            key="failure-drawer"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className={cn("border-t", tone.border)}
          >
            <div className={cn(
              "px-3 py-1.5 mono text-[9px] tracking-widest uppercase",
              tone.header,
              tone.bg,
            )}>
              Failure details · current run
            </div>
            <ul className="divide-y divide-border/30">
              {failures.map((f) => {
                const m = LOG_KIND_META[f.kind];
                return (
                  <li key={f.id} className="px-3 py-1.5 flex items-start gap-2">
                    <span
                      className={cn("w-1.5 h-1.5 rounded-full mt-1.5 shrink-0", m.dot)}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="mono text-[10px] text-muted-foreground/80 flex items-center gap-1.5">
                        <span>{formatLogTime(f.at)}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span className={m.cls}>{m.label}</span>
                        <span className="text-muted-foreground/50">·</span>
                        <span>{formatRelative(f.at, now)}</span>
                      </div>
                      <div className="mono text-[11px] text-foreground/90 break-words leading-snug">
                        {f.message}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

/**
 * Short, actionable hint shown directly under the failure reason. Kept to
 * one line of plain English so it reads as guidance, not a full diagnostic.
 * `ended` lets us swap "the orchestrator is still retrying for you" copy
 * (in-progress) for "you'll need to do something" copy (run finished).
 */
function nextStepFor(
  category: FailureCategory,
  ended: boolean,
): { icon: LucideIcon; text: string } {
  switch (category) {
    case "timeout":
      return ended
        ? { icon: Signal, text: "Move closer to the device and tap Retry — it never answered in time." }
        : { icon: Clock,  text: "Waiting on the device to respond — auto-retrying with backoff." };
    case "disconnect":
      return ended
        ? { icon: Unplug, text: "Link dropped during handshake. Power-cycle the device, then tap Retry." }
        : { icon: Unplug, text: "Link dropped mid-handshake — auto-retrying. Keep the device awake." };
    case "auth":
      // Auth failures almost never resolve on their own — surface the
      // re-pair instruction even while the orchestrator is still retrying.
      return { icon: ShieldAlert, text: "Forget the device in Bluetooth settings, then re-pair and try again." };
    case "not-found":
      return ended
        ? { icon: Signal, text: "Device is out of range or off. Wake it, move closer, then tap Retry." }
        : { icon: Signal, text: "Can't see the device — check it's powered on and within a few meters." };
    case "cancelled":
      return { icon: RefreshCw, text: "Cancelled by you. Tap the device again to start a new connect." };
    case "generic":
    default:
      return ended
        ? { icon: RefreshCw, text: "Tap Retry. If it keeps failing, copy the log and share it for triage." }
        : { icon: RefreshCw, text: "Auto-retrying. If this keeps happening, copy the log for a bug report." };
  }
}


function ConnectionLogPanel({
  entries, onClear, now,
}: {
  entries: LogEntry[];
  onClear: () => void;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  // Transient state for the Copy button: "idle" → "copied"/"error" → "idle"
  // after ~1.5s. Drives both the icon swap and the colored confirmation.
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest entry in header — `entries` is already newest-first.
  const latest = entries[0];

  /**
   * Auto-expand the panel whenever a new noteworthy event arrives (a failed
   * attempt, a hit timeout, or a user/peer cancellation). We track the id of
   * the last entry that triggered an auto-open so we only fire once per such
   * event — the user can still close the panel manually and we won't keep
   * popping it back open until another fresh failure shows up.
   */
  const NOTEWORTHY: ReadonlySet<LogKind> = useMemo(
    () => new Set<LogKind>(["attempt-fail", "timeout", "cancel", "summary"]),
    [],
  );
  const lastAutoOpenIdRef = useRef<number>(0);
  useEffect(() => {
    if (!latest) return;
    if (latest.id === lastAutoOpenIdRef.current) return;
    if (!NOTEWORTHY.has(latest.kind)) return;
    lastAutoOpenIdRef.current = latest.id;
    setOpen(true);
  }, [latest, NOTEWORTHY]);

  /**
   * Build a plain-text dump suitable for pasting into a bug report. Lines
   * are oldest → newest (chronological reading order), each prefixed with an
   * ISO-ish timestamp + the event kind in brackets so it's grep-friendly.
   */
  const buildClipboardText = useCallback((): string => {
    const lines: string[] = [
      `# ScootFlash — Generic BLE connection log`,
      `# generated at ${new Date().toISOString()} · ${entries.length} ${entries.length === 1 ? "event" : "events"}`,
      "",
    ];
    // entries are newest-first in state; reverse for human reading.
    for (const e of [...entries].reverse()) {
      const ts = new Date(e.at).toISOString();
      lines.push(`${ts}  [${e.kind}]  ${e.message}`);
    }
    return lines.join("\n");
  }, [entries]);

  const handleCopy = useCallback(async () => {
    if (entries.length === 0) return;
    const text = buildClipboardText();
    let ok = false;
    // Modern path — only available on secure contexts.
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    // Legacy fallback — works in non-secure contexts and inside some webviews
    // where the async Clipboard API is gated. Uses a hidden, off-screen
    // textarea + document.execCommand("copy").
    if (!ok && typeof document !== "undefined") {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    setCopyState(ok ? "copied" : "error");
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyState("idle"), 1500);
  }, [entries.length, buildClipboardText]);

  // Reset the transient confirmation if the panel unmounts mid-flash so a
  // stale "Copied" badge doesn't survive a remount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const meta = LOG_KIND_META;

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
            <div className="flex items-center justify-between px-3 py-1.5 bg-secondary/20 gap-2">
              <span className="mono text-[9px] tracking-widest uppercase text-muted-foreground/80">
                Newest first · max {LOG_MAX_ENTRIES}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCopy}
                  disabled={entries.length === 0}
                  aria-live="polite"
                  className={cn(
                    "mono text-[9px] tracking-widest uppercase inline-flex items-center gap-1 transition-colors",
                    "disabled:opacity-30 disabled:cursor-not-allowed",
                    copyState === "copied"
                      ? "text-primary-glow"
                      : copyState === "error"
                        ? "text-destructive"
                        : "text-muted-foreground hover:text-foreground",
                  )}
                  title="Copy the full log to your clipboard"
                >
                  {copyState === "copied" ? (
                    <><ClipboardCheck className="w-3 h-3" /> Copied</>
                  ) : copyState === "error" ? (
                    <><Copy className="w-3 h-3" /> Copy failed</>
                  ) : (
                    <><Copy className="w-3 h-3" /> Copy log</>
                  )}
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  disabled={entries.length === 0}
                  className="mono text-[9px] tracking-widest uppercase text-muted-foreground hover:text-destructive disabled:opacity-30 disabled:cursor-not-allowed inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" /> Clear
                </button>
              </div>
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

/**
 * Compact ms → "Xms" / "X.Ys" formatter for log entries. Sub-second values
 * stay in ms for precision on fast handshakes; anything ≥1s collapses to one
 * decimal so "Attempt 2 took 7.6s" reads naturally.
 */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}


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

/**
 * Compact "attempt X of N" progress strip rendered inside the connecting
 * banner. Each tile maps 1:1 to a configured attempt slot and recolors as
 * the orchestrator transitions that attempt through active → ok / failed /
 * timeout. Designed to be glanceable: no labels per tile, just color + a
 * subtle pulse on the in-flight one. The summary text above already carries
 * the precise "attempt N/MAX" wording for assistive tech, so this strip is
 * purely visual reinforcement (aria-hidden).
 */
function AttemptProgressStrip({
  outcomes,
  currentAttempt,
}: {
  outcomes: AttemptOutcome[];
  currentAttempt: number;
}) {
  if (!outcomes.length) return null;
  return (
    <div
      className="mt-2 flex items-center gap-1"
      aria-hidden="true"
    >
      {outcomes.map((o, i) => {
        const attemptNum = i + 1;
        const isCurrent = attemptNum === currentAttempt;
        // Map outcome → tile color. Pending tiles are intentionally low
        // contrast so the eye is drawn to the active/finished ones.
        const cls =
          o === "ok"      ? "bg-primary-glow"
          : o === "failed"  ? "bg-destructive/80"
          : o === "timeout" ? "bg-warning"
          : o === "active"  ? "bg-primary-glow/70 animate-pulse"
          : isCurrent       ? "bg-secondary-foreground/30"
          :                   "bg-secondary";
        return (
          <div
            key={attemptNum}
            className={cn("h-1.5 flex-1 rounded-full transition-colors", cls)}
            title={`Attempt ${attemptNum}: ${o}`}
          />
        );
      })}
    </div>
  );
}

function ConnStatusBanner({
  connState, device, error, phase, now, attemptOutcomes, onDisconnect, onCancel, onRetry,
}: {
  connState: ConnState;
  device: GenericDevice | null;
  error: string | null;
  phase: ConnectPhase;
  now: number;
  attemptOutcomes: AttemptOutcome[];
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
        {/* Per-attempt progress strip: one tile per configured attempt slot.
            Pending tiles read as muted, the active tile pulses, and finished
            tiles lock in green/red so the user can see at a glance which
            attempts already happened and how each ended. */}
        <AttemptProgressStrip outcomes={attemptOutcomes} currentAttempt={attempt} />
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
