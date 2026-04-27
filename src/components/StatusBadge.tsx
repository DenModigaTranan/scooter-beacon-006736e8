import { cn } from "@/lib/utils";
import type { ConnectionState } from "@/store/scooter-store";

const labels: Record<ConnectionState, string> = {
  idle: "IDLE",
  scanning: "SCANNING",
  connecting: "CONNECTING",
  connected: "CONNECTED",
  disconnected: "DISCONNECTED",
  error: "ERROR",
};

export function StatusBadge({ state }: { state: ConnectionState }) {
  const tone =
    state === "connected" ? "text-primary-glow border-primary/40 bg-primary/10"
    : state === "scanning" || state === "connecting" ? "text-warning border-warning/40 bg-warning/10"
    : state === "error" ? "text-destructive border-destructive/40 bg-destructive/10"
    : "text-muted-foreground border-border/60 bg-muted/30";

  const dotTone =
    state === "connected" ? "bg-primary-glow shadow-glow"
    : state === "scanning" || state === "connecting" ? "bg-warning"
    : state === "error" ? "bg-destructive"
    : "bg-muted-foreground";

  return (
    <div className={cn("inline-flex items-center gap-2 px-2.5 py-1 rounded-sm border mono text-[10px] tracking-[0.2em]", tone)}>
      <span className={cn("h-1.5 w-1.5 rounded-full", dotTone, (state === "scanning" || state === "connecting" || state === "connected") && "animate-blink")} />
      {labels[state]}
    </div>
  );
}
