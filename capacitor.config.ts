import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.lovable.12261e39904d41878cb069cbf7488579",
  appName: "ScootFlash",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    url: "https://12261e39-904d-4187-8cb0-69cbf7488579.lovableproject.com?forceHideBadge=true",
    cleartext: true,
  },
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
  android: { allowMixedContent: true },
};

export default config;
