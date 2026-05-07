/**
 * Compatibility badge — shows whether the active profile matches the
 * BLE-name fingerprint of the currently connected device.
 *
 * States:
 *   - "match"      → detection agrees with active profile (or detection is for
 *                    a sibling protocol, e.g. e-wheels under ninebot)
 *   - "mismatch"   → detection points to a different profile
 *   - "unknown"    → no detection rule fired (we can't tell from the name)
 *   - "no-device"  → nothing connected
 *
 * Pure presentation — callers pass in the active profile + device name.
 */

import { CheckCircle2, AlertTriangle, HelpCircle, Radio, Cable } from "lucide-react";
import { detectProfile, detectChipLabel } from "@/lib/profile-detect";
import {
  isNinebotCompatible,
  getProfileMeta,
  type ScooterProfile,
} from "@/lib/profile";
import { cn } from "@/lib/utils";

interface Props {
  profile: ScooterProfile | null;
  deviceName: string | null | undefined;
  /** Service UUIDs from the advert (and/or GATT). Improves detection accuracy. */
  serviceUuids?: string[];
  /** Subset of serviceUuids learned via post-connect GATT discovery. */
  gattServiceUuids?: string[];
  /** Manufacturer (company) IDs from the advert, if known. */
  manufacturerIds?: number[];
  /** Compact = chip-only (for header). Full = chip + reason (for panels). */
  variant?: "compact" | "full";
  className?: string;
}

type Status = "match" | "mismatch" | "unknown" | "no-device";
type Source = "ads" | "gatt" | "both" | "name" | "none";

function classifySource(
  deviceName: string | null | undefined,
  serviceUuids: string[] | undefined,
  gattServiceUuids: string[] | undefined,
  manufacturerIds: number[] | undefined,
): Source {
  const all = (serviceUuids ?? []).map((u) => u.toLowerCase());
  const gatt = new Set((gattServiceUuids ?? []).map((u) => u.toLowerCase()));
  const advUuids = all.filter((u) => !gatt.has(u));
  const hasMfg = (manufacturerIds?.length ?? 0) > 0;

  const detAdv = detectProfile({ name: deviceName, serviceUuids: advUuids, manufacturerIds });
  const detGatt = gatt.size
    ? detectProfile({ name: undefined, serviceUuids: Array.from(gatt) })
    : null;

  // Did GATT contribute service-UUID points (beyond name/adv signals)?
  const detAdvNoUuid = detectProfile({ name: deviceName, manufacturerIds });
  const detFull = detectProfile({ name: deviceName, serviceUuids: all, manufacturerIds });

  const gattHelped = !!(detGatt && detFull && (!detAdvNoUuid || detFull.score > detAdvNoUuid.score) && (advUuids.length === 0 || (detAdv?.score ?? 0) < detFull.score));
  const adsHelped = !!(detAdv && (advUuids.length > 0 || hasMfg));
  const nameOnly = !!detAdvNoUuid && !adsHelped && !gattHelped;

  if (gattHelped && adsHelped) return "both";
  if (gattHelped) return "gatt";
  if (adsHelped) return "ads";
  if (nameOnly) return "name";
  return "none";
}

function evaluate(
  profile: ScooterProfile | null,
  deviceName: string | null | undefined,
  serviceUuids: string[] | undefined,
  manufacturerIds: number[] | undefined,
): { status: Status; detectedProfile: ScooterProfile | null; reason: string } {
  if (!deviceName) {
    return { status: "no-device", detectedProfile: null, reason: "No device connected" };
  }
  if (!profile) {
    return { status: "unknown", detectedProfile: null, reason: "No active profile" };
  }
  const det = detectProfile({ name: deviceName, serviceUuids, manufacturerIds });
  if (!det) {
    return {
      status: "unknown",
      detectedProfile: null,
      reason: `"${deviceName}" doesn't match any known brand pattern`,
    };
  }
  const sameFamily =
    det.profile === profile ||
    (isNinebotCompatible(det.profile) && isNinebotCompatible(profile));
  if (sameFamily) {
    return {
      status: "match",
      detectedProfile: det.profile,
      reason: det.reasons[0] ?? "advertisement matched",
    };
  }
  return {
    status: "mismatch",
    detectedProfile: det.profile,
    reason: det.reasons[0] ?? "advertisement matched",
  };
}

