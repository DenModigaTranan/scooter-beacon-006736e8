/**
 * NinebotSupportedModels — read-only settings panel.
 *
 * Purpose:
 *   Give users (and ourselves, when triaging "why doesn't my scooter work?")
 *   a single place to see exactly which Ninebot/Segway models the app
 *   recognizes and what each one can do once connected. The panel is the
 *   user-facing rendering of the static registry in `src/lib/ninebot-models.ts`
 *   — there is no separate source of truth, so additions to the registry
 *   show up here automatically.
 *
 * Non-goals:
 *   • Editing the registry. The catalog is code, not user data.
 *   • Live status. This panel is purely descriptive; it doesn't reflect
 *     which model is currently connected (that's the connect banner's job).
 *
 * UX notes:
 *   • Models are grouped by category and the categories are rendered in a
 *     fixed order (kick scooters first, then mopeds, then the rest) since
 *     that mirrors which families users encounter most often.
 *   • Each model card is collapsed by default to keep the initial view
 *     scannable; expanding reveals the per-capability breakdown grouped
 *     by action class (read / write / secure) so it's obvious at a glance
 *     which actions need authentication.
 *   • A small filter input narrows the list by model display name,
 *     short label, id, or any capability token — handy when checking
 *     "does any model support cruise-control?".
 */

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown, Search, X, Eye, Pencil, ShieldCheck, Bluetooth, Cpu, Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  NINEBOT_MODELS,
  type NinebotCapability,
  type NinebotCategory,
  type NinebotModel,
} from "@/lib/ninebot-models";

/* -------------------------------------------------------------------------- */
/* Static metadata                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Display order + label for each category. Anything not listed here gets
 * appended at the end in registry order, so adding a new category is
 * harmless even before this map is updated.
 */
const CATEGORY_DISPLAY: Record<NinebotCategory, { label: string; order: number }> = {
  "kick-scooter":   { label: "Kick scooters",   order: 1 },
  "moped":          { label: "Mopeds",          order: 2 },
  "self-balancing": { label: "Self-balancing",  order: 3 },
  "unicycle":       { label: "Unicycles",       order: 4 },
  "go-kart":        { label: "Go-karts",        order: 5 },
  "e-bike":         { label: "E-bikes",         order: 6 },
  "speaker":        { label: "Speakers",        order: 7 },
  "power-station":  { label: "Power stations",  order: 8 },
};

/**
 * Human-readable label for each capability token. Keeping this colocated
 * with the panel (not in the registry) lets the registry stay
 * presentation-free — the same capability could be surfaced very
 * differently in, say, a CLI debug output.
 */
const CAPABILITY_LABEL: Record<NinebotCapability, string> = {
  "read.battery":           "Battery level",
  "read.speed":             "Live speed",
  "read.odometer":          "Odometer",
  "read.mode":              "Drive mode",
  "read.temperature":       "Temperature",
  "read.firmware-version":  "Firmware version",
  "read.serial-number":     "Serial number",
  "write.lock":             "Lock",
  "write.unlock":           "Unlock",
  "write.lights":           "Headlight / taillight",
  "write.beep":             "Beep / horn",
  "write.speed-limit":      "Set speed limit",
  "write.cruise-control":   "Cruise control",
  "write.ble-name":         "Rename device",
  "secure.firmware-update": "Firmware update (OTA)",
};

/**
 * Visual styling for each capability class. The colour cue is the only
 * way to tell at-a-glance that "secure.*" actions require an auth
 * handshake, so we make it a hard-to-miss accent rather than relying on
 * the prefix alone.
 */
const CLASS_META = {
  read:   { label: "Read",           icon: Eye,         tone: "text-primary",       bg: "bg-primary/5",       border: "border-primary/30" },
  write:  { label: "Write",          icon: Pencil,      tone: "text-warning",       bg: "bg-warning/5",       border: "border-warning/30" },
  secure: { label: "Secure (auth)",  icon: ShieldCheck, tone: "text-destructive",   bg: "bg-destructive/5",   border: "border-destructive/30" },
} as const;

type CapClass = keyof typeof CLASS_META;

