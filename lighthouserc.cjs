/**
 * Lighthouse CI config — tracks font loading and First Contentful Paint.
 *
 * Run locally:   npm run lhci
 * Run in CI:     see .github/workflows/lighthouse.yml
 *
 * Tune the thresholds below as the app evolves. Keep them tight enough
 * that regressions on FCP / font-display surface as failing checks.
 */
module.exports = {
  ci: {
    collect: {
      // Build the production bundle and serve it via `vite preview`,
      // then run Lighthouse against the local URL three times for stability.
      startServerCommand: "npm run preview -- --port 4173 --strictPort",
      url: ["http://localhost:4173/"],
      numberOfRuns: 3,
      settings: {
        preset: "desktop",
        onlyCategories: ["performance", "best-practices"],
      },
    },
    assert: {
      assertions: {
        // Font-loading guards: text must never be blocked by webfont download.
        "font-display": "error",
        "uses-rel-preconnect": "warn",
        "render-blocking-resources": ["warn", { maxLength: 0 }],

        // First Contentful Paint budget (ms). Raise/lower as needed.
        "first-contentful-paint": ["error", { maxNumericValue: 2000 }],
        "largest-contentful-paint": ["warn", { maxNumericValue: 2500 }],

        // Overall perf score floor (0-1).
        "categories:performance": ["warn", { minScore: 0.8 }],
      },
    },
    upload: {
      // Temporary public storage — swap for an LHCI server or GitHub
      // artifact upload once a long-term home is chosen.
      target: "temporary-public-storage",
    },
  },
};
