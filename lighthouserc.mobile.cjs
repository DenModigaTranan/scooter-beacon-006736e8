/**
 * Lighthouse CI config — mobile run with relaxed thresholds for slower devices.
 *
 * Run locally:   npm run lhci:mobile
 * Run in CI:     see .github/workflows/lighthouse.yml
 */
module.exports = {
  ci: {
    collect: {
      startServerCommand: "npm run preview -- --port 4173 --strictPort",
      url: ["http://localhost:4173/"],
      numberOfRuns: 3,
      settings: {
        formFactor: "mobile",
        screenEmulation: {
          mobile: true,
          width: 390,
          height: 844,
          deviceScaleFactor: 3,
          disabled: false,
        },
        throttling: {
          rttMs: 150,
          throughputKbps: 1638.4,
          cpuSlowdownMultiplier: 4,
        },
        onlyCategories: ["performance", "best-practices"],
      },
    },
    assert: {
      assertions: {
        // Font-loading guards: text must never be blocked by webfont download.
        "font-display": "error",
        "uses-rel-preconnect": "warn",
        "render-blocking-resources": ["warn", { maxLength: 0 }],

        // Mobile First Contentful Paint budget (ms) — relaxed for slower networks/CPU.
        "first-contentful-paint": ["error", { maxNumericValue: 3000 }],
        "largest-contentful-paint": ["warn", { maxNumericValue: 4000 }],

        // Overall perf score floor for mobile (0-1).
        "categories:performance": ["warn", { minScore: 0.75 }],
      },
    },
    upload: {
      target: "temporary-public-storage",
    },
  },
};
