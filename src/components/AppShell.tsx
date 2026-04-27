import { Bluetooth, Database, Gauge, Info, Settings as SettingsIcon, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export type TabKey = "dashboard" | "info" | "catalog" | "flash" | "settings";

const tabs: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "dashboard", label: "Dash", icon: Gauge },
  { key: "info", label: "Info", icon: Info },
  { key: "catalog", label: "Releases", icon: Database },
  { key: "flash", label: "Flash", icon: Zap },
  { key: "settings", label: "Setup", icon: SettingsIcon },
];

export function TabBar({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-30 border-t border-border/60 bg-background/85 backdrop-blur-xl"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.5rem)" }}
    >
      <ul className="grid grid-cols-4 max-w-md mx-auto px-2 pt-2">
        {tabs.map(({ key, label, icon: Icon }) => {
          const isActive = key === active;
          return (
            <li key={key}>
              <button
                onClick={() => onChange(key)}
                className={cn(
                  "w-full flex flex-col items-center gap-1 py-2 rounded-md transition-all",
                  isActive ? "text-primary-glow" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <div className={cn(
                  "relative flex items-center justify-center w-10 h-7 rounded-md transition-all",
                  isActive && "bg-primary/15 shadow-glow"
                )}>
                  <Icon className="w-5 h-5" />
                </div>
                <span className="mono text-[9px] tracking-[0.18em] uppercase">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function HeaderBar({
  title,
  right,
  profileLabel,
}: {
  title: string;
  right?: React.ReactNode;
  profileLabel?: string;
}) {
  return (
    <header className="sticky top-0 z-20 backdrop-blur-xl bg-background/70 border-b border-border/40">
      <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Bluetooth className="w-4 h-4 text-primary-glow shrink-0" />
          <h1 className="mono text-sm tracking-[0.2em] uppercase text-foreground truncate">{title}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {profileLabel && (
            <span className="chip text-[9px] tracking-[0.18em] uppercase text-primary-glow">
              {profileLabel}
            </span>
          )}
          {right}
        </div>
      </div>
    </header>
  );
}
