# Making Bluetooth work on a real device

The JS BLE layer (`src/lib/generic-ble.ts`, `src/lib/ninebot/session.ts`) is
already wired to `@capacitor-community/bluetooth-le`. The only remaining
work is on the **native shells** — these aren't checked in, you generate
them locally after exporting the project to your own GitHub repo.

## One-time setup

```bash
# 1. Pull from your GitHub fork and install
npm install

# 2. Add native platforms
npx cap add android
npx cap add ios     # macOS + Xcode only

# 3. Build the web bundle and sync into the native projects
npm run build
npx cap sync
```

## Required native config

### Android — `android/app/src/main/AndroidManifest.xml`

Add inside `<manifest>` (before `<application>`):

```xml
<!-- Android 12+ (API 31+) -->
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
    android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

<!-- Android 6–11 (API 23–30) — BLE scan requires location -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"
    android:maxSdkVersion="30" />

<!-- Legacy, harmless to include -->
<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />

<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
```

### iOS — `ios/App/App/Info.plist`

Add the keys (Xcode → Info tab works too):

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>Scooter Beacon uses Bluetooth to connect to your scooter for live diagnostics and firmware flashing.</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>Scooter Beacon uses Bluetooth to connect to your scooter.</string>
```

## Build & run

```bash
# Make sure capacitor.config.ts has server.url commented out (it is by default now)
npm run build
npx cap sync

npx cap run android   # plug in a device, USB debugging on
npx cap run ios       # opens Xcode; pick your device and Run
```

The first scan will trigger the OS permission prompts. Grant them, and
real scooters/peripherals will appear in the Connect / Generic BLE screens
exactly where the mocks appear in the web preview.

## Quick sanity check

If scans return zero devices on a real phone:

1. Confirm `capacitor.config.ts` has the `server` block commented out, then
   re-run `npm run build && npx cap sync`. If the WebView is loading the
   Lovable preview URL, BLE plugin calls become no-ops.
2. On Android: Settings → Apps → ScootFlash → Permissions — verify
   "Nearby devices" (and Location on Android ≤ 11) is granted.
3. On iOS: Settings → ScootFlash → Bluetooth must be on.
4. Make sure phone Bluetooth is enabled and the scooter is actually
   advertising (power-cycle it).
