import { cn } from "@/lib/utils";

interface ReadoutProps {
  label: string;
  value: string | number;
  unit?: string;
  size?: "sm" | "md" | "lg" | "xl";
  tone?: "default" | "warn" | "danger";
  className?: string;
}

const sizeClass = {
  sm: "text-2xl",
  md: "text-3xl",
  lg: "text-5xl",
  xl: "text-6xl md:text-7xl",
};

export function Readout({ label, value, unit, size = "md", tone = "default", className }: ReadoutProps) {
  const toneClass =
    tone === "warn" ? "text-warning"
    : tone === "danger" ? "text-destructive"
    : "text-accent";
  return (
    <div className={cn("panel p-4 flex flex-col gap-1", className)}>
      <div className="mono text-[10px] tracking-[0.2em] text-muted-foreground uppercase">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <div className={cn("readout leading-none", sizeClass[size], toneClass)}>{value}</div>
        {unit && <div className="mono text-xs text-muted-foreground">{unit}</div>}
      </div>
    </div>
  );
}