const SOURCE_LABEL: Record<Source, string> = {
  ads: "Scan advertisement",
  gatt: "GATT services",
  both: "Scan ads + GATT",
  name: "Device name only",
  none: "No signals",
};

const SOURCE_DETAIL: Record<Source, string> = {
  ads: "Matched using service UUIDs / manufacturer IDs from the BLE advertisement.",
  gatt: "Advert had no useful identifiers — matched after connecting via GATT service discovery.",
  both: "Confirmed by both the BLE advertisement and post-connect GATT services.",
  name: "Matched on the device's local name only — no service UUIDs or manufacturer IDs available.",
  none: "No identifying signals were found.",
};

export function CompatibilityBadge({ profile, deviceName, serviceUuids, gattServiceUuids, manufacturerIds, variant = "compact", className }: Props) {
  const { status, detectedProfile, reason } = evaluate(profile, deviceName, serviceUuids, manufacturerIds);
  const source = classifySource(deviceName, serviceUuids, gattServiceUuids, manufacturerIds);

  if (status === "no-device" && variant === "compact") return null;

  const config = {
    match: {
      icon: CheckCircle2,
      label: "COMPATIBLE",
      tone: "text-success border-success/40 bg-success/10",
    },
    mismatch: {
      icon: AlertTriangle,
      label: "MISMATCH",
      tone: "text-warning border-warning/40 bg-warning/10",
    },
    unknown: {
      icon: HelpCircle,
      label: "UNKNOWN",
      tone: "text-muted-foreground border-border bg-muted/20",
    },
    "no-device": {
      icon: HelpCircle,
      label: "—",
      tone: "text-muted-foreground border-border bg-muted/20",
    },
  }[status];

  const Icon = config.icon;
  const SourceIcon = source === "gatt" ? Cable : Radio;
  const showSource = status === "match" || status === "mismatch";

  if (variant === "compact") {
    const title = showSource ? `${reason} · via ${SOURCE_LABEL[source]}` : reason;
    return (
      <span
        title={title}
        className={cn(
          "chip mono text-[9px] tracking-[0.18em] inline-flex items-center gap-1 border",
          config.tone,
          className,
        )}
      >
        <Icon className="w-2.5 h-2.5" />
        {config.label}
      </span>
    );
  }

  return (
    <div className={cn("panel p-3 flex items-start gap-2.5", config.tone, className)}>
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <div className="text-xs leading-relaxed flex-1 min-w-0">
        <div className="mono tracking-widest uppercase">
          Profile {config.label.toLowerCase()}
        </div>
        <div className="text-muted-foreground mt-1">
          {status === "match" && profile && (
            <>
              "{deviceName}" looks like a {detectedProfile ? detectChipLabel({ profile: detectedProfile, confidence: "high", reasons: [], score: 0 }) : "?"} device — matches active profile <span className="text-foreground">{getProfileMeta(profile).shortLabel}</span>.
            </>
          )}
          {status === "mismatch" && profile && detectedProfile && (
            <>
              "{deviceName}" looks like a {detectChipLabel({ profile: detectedProfile, confidence: "high", reasons: [], score: 0 })} device, but your active profile is <span className="text-foreground">{getProfileMeta(profile).shortLabel}</span>. Flashing or live controls may fail.
            </>
          )}
          {status === "unknown" && <>{reason}. Proceed with caution.</>}
          {status === "no-device" && <>Connect a scooter to check compatibility.</>}
        </div>
        {showSource && (
          <div className="mt-2 flex items-start gap-1.5 pt-2 border-t border-current/10">
            <SourceIcon className="w-3 h-3 shrink-0 mt-0.5 opacity-70" />
            <div className="min-w-0">
              <div className="mono text-[9px] tracking-[0.18em] uppercase opacity-80">
                Source: {SOURCE_LABEL[source]}
              </div>
              <div className="text-muted-foreground text-[11px] mt-0.5">
                {SOURCE_DETAIL[source]}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
