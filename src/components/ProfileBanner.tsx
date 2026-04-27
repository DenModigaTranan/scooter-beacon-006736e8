import { Clock } from "lucide-react";
import { useProfile, getProfileMeta } from "@/lib/profile";

/**
 * Inline banner shown on connected screens when the active profile is one of
 * the not-yet-implemented protocols. Renders nothing for `xiaomi-m365`.
 */
export function ProfileBanner() {
  const [profile] = useProfile();
  if (!profile || profile === "xiaomi-m365") return null;
  const meta = getProfileMeta(profile);

  return (
    <div className="px-4 pt-4 max-w-md mx-auto">
      <div className="panel border-warning/40 bg-warning/5 p-3 flex items-start gap-2.5 animate-fade-in">
        <Clock className="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <div className="text-xs leading-relaxed">
          <span className="mono tracking-widest uppercase text-warning">{meta.shortLabel}</span>{" "}
          <span className="text-muted-foreground">
            protocol is not yet implemented. Showing read-only mock data — change profile in Settings.
          </span>
        </div>
      </div>
    </div>
  );
}
