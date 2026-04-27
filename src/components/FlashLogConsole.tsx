import { useEffect, useRef } from "react";
import { Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface FlashLogConsoleProps {
  lines: string[];
  /** Tailwind height, e.g. "h-44". */
  height?: string;
  title?: string;
  /** Auto-scroll to the latest line on every update. Default true. */
  follow?: boolean;
}

/**
 * Read-only console that color-codes lines by prefix:
 *   `>`  info
 *   `!`  warning / error
 *   `  ` indented chunk progress (dimmer)
 * Auto-scrolls to the bottom and exposes copy / download actions.
 */
export function FlashLogConsole({
  lines, height = "h-44", title = "CONSOLE", follow = true,
}: FlashLogConsoleProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!follow) return;
    const root = scrollRef.current;
    if (!root) return;
    // shadcn ScrollArea wraps a viewport div with [data-radix-scroll-area-viewport]
    const vp = root.querySelector<HTMLElement>("[data-radix-scroll-area-viewport]");
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, [lines, follow]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success("Log copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  const onDownload = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flash-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="mono text-[10px] text-muted-foreground tracking-widest">{title}</div>
        <div className="flex items-center gap-1">
          <Button
            type="button" size="sm" variant="ghost"
            className="h-6 px-2 mono text-[10px] text-muted-foreground hover:text-foreground"
            onClick={onCopy}
            disabled={lines.length === 0}
          >
            <Copy className="w-3 h-3 mr-1" /> COPY
          </Button>
          <Button
            type="button" size="sm" variant="ghost"
            className="h-6 px-2 mono text-[10px] text-muted-foreground hover:text-foreground"
            onClick={onDownload}
            disabled={lines.length === 0}
          >
            <Download className="w-3 h-3 mr-1" /> SAVE
          </Button>
        </div>
      </div>
      <ScrollArea ref={scrollRef} className={height}>
        {lines.length === 0 ? (
          <div className="mono text-[11px] text-muted-foreground">(waiting…)</div>
        ) : (
          <pre className="mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {lines.map((line, i) => (
              <div key={i} className={lineClass(line)}>{line}</div>
            ))}
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("!")) return cn("text-destructive");
  if (line.startsWith(">")) return cn("text-primary-glow");
  // indented sub-progress lines
  if (/^\s/.test(line)) return cn("text-muted-foreground");
  return "";
}
