## Add verified read/write of scooter identifiers

The Info screen already exists and reads serial + DRV/BLE/BMS firmware over the FE95 BLE link, with a "type CONFIRM" dialog before any serial write. What's missing is the **verify** half of the flow: after the write we never confirm the scooter actually accepted it. We also expose only a subset of the identifiers the protocol can read.

This change closes both gaps without redoing existing UI.

### Identifiers shown (read-only unless noted)

| Field             | Source                  | Editable |
|-------------------|-------------------------|----------|
| Serial number     | ESC reg `0x10` (14 B)   | yes      |
| DRV firmware      | ESC reg `0x1A` (u16)    | no       |
| BLE firmware      | BLE reg `0x1A` (u16)    | no       |
| BMS firmware      | BMS reg `0x1A` (u16)    | no       |
| BMS serial        | BMS reg `0x10` (14 B)   | no (new) |
| Hardware version  | ESC reg `0x19` (u16)    | no (new) |
| Manufacture date  | BMS reg `0xB2` (u16)    | no (new) |
| Total mileage     | ESC reg `0x29`          | no       |

The three "(new)" rows just need extra `readRegister` calls in `readInfo()`.

### Verify-after-write flow for the serial

Today: `writeSerial(s)` → write bytes → `readInfo()` → trust whatever comes back.
Now: a four-state state machine surfaced in the dialog itself.

```text
┌────────────────────────────────────────────────────────┐
│  CONFIRM SERIAL CHANGE                                 │
│  Old:  16133/00012345                                  │
│  New:  16133/00099999                                  │
│  Type CONFIRM to proceed.        [_____________]       │
│                                              [WRITE]   │
└────────────────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│  WRITING…   ░░░░░▓▓▓▓▓░░░░░                            │
│  Sending 14-byte payload to ESC reg 0x10               │
└────────────────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────┐
│  VERIFYING…                                            │
│  Re-reading ESC serial to confirm…                     │
└────────────────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
   ✓ VERIFIED                ✗ MISMATCH
   Read back matches         Read back: "16133/00012345"
   "16133/00099999"          Expected:  "16133/00099999"
   [DONE]                    [RETRY]   [CANCEL]
```

Verify rules:
- After write, wait 250 ms, call `readInfo()`, compare `info.serial` to the requested string (ignoring trailing spaces).
- On mismatch: stay in the dialog, show old vs read-back vs expected, allow Retry (re-runs write+verify, max 3 attempts) or Cancel (closes dialog, original serial untouched in UI state).
- On read failure / timeout: same UI as mismatch but labelled "READ FAILED".
- Success: toast "Serial verified", close dialog, refresh Info panel from the verified read.

### Files I'll change

- `src/lib/m365/protocol.ts`
  - Add `decodeBmsDate(word)` helper (5/4/7-bit packed Y/M/D, community-documented).
  - Re-export the new register addresses already used.
- `src/lib/m365/scooter-service.ts`
  - Extend `ScooterInfo` with `bmsSerial`, `hwVersion`, `manufactureDate` (all optional strings).
  - In `readInfo()` add the three extra reads + parsing branches in the `onFrame` collector.
  - Replace `writeSerial(s)` with `writeSerialAndVerify(s) → { ok, written, readBack, attempt }` that writes, waits, re-reads, and returns the comparison. Mock path simulates a successful write.
- `src/store/scooter-store.ts`
  - No schema change; just consumes the wider `ScooterInfo` shape.
- `src/hooks/use-scooter.ts`
  - Replace `writeSerial` with `writeSerialAndVerify` returning the result object so the UI can drive its state machine.
- `src/screens/InfoScreen.tsx`
  - Add new identifier rows.
  - Convert the existing `AlertDialog` into a multi-step dialog: `confirm → writing → verifying → verified | mismatch`, with Retry/Cancel on mismatch and a small inline log showing exactly what was sent and read back.
  - Disable the WRITE button while a verify pass is in flight.

### Out of scope

- Writing anything other than the serial (firmware versions are read-only by design).
- Persisting an audit trail of serial changes — happy to add later if useful.
