import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor config for Scooter Beacon.
 *
 * BLE on a real device requires:
 *   1. The native shells to exist (`npx cap add android` / `npx cap add ios`).
 *   2. Runtime permissions declared in the native manifests (see BLE_SETUP.md).
 *   3. The app to load its bundled `dist/` build — NOT the Lovable preview URL —
 *      because the BLE plugin only attaches when running from the native WebView.
 *
 * The `server.url` block below enables hot-reload from the Lovable sandbox
 * during development. It MUST be commented out for any build you actually
 * want BLE to work on (dev device on a different network, TestFlight,
 * Play Store, sideloaded APK). When `server.url` is set, the WebView loads
 * the remote preview and Capacitor plugins like @capacitor-community/bluetooth-le
 * cannot bind to native code.
 */
const config: CapacitorConfig = {
  appId: "app.lovable.12261e39904d41878cb069cbf7488579",
  appName: "ScootFlash",
  webDir: "dist",
  bundledWebRuntime: false,

  // Hot-reload from the Lovable sandbox. Comment this whole block out
  // before building for a real device if you want Bluetooth to work.
  // server: {
  //   url: "https://12261e39-904d-4187-8cb0-69cbf7488579.lovableproject.com?forceHideBadge=true",
  //   cleartext: true,
  // },

  plugins: {
    BluetoothLe: {
      displayStrings: {
        scanning: "Scanning for scooters…",
        cancel: "Cancel",
        availableDevices: "Available scooters",
        noDeviceFound: "No M365-family scooters found",
      },
    },
  },
  ios: { contentInset: "always" },
  // allowMixedContent MUST stay false (or unset) — enabling it lets the
  // Android WebView load plaintext http:// resources, which would bypass
  // the https-only trusted-firmware-source policy. See
  // src/test/capacitor-config.test.ts for the regression guard.
  android: { allowMixedContent: false },
};

export default config;
