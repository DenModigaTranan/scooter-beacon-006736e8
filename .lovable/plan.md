## Xiaomi M365 Bluetooth Flasher — Native Mobile App

A native Android/iOS app (built with Capacitor) that connects to Xiaomi M365-family scooters over Bluetooth Low Energy. Users can read scooter info, change the serial number, view a live dashboard, and flash DRV / BMS / BLE firmware from a curated online catalog or their own .bin file — with strong safety checks throughout.

### Scope (v1)

- **Targets:** Xiaomi M365, M365 Pro, 1S, Pro 2, Essential (same FE95 protocol family)
- **Platform:** React + Vite app wrapped with Capacitor for iOS/Android, using a community-maintained BLE plugin (`@capacitor-community/bluetooth-le`)
- **Style:** "Neon Garage" — JetBrains Mono headings, Work Sans body, dark navy `#0d1b2a` base, deep forest `#1b4332` surfaces, mint `#2dd4a8` primary actions, lime `#73ffb8` highlights. Tuner/garage-tool feel with mono numeric readouts.

### App structure

```text
┌─ Connect screen ─────────────────────────────┐
│  Scan → list of nearby M365-family scooters  │
│  Tap to pair → handshake on FE95 service     │
└──────────────────────────────────────────────┘
            ↓ once connected, tab bar:
┌──────────┬──────────┬──────────┬──────────┐
│ Dashboard│  Info    │  Flash   │ Settings │
└──────────┴──────────┴──────────┴──────────┘
```

#### 1. Connect
- BLE scan with permission prompts (Android 12+ runtime perms, iOS Info.plist usage strings)
- Filters for known Xiaomi scooter advertising names/services
- Signal strength, last-seen scooter remembered for fast reconnect
- Clear "disconnected" / "reconnecting" banner

#### 2. Dashboard (live telemetry)
- Big mono readouts: speed, battery %, voltage, current, motor temp, mode (eco / drive / sport)
- Trip stats: current speed, total mileage, trip mileage, remaining range
- Live polling of scooter serial commands; auto-pauses when tab hidden to save battery
- Connection quality indicator

#### 3. Info (read/write)
- Read & display: serial number, DRV firmware version, BMS firmware version, BLE firmware version, total mileage, battery cycles, manufacture date
- **Change serial number** flow with strong warning + double confirm
- Copy-to-clipboard on every value

#### 4. Flash
The core feature. A guided, step-by-step flow:

```text
Step 1  Pick target  → DRV / BMS / BLE
Step 2  Pick firmware
        • Online catalog (fetched from remote JSON registry — versions,
          changelogs, compatibility per scooter model)
        • Or import a custom .bin from device storage
Step 3  Pre-flight checks (all must pass to continue)
        ✓ Battery ≥ 50%
        ✓ Scooter stationary, kickstand down
        ✓ Phone battery ≥ 30%
        ✓ Firmware compatible with detected model
        ✓ User typed CONFIRM and acknowledged risk warning
Step 4  Flashing
        • Chunked write to FE95 with progress bar, % and KB/s
        • Live log console (mono, green-on-dark)
        • Abort button (where safe)
        • Auto-handles disconnect → resume / fail-safe message
Step 5  Verify & reboot
        • Read back version, confirm match
        • Success / failure screen with next steps
```

#### 5. Settings
- Theme (dark only in v1)
- Catalog source URL (so you can swap/extend the firmware registry)
- Diagnostic log export (share .txt)
- About / disclaimer / open-source notices

### Safety system (applies everywhere)
- Persistent disclaimer on first launch — user must accept
- Hard battery / motion gating before any flash starts
- All destructive actions (serial change, flash) require double confirm + typed keyword
- If BLE drops mid-flash: scooter is left in a known state where possible, clear recovery instructions shown
- All flash attempts logged locally with timestamp + outcome

### Firmware catalog (remote)
- App fetches a JSON file (URL configurable in Settings) listing available firmwares:
  - target (DRV/BMS/BLE), model compatibility, version, size, sha256, download URL, changelog, "stable/experimental" tag
- App downloads + caches the .bin, verifies sha256 before allowing flash
- Default catalog URL ships pointing to a placeholder you can host (e.g. GitHub Pages JSON) — easy to update without app rebuilds

### Visual design
- Background: deep navy `#0d1b2a`, cards in `#11243a` with subtle 1px mint border at 10% opacity
- Primary CTA: mint `#2dd4a8` with black text, soft glow on press
- Danger actions (flash, change SN): outline in coral, fill on confirm
- Numeric readouts: JetBrains Mono, lime `#73ffb8`, oversized
- Subtle scanline / grid texture on Dashboard for "tuner" feel
- Smooth tab transitions, haptic feedback on connect/disconnect/flash events (Capacitor Haptics)

### Technical notes (for the curious)
- `@capacitor-community/bluetooth-le` for cross-platform BLE
- M365 protocol implementation: header `0x55 0xAA`, length, addr, cmd, args, checksum — encoded/decoded in a small `m365-protocol.ts` module with unit tests
- Flash protocol mirrors the well-known community DRV-flash sequence (enter bootloader → erase → chunked write → verify CRC → reboot)
- React Query for catalog fetching/caching; Zustand for live BLE connection state
- All BLE work isolated in a `useScooter()` hook so UI components stay clean
- Capacitor config (appId, hot-reload URL) and the iOS/Android native projects are added in this build; user must export to GitHub + run `npx cap add ios/android` and build via Xcode/Android Studio to install on a physical device (preview in browser will not have BLE)

### Out of scope for v1 (can add later)
- Ninebot/Segway support
- Cloud account / sync of flash history across devices
- OTA notification when new firmware lands in the catalog
- Theme customization

### What you'll do after I build this
1. Export project to GitHub, `git pull`, `npm install`
2. `npx cap add android` (and/or `ios` on a Mac)
3. `npm run build && npx cap sync`
4. `npx cap run android` (or open in Xcode for iOS) to install on your phone
5. Host your firmware catalog JSON somewhere and paste the URL into Settings
