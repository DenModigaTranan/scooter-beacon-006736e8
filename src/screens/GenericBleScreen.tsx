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

  const scanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      genericBle.stopScan().catch(() => {});
      genericBle.disconnect().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- connecting --------------------------------------------------------
  const connect = useCallback(async (d: GenericDevice) => {
    if (connState === "connecting") return;
    // If already connected to a different device, hang up first so the new
    // connect attempt starts from a clean state.
    if (connState === "connected") {
      try { await genericBle.disconnect(); } catch { /* ignore */ }
    }
    await genericBle.stopScan().catch(() => {});
    setScanState("stopped");
    setConnectedDevice(d);
    setConnState("connecting");
    setConnError(null);
    setServices([]);
    try {
      await genericBle.connect(d.deviceId, () => {
        setConnState("disconnected");
        setConnectedDevice(null);
        setServices([]);
      });
      setConnState("connected");
      setDiscovering(true);
      try {
        const svcs = await genericBle.discoverServices();
        setServices(svcs);
      } finally {
        setDiscovering(false);
      }
    } catch (e) {
      setConnError(e instanceof Error ? e.message : String(e));
      setConnState("error");
    }
  }, [connState]);

  const disconnect = useCallback(async () => {
    await genericBle.disconnect();
    setConnState("disconnected");
    setConnectedDevice(null);
    setServices([]);
  }, []);

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
        onDisconnect={disconnect}
        onRetry={() => connectedDevice && connect(connectedDevice)}
      />

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
  connState, device, error, onDisconnect, onRetry,
}: {
  connState: ConnState;
  device: GenericDevice | null;
  error: string | null;
  onDisconnect: () => void;
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
    return (
      <div className="panel-glow p-3 flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-md bg-primary/20 flex items-center justify-center">
          <Loader2 className="w-4 h-4 text-primary-glow animate-spin" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="mono text-[10px] tracking-[0.22em] uppercase text-primary-glow">
            Connecting…
          </div>
          <div className="mono text-xs truncate">{device?.name}</div>
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
            size="sm"
            className={cn(
              "mono text-[10px] tracking-widest",
              "bg-gradient-mint text-primary-foreground shadow-mint hover:opacity-90",
            )}
          >
            {isConnecting ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> CONNECTING</>
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
