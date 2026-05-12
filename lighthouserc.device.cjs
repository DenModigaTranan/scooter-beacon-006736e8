/**
 * Lighthouse CI config — real / remote mobile device profile.
 *
 * Unlike the desktop and emulated-mobile configs, this run targets a URL
 * served on real hardware (or a remote Chrome instance) so font loading
 * and First Contentful Paint reflect what users actually experience.
 *
 * Usage (local, against a deployed preview):
 *   LHCI_TARGET_URL=https://scooter-beacon.lovable.app \
 *     npm run lhci:device
 *
 * Usage (against a physical Android phone over ADB):
 *   1. Enable USB debugging on the phone, plug it in, accept the prompt.
 *   2. `adb forward tcp:9222 localabstract:chrome_devtools_remote`
 *   3. LHCI_TARGET_URL=https://scooter-beacon.lovable.app \
 *      LHCI_CHROME_PATH=remote LHCI_PORT=9222 npm run lhci:device
 *
 * Usage (against a remote browser farm, e.g. BrowserStack/Sauce):
 *   Point LHCI_TARGET_URL at the deployed app and set
 *   LHCI_CHROME_FLAGS="--remote-debugging-address=<host>".
 *
 * If LHCI_TARGET_URL is not set, falls back to the local preview server,
 * which is still useful for catching regressions in CI without real hardware.
 */
const targetUrl = process.env.LHCI_TARGET_URL || "http://localhost:4173/";
const useLocalPreview = targetUrl.startsWith("http://localhost");

/** @type {import('@lhci/cli').LHConfig} */
const settings = {
  // Real-device profile: emulate a mid-tier Moto G Power viewport but
  // disable Lighthouse's simulated lantern throttling so the numbers come
  // from the actual network + CPU of the device executing the run.
  formFactor: "mobile",
  screenEmulation: {
    mobile: true,
    width: 412,
    height: 823,
    deviceScaleFactor: 1.75,
    disabled: false,
  },
  throttlingMethod: "provided",
  // No synthetic throttling — measurements come from the real device.
  throttling: {
    rttMs: 0,
    throughputKbps: 0,
    cpuSlowdownMultiplier: 1,
    requestLatencyMs: 0,
    downloadThroughputKbps: 0,
    uploadThroughputKbps: 0,
  },
  onlyCategories: ["performance", "best-practices"],
};

if (process.env.LHCI_CHROME_PATH) {
  settings.chromePath = process.env.LHCI_CHROME_PATH;
}
if (process.env.LHCI_PORT) {
  settings.port = Number(process.env.LHCI_PORT);
}
if (process.env.LHCI_CHROME_FLAGS) {
  settings.chromeFlags = process.env.LHCI_CHROME_FLAGS;
}

module.exports = {
  ci: {
    collect: {
      ...(useLocalPreview
        ? { startServerCommand: "npm run preview -- --port 4173 --strictPort" }
        : {}),
      url: [targetUrl],
      numberOfRuns: 3,
      settings,
    },
    assert: {
      assertions: {
        // Font-loading guards still apply on real hardware.
        "font-display": "error",
        "uses-rel-preconnect": "warn",
        "render-blocking-resources": ["warn", { maxLength: 0 }],

        // Real-device FCP/LCP budgets — looser than emulated mobile to
        // account for variance from network conditions and warm-up.
        "first-contentful-paint": ["error", { maxNumericValue: 3500 }],
        "largest-contentful-paint": ["warn", { maxNumericValue: 4500 }],

        "categories:performance": ["warn", { minScore: 0.7 }],
      },
    },
    upload: {
      target: "temporary-public-storage",
    },
  },
};