function classOf(cap: NinebotCapability): CapClass {
  if (cap.startsWith("read.")) return "read";
  if (cap.startsWith("write.")) return "write";
  return "secure";
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function NinebotSupportedModels() {
  // Free-text filter applied to display name, short label, model id, and
  // every capability token. Capability matching is what makes this useful
  // for "which models support X?" queries.
  const [query, setQuery] = useState("");

  // Set of expanded model ids. We use a Set rather than a single id so
  // multiple cards can stay open while comparing.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Pre-compute the grouped+sorted view. Recomputed only on filter change
  // since NINEBOT_MODELS is a module constant.
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (m: NinebotModel) => {
      if (!q) return true;
      if (m.displayName.toLowerCase().includes(q)) return true;
      if (m.shortLabel.toLowerCase().includes(q)) return true;
      if (m.id.toLowerCase().includes(q)) return true;
      if (m.capabilities.some((c) => c.toLowerCase().includes(q))) return true;
      // Match against the human-readable capability label too, so users
      // can search for "horn" instead of "write.beep".
      if (m.capabilities.some((c) => CAPABILITY_LABEL[c]?.toLowerCase().includes(q))) return true;
      return false;
    };

    const byCategory = new Map<NinebotCategory, NinebotModel[]>();
    for (const m of NINEBOT_MODELS) {
      if (!matches(m)) continue;
      const arr = byCategory.get(m.category) ?? [];
      arr.push(m);
      byCategory.set(m.category, arr);
    }
    return Array.from(byCategory.entries()).sort(
      // Stable category order from CATEGORY_DISPLAY; unknown categories
      // sort after known ones so the list never breaks if the registry
      // gains a new family before this file is updated.
      (a, b) => (CATEGORY_DISPLAY[a[0]]?.order ?? 99) - (CATEGORY_DISPLAY[b[0]]?.order ?? 99),
    );
  }, [query]);

  const totalShown = groups.reduce((n, [, ms]) => n + ms.length, 0);

  return (
    <section
      aria-label="Supported Ninebot and Segway models"
      className="panel p-3 space-y-3"
    >
      <header className="flex items-center justify-between gap-2">
        <div>
          <div className="mono text-[10px] tracking-[0.22em] uppercase text-muted-foreground">
            Supported models
          </div>
          <div className="mono text-[10px] text-muted-foreground/80 mt-0.5">
            {totalShown} of {NINEBOT_MODELS.length} shown · capabilities pulled from the in-app registry
          </div>
        </div>
      </header>

      {/* Filter bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by model, id, or capability (e.g. 'horn', 'cruise')…"
          className={cn(
            "mono text-xs w-full h-9 rounded-md border border-input bg-background pl-8 pr-8",
            "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ring-offset-background",
          )}
          aria-label="Filter supported models"
        />
        {query && (
          <button
            onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear filter"
            type="button"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Class legend — explains the colour coding once so each card can
          rely on it without repeating itself. */}
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(CLASS_META) as CapClass[]).map((k) => {
          const meta = CLASS_META[k];
          const Icon = meta.icon;
          return (
            <span
              key={k}
              className={cn(
                "inline-flex items-center gap-1 mono text-[9px] tracking-widest uppercase px-1.5 py-0.5 rounded border",
                meta.tone, meta.bg, meta.border,
              )}
            >
              <Icon className="w-3 h-3" aria-hidden /> {meta.label}
            </span>
          );
        })}
      </div>

      {/* Empty state */}
      {totalShown === 0 && (
        <div className="text-center text-xs text-muted-foreground py-6">
          No models match "{query}".
        </div>
      )}

      {/* Grouped model list */}
      {groups.map(([category, models]) => (
        <div key={category} className="space-y-1.5">
          <div className="mono text-[9px] tracking-[0.22em] uppercase text-muted-foreground/70 px-0.5">
            {CATEGORY_DISPLAY[category]?.label ?? category}
          </div>
          {models.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              open={expanded.has(m.id)}
              onToggle={() => toggle(m.id)}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Per-model card                                                             */
/* -------------------------------------------------------------------------- */

function ModelCard({
  model, open, onToggle,
}: {
  model: NinebotModel;
  open: boolean;
  onToggle: () => void;
}) {
  // Group the model's capabilities by class so the expanded view can
  // render three short lists rather than one mixed pile. Sorted by the
  // human label for predictable scanning.
  const grouped = useMemo(() => {
    const out: Record<CapClass, NinebotCapability[]> = { read: [], write: [], secure: [] };
    for (const c of model.capabilities) out[classOf(c)].push(c);
    for (const k of Object.keys(out) as CapClass[]) {
      out[k].sort((a, b) => (CAPABILITY_LABEL[a] ?? a).localeCompare(CAPABILITY_LABEL[b] ?? b));
    }
    return out;
  }, [model]);

  // Compact capability counts for the collapsed header — tells the user
  // at a glance how rich the model's command set is without expanding.
  const counts = {
    read:   grouped.read.length,
    write:  grouped.write.length,
    secure: grouped.secure.length,
  };

  return (
    <div className={cn("rounded-md border border-border bg-secondary/30 overflow-hidden")}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-foreground/[0.03] transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono text-sm truncate">{model.displayName}</span>
            <span className="chip text-[8px] tracking-widest text-muted-foreground border border-border">
              {model.shortLabel.toUpperCase()}
            </span>
            <span
              className="chip text-[8px] tracking-widest text-muted-foreground border border-border"
              title={`Wire-format generation: ${model.protocol}`}
            >
              {model.protocol.toUpperCase()}
            </span>
          </div>
          <div className="mono text-[10px] text-muted-foreground tracking-widest mt-0.5 flex items-center gap-2 flex-wrap">
            <span>{model.id}</span>
            <span aria-hidden>·</span>
            <span className={CLASS_META.read.tone}>{counts.read} read</span>
            <span aria-hidden>·</span>
            <span className={CLASS_META.write.tone}>{counts.write} write</span>
            <span aria-hidden>·</span>
            <span className={CLASS_META.secure.tone}>{counts.secure} secure</span>
          </div>
        </div>
        <ChevronDown
          className={cn(
            "w-4 h-4 text-muted-foreground shrink-0 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="border-t border-border"
          >
            <div className="px-3 py-2.5 space-y-2.5">
              {/* Detection summary — shows exactly how this model is
                  recognized from a BLE advertisement. Useful for users
                  reporting "my scooter shows up unidentified". */}
              <div className="space-y-1">
                <div className="mono text-[9px] tracking-[0.22em] uppercase text-muted-foreground">
                  Detection
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(model.detection.namePrefixes ?? []).map((p) => (
                    <span
                      key={`name-${p}`}
                      className="inline-flex items-center gap-1 mono text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground"
                      title="Advertised name prefix (case-insensitive)"
                    >
                      <Tag className="w-3 h-3" aria-hidden /> {p}*
                    </span>
                  ))}
                  {model.detection.serviceUuidSuffix && (
                    <span
                      className="inline-flex items-center gap-1 mono text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground"
                      title="Trailing hex of the custom 128-bit service UUID"
                    >
                      <Bluetooth className="w-3 h-3" aria-hidden /> uuid…{model.detection.serviceUuidSuffix.slice(-8)}
                    </span>
                  )}
                  {(model.detection.manufacturerIds ?? []).map((id) => (
                    <span
                      key={`mfr-${id}`}
                      className="inline-flex items-center gap-1 mono text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground"
                      title="Bluetooth SIG company identifier"
                    >
                      <Cpu className="w-3 h-3" aria-hidden /> 0x{id.toString(16).padStart(4, "0")}
                    </span>
                  ))}
                  {model.detection.hardwareId != null && (
                    <span
                      className="inline-flex items-center gap-1 mono text-[9px] px-1.5 py-0.5 rounded border border-border text-muted-foreground"
                      title="Authoritative — read post-connect from register 0x12"
                    >
                      <Cpu className="w-3 h-3" aria-hidden /> hw 0x{model.detection.hardwareId.toString(16)}
                    </span>
                  )}
                  {!model.detection.namePrefixes?.length
                    && !model.detection.serviceUuidSuffix
                    && !model.detection.manufacturerIds?.length
                    && model.detection.hardwareId == null && (
                      <span className="mono text-[10px] text-muted-foreground italic">
                        No detection rules — used only as a fallback.
                      </span>
                    )}
                </div>
              </div>

              {/* Per-class capability lists. We render an empty section
                  hint rather than hiding the whole class, because "0
                  write commands" is itself meaningful information about
                  a model's surface area. */}
              {(Object.keys(CLASS_META) as CapClass[]).map((cls) => {
                const items = grouped[cls];
                const meta = CLASS_META[cls];
                const Icon = meta.icon;
                return (
                  <div key={cls} className="space-y-1">
                    <div className={cn("inline-flex items-center gap-1 mono text-[9px] tracking-[0.22em] uppercase", meta.tone)}>
                      <Icon className="w-3 h-3" aria-hidden /> {meta.label}
                      <span className="text-muted-foreground/70 ml-1">({items.length})</span>
                    </div>
                    {items.length === 0 ? (
                      <div className="mono text-[10px] text-muted-foreground/70 italic pl-4">
                        none
                      </div>
                    ) : (
                      <ul className="flex flex-wrap gap-1">
                        {items.map((c) => (
                          <li
                            key={c}
                            className={cn(
                              "mono text-[10px] px-1.5 py-0.5 rounded border",
                              meta.tone, meta.bg, meta.border,
                            )}
                            title={c}
                          >
                            {CAPABILITY_LABEL[c] ?? c}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}

              {model.notes && (
                <div className="mono text-[10px] text-muted-foreground leading-relaxed border-t border-border pt-2">
                  <span className="mono text-[9px] tracking-widest uppercase text-muted-foreground/80 mr-1">
                    Note
                  </span>
                  {model.notes}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
