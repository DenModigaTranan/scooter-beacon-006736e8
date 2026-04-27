import { useEffect, useState } from "react";

/**
 * Read the host phone's battery level via the Battery Status API
 * (Chromium / Android WebView). Returns `null` when the API is not
 * available, in which case callers should NOT block on it.
 */
interface BatteryManager extends EventTarget {
  level: number;       // 0..1
  charging: boolean;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>;
}

export interface PhoneBattery {
  /** 0..100, or null if unsupported. */
  pct: number | null;
  charging: boolean | null;
  /** True when the API is unavailable — UI should treat as "unknown, allow". */
  unsupported: boolean;
}

export function usePhoneBattery(pollMs = 30_000): PhoneBattery {
  const [state, setState] = useState<PhoneBattery>({
    pct: null,
    charging: null,
    unsupported: false,
  });

  useEffect(() => {
    let cancelled = false;
    const nav = navigator as NavigatorWithBattery;
    if (!nav.getBattery) {
      setState({ pct: null, charging: null, unsupported: true });
      return;
    }

    let battery: BatteryManager | null = null;
    const sync = () => {
      if (!battery || cancelled) return;
      setState({
        pct: Math.round(battery.level * 100),
        charging: battery.charging,
        unsupported: false,
      });
    };

    nav.getBattery().then((b) => {
      if (cancelled) return;
      battery = b;
      b.addEventListener("levelchange", sync);
      b.addEventListener("chargingchange", sync);
      sync();
    }).catch(() => {
      if (!cancelled) setState({ pct: null, charging: null, unsupported: true });
    });

    const t = setInterval(sync, pollMs);
    return () => {
      cancelled = true;
      clearInterval(t);
      if (battery) {
        battery.removeEventListener("levelchange", sync);
        battery.removeEventListener("chargingchange", sync);
      }
    };
  }, [pollMs]);

  return state;
}
