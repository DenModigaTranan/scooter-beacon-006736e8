## Add a scooter brand/profile selector with persistence

The user originally picked "Other / not sure yet" during onboarding, but the app currently hard-codes the Xiaomi M365 protocol everywhere. This change introduces an explicit **profile** setting the user can read and change at any time, persisted to local storage so it survives app restarts.

It does NOT yet wire a second protocol stack — that's a separate, much larger change. The selector is the foundation: every later feature can read this setting and branch on it.

### The four profiles offered

| Key             | Label                  | Notes                                              |
|-----------------|------------------------|----------------------------------------------------|
| `xiaomi-m365`   | Xiaomi M365 family     | Current behaviour — full protocol support.         |
| `ninebot`       | Ninebot / Segway       | Selectable but flagged "Coming soon".              |
| `generic-ble`   | Other / Generic BLE    | Selectable but flagged "Coming soon".              |
| `unset`         | (none)                 | Initial state; forces the picker to appear.        |

For now, picking `ninebot` or `generic-ble` saves the choice and shows a small "Protocol not yet implemented — using read-only mode" banner on connected screens. No app crash, no fake data.

### Where it lives

```text
┌── First launch (after disclaimer) ──────────────────┐
│  CHOOSE YOUR SCOOTER                                │
│                                                     │
│  ◉  Xiaomi M365 family       [recommended]          │
│  ○  Ninebot / Segway         [coming soon]          │
│  ○  Other / Generic BLE      [coming soon]          │
│                                                     │
│  [           CONTINUE           ]                   │
└─────────────────────────────────────────────────────┘
```

After that, the same selector is reachable any time from **Settings → Profile**:

```text
┌── Settings ──────────────────┐
│  PROFILE                     │
│  Xiaomi M365 family    [▾]   │  ← tap to change
│                              │
│  CONNECTED DEVICE …          │
│  FIRMWARE CATALOG URL …      │
│  …                           │
└──────────────────────────────┘
```

The header pill also gets a tiny profile chip so the active profile is visible everywhere:

```text
SCOOTER INFO          [M365 ●CONNECTED]
```

### Files

New:
- `src/lib/profile.ts` — type `ScooterProfile`, the profile catalog (label, description, status), `getProfile()` / `setProfile()` localStorage helpers under key `scootflash:profile`, and a tiny `useProfile()` hook that subscribes to changes via a custom `storage` event so all screens stay in sync without needing a global store.
- `src/screens/ProfileSelectScreen.tsx` — the full-page picker shown when no profile is saved yet (radio cards, Continue button, neon-garage styling consistent with `DisclaimerScreen`).
- `src/components/ProfilePicker.tsx` — small inline picker (panel + select) used inside Settings.

Changed:
- `src/pages/Index.tsx` — gate after the disclaimer: if `profile === null`, render `ProfileSelectScreen`; otherwise proceed exactly as today.
- `src/screens/SettingsScreen.tsx` — add a "Profile" panel at the top using `ProfilePicker`.
- `src/components/AppShell.tsx` — `HeaderBar` accepts an optional `profileLabel` slot rendered as a small chip next to the status badge.
- `src/screens/InfoScreen.tsx`, `src/screens/DashboardScreen.tsx`, `src/screens/FlashScreen.tsx` — when the active profile is `ninebot` or `generic-ble`, show a single "Read-only — protocol not yet implemented" banner at the top. Existing M365 logic still runs underneath unchanged (so the mock data still drives the UI), but the banner sets clear expectations.

### Storage shape

```ts
// localStorage key:  scootflash:profile
// value:             "xiaomi-m365" | "ninebot" | "generic-ble"   (or absent)
```

Single string, mirroring the existing `scootflash:catalog-url` convention. No new dependencies.

### Out of scope

- Implementing the Ninebot or Generic BLE protocols (each is a multi-day effort and was deferred earlier).
- Migrating per-profile firmware catalogs — the catalog URL stays global for now.
