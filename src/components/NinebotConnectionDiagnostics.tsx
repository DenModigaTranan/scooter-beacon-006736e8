/**
 * NinebotConnectionDiagnostics — compact troubleshooter for the Ninebot
 * route. Mirrors the GenericBleScreen orchestrator's retry/backoff/error
 * state so the user can see *why* a connection is stalling without having
 * to scroll down to the embedded GenericBleScreen banner.
 *
 * Pure presentation: every field comes from the `GenericBleDiagnostics`
 * snapshot that GenericBleScreen emits via its `onDiagnostics` prop.
 */

import { useEffect, useState } from "react";
import {
  AlertTriangle, Clock, Loader2, RefreshCw, ShieldAlert, Unplug, X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { GenericBleDiagnostics } from "@/screens/GenericBleScreen";

interface Props {
  diag: GenericBleDiagnostics | null;
}

/**
 * Tone metadata for the various failure kinds. Mirrors GenericBleScreen's
 * own classifier vocabulary so a user comparing both views sees the same
 * label and color for the same root cause.
 */
type Tone = "warning" | "destructive" | "muted" | "info";
const TONE: Record<Tone, { border: string; bg: string; text: string; chip: string }> = {
  warning: {
    border: "border-warning/40", bg: "bg-warning/5",
    text: "text-warning", chip: "border-warning/40 text-warning",
  },
  destructive: {
    border: "border-destructive/40", bg: "bg-destructive/5",
    text: "text-destructive", chip: "border-destructive/40 text-destructive",
  },
  muted: {
    border: "border-border/60", bg: "bg-secondary/30",
    text: "text-muted-foreground", chip: "border-border text-muted-foreground",
  },
  info: {
    border: "border-primary-glow/30", bg: "bg-primary-glow/5",
    text: "text-primary-glow", chip: "border-primary-glow/40 text-primary-glow",
  },
};

function classify(reason: string, isTimeout: boolean):
  { icon: LucideIcon; label: string; tone: Tone } {
  const r = reason.toLowerCase();
  if (isTimeout || r.includes("timed out") || r.includes("timeout")) {
    return { icon: Clock, label: "Timeout", tone: "warning" };
  }
  if (r === "cancelled" || r.startsWith("cancelled")) {
    return { icon: X, label: "Cancelled", tone: "muted" };
  }
  if (
    r.includes("disconnected before gatt") ||
    (r.includes("gatt") && (r.includes("disconnect") || r.includes("dropped"))) ||
    r.includes("link lost") ||
    r.includes("peer disconnected")
  ) {
    return { icon: Unplug, label: "Link dropped", tone: "destructive" };
  }
  if (
    r.includes("auth") || r.includes("permission") || r.includes("denied") ||
    r.includes("encryption") || r.includes("bonding") || r.includes("pair")
  ) {
    return { icon: ShieldAlert, label: "Auth required", tone: "destructive" };
  }
  return { icon: AlertTriangle, label: "Error", tone: "destructive" };
}

function fmtAgo(now: number, at: number): string {
  const ms = Math.max(0, now - at);
  if (ms < 1000) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s ago`;
}

export function NinebotConnectionDiagnostics({ diag }: Props) {
  // Rolling clock so "Xs ago" / "retry in Ys" stays accurate even when the
  // upstream snapshot doesn't change (the orchestrator only re-emits on
  // state transitions, not on every wall-clock tick).
  const [now, setNow] = useState(() => Date.now());
  const isActive =
    !!diag && (diag.connState === "connecting" || diag.phase.kind !== "idle");
  useEffect(() => {
    if (!diag) return;
    const fast = isActive;
    if (!fast && !diag.lastFailure) return;
    const id = setInterval(() => setNow(Date.now()), fast ? 250 : 1000);
    return () => clearInterval(id);
  }, [diag, isActive]);

  // Nothing useful to show: no run has been attempted yet, no failure on
  // record. We hide the panel entirely so it doesn't add visual noise.
  if (!diag) return null;
  const showActive = diag.connState === "connecting" || diag.phase.kind !== "idle";
  const showFailure = !!diag.lastFailure;
  const showError =
    !!diag.connError && diag.connError !== "cancelled by user" && !showActive;
  if (!showActive && !showFailure && !showError) return null;

  const cls = classify(diag.lastFailure?.reason ?? diag.connError ?? "", !!diag.lastFailure?.isTimeout);
  const tone = showActive ? TONE.info : TONE[cls.tone];

  // Phase label + countdown for the live banner. The exact deadlines come
  // straight from the orchestrator so the numbers match what the embedded
  // GenericBleScreen banner shows below.
  let phaseLabel = "Idle";
  let countdownSec: number | null = null;
  if (diag.phase.kind === "connecting") {
    phaseLabel = `Attempt ${diag.phase.attempt}/${diag.attemptOutcomes.length}`;
    countdownSec = Math.max(0, Math.ceil((diag.phase.deadlineAt - now) / 1000));
  } else if (diag.phase.kind === "backoff") {
    phaseLabel = `Backing off → attempt ${diag.phase.nextAttempt}/${diag.attemptOutcomes.length}`;
    countdownSec = Math.max(0, Math.ceil((diag.phase.resumeAt - now) / 1000));
  } else if (diag.connState === "connecting") {
    phaseLabel = "Connecting";
  }

  return (
    <section
      aria-label="Ninebot connection diagnostics"
      className={cn(
        "panel p-3 space-y-2 border", tone.border, tone.bg,
      )}
    >
      <div className="flex items-center justify-between">
        <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
          Connection diagnostics
        </div>
        {/* Per-attempt outcome strip — same vocabulary as the embedded
            banner. Lets the user spot "all 3 attempts timed out" at a
            glance without scrolling. */}
        <div className="flex items-center gap-1" aria-label="Attempt outcomes">
          {diag.attemptOutcomes.map((o, i) => (
            <span
              key={i}
              title={`Attempt ${i + 1}: ${o}`}
              className={cn(
                "inline-block w-2 h-2 rounded-sm",
                o === "ok" && "bg-primary-glow",
                o === "failed" && "bg-destructive",
                o === "timeout" && "bg-warning",
                o === "active" && "bg-primary-glow animate-pulse",
                o === "pending" && "bg-muted",
              )}
            />
          ))}
        </div>
      </div>

      {showActive && (
        <div className={cn("flex items-center gap-2 mono text-[11px]", tone.text)}>
          <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden />
          <span className="truncate">{phaseLabel}</span>
          {countdownSec != null && (
            <span className="ml-auto text-muted-foreground">
              {diag.phase.kind === "backoff" ? "retry in " : "deadline in "}
              {countdownSec}s
            </span>
          )}
        </div>
      )}

      {showActive && diag.phase.kind === "backoff" && (
        <div className="text-[10px] text-muted-foreground leading-relaxed">
          Last attempt failed: <span className={cn("mono", tone.text)}>{diag.phase.lastError}</span>
        </div>
      )}

      {showFailure && diag.lastFailure && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "chip text-[9px] tracking-widest border inline-flex items-center gap-1",
                tone.chip,
              )}
            >
              <cls.icon className="w-3 h-3" aria-hidden />
              {cls.label}
            </span>
            {diag.lastFailure.attempt != null && (
              <span className="mono text-[10px] text-muted-foreground">
                attempt {diag.lastFailure.attempt}
              </span>
            )}
            <span className="mono text-[10px] text-muted-foreground ml-auto">
              {fmtAgo(now, diag.lastFailure.at)}
              {diag.lastFailure.totalLabel && ` · ${diag.lastFailure.totalLabel}`}
            </span>
          </div>
          <div
            className={cn("mono text-[11px] leading-relaxed break-words", tone.text)}
            title={diag.lastFailure.reason}
          >
            {diag.lastFailure.reason || "(no detail provided)"}
          </div>
        </div>
      )}

      {showError && !showFailure && (
        <div className={cn("flex items-start gap-2 mono text-[11px]", tone.text)}>
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden />
          <span className="break-words">{diag.connError}</span>
        </div>
      )}

      {/* Hint row — pointer to the deeper view so the user knows where the
          full timeline lives without us duplicating the whole log here. */}
      <div className="flex items-center gap-1.5 text-[9px] tracking-widest uppercase text-muted-foreground/70 pt-1 border-t border-border/40">
        <RefreshCw className="w-2.5 h-2.5" aria-hidden />
        Full retry log + manual retry available in the scan panel below.
      </div>
    </section>
  );
}
