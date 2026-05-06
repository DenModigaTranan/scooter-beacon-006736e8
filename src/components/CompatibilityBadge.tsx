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

import { CheckCircle2, AlertTriangle, HelpCircle } from "lucide-react";
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
  /** Service UUIDs from the advert, if known. Improves detection accuracy. */
  serviceUuids?: string[];
  /** Manufacturer (company) IDs from the advert, if known. */
  manufacturerIds?: number[];
  /** Compact = chip-only (for header). Full = chip + reason (for panels). */
  variant?: "compact" | "full";
  className?: string;
}

type Status = "match" | "mismatch" | "unknown" | "no-device";

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
  // Treat ninebot/ewheels/ewa as a single compatibility family — they all use
  // the same Ninebot BLE stack, so any of them is "compatible" with any other.
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

export function CompatibilityBadge({ profile, deviceName, serviceUuids, manufacturerIds, variant = "compact", className }: Props) {
  const { status, detectedProfile, reason } = evaluate(profile, deviceName, serviceUuids, manufacturerIds);

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

  if (variant === "compact") {
    return (
      <span
        title={reason}
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
      <div className="text-xs leading-relaxed">
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
      </div>
    </div>
  );
}
