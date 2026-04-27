import { Cpu } from "lucide-react";
import { PROFILES, useProfile, type ScooterProfile } from "@/lib/profile";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export function ProfilePicker() {
  const [profile, setProfile] = useProfile();
  const active = profile ?? "xiaomi-m365";
  const meta = PROFILES.find((p) => p.key === active)!;

  const onChange = (next: string) => {
    const nextProfile = next as ScooterProfile;
    setProfile(nextProfile);
    const nextMeta = PROFILES.find((p) => p.key === nextProfile)!;
    toast.success(`Profile: ${nextMeta.label}`);
  };

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2 mb-3">
        <Cpu className="w-4 h-4 text-primary-glow" />
        <div className="mono text-[11px] tracking-[0.2em] uppercase">Profile</div>
      </div>

      <Select value={active} onValueChange={onChange}>
        <SelectTrigger className="mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PROFILES.map((p) => (
            <SelectItem key={p.key} value={p.key} className="mono">
              <div className="flex items-center gap-2">
                <span>{p.label}</span>
                {p.status === "coming-soon" && (
                  <span className="chip text-[9px] tracking-[0.18em] text-warning">SOON</span>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">{meta.description}</p>
    </div>
  );
}
