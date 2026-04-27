import { Check, Loader2, X, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

export type PhaseId = "download" | "arm" | "write" | "verify" | "done";
export type PhaseState = "pending" | "active" | "ok" | "fail" | "skipped";

export interface Phase {
  id: PhaseId;
  label: string;
  /** Optional right-side detail (e.g. "12.3 / 48.0 KB", "chunk 142/256"). */
  detail?: string;
  state: PhaseState;
}

/**
 * Vertical step list mirroring scooter.flash() phases. Each row shows
 * a status icon, label, and optional detail. The active row is animated.
 */
export function FlashStepList({ phases }: { phases: Phase[] }) {
  return (
    <ol className="space-y-1.5">
      {phases.map((p, i) => (
        <li
          key={p.id}
          className={cn(
            "flex items-center gap-3 rounded-md border px-3 py-2 transition-colors",
            p.state === "active" && "border-primary/60 bg-primary/5",
            p.state === "ok" && "border-primary/30",
            p.state === "fail" && "border-destructive/50 bg-destructive/5",
            (p.state === "pending" || p.state === "skipped") && "border-border/50 opacity-60",
          )}
        >
          <PhaseIcon state={p.state} />
          <div className="flex-1 min-w-0">
            <div className="mono text-xs tracking-widest uppercase">
              <span className="text-muted-foreground mr-2">{i + 1}.</span>
              <span
                className={cn(
                  p.state === "fail" && "text-destructive",
                  p.state === "ok" && "text-primary-glow",
                  p.state === "active" && "text-foreground",
                )}
              >
                {p.label}
              </span>
            </div>
            {p.detail && (
              <div className="mono text-[10px] text-muted-foreground mt-0.5 truncate">{p.detail}</div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === "active") return <Loader2 className="w-4 h-4 text-primary-glow animate-spin shrink-0" />;
  if (state === "ok") return <Check className="w-4 h-4 text-primary-glow shrink-0" />;
  if (state === "fail") return <X className="w-4 h-4 text-destructive shrink-0" />;
  return <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0" />;
}
