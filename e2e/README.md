# Flow tests (Maestro, Android emulator)

CI builds a separate **flow-test app** and drives it with
[Maestro](https://maestro.mobile.dev) on an emulator. See
`.github/workflows/ci.yml`, job `flow-tests`.

## Test mode

`USEBY_E2E=1` at build time, and only then, makes `metro.config.js` swap two
modules:

| In real builds | In the flow-test build |
|---|---|
| `expo-camera` | `e2e/app/fakeCamera.tsx`: shows the fixture label; the shutter writes it to a real cache file |
| `src/testing/e2eHook.ts` (empty) | `e2e/app/setup.ts`: answers requests to `https://e2e.invalid` from `scenarios.ts` |

`app.config.js` also turns expo-updates off for that build, so it runs the
code under test rather than the last published update.

Everything between the shutter and the list is the production code: resize,
encode, the scan client and its headers, response mapping, the editor,
storage, sorting. `scripts/check-bundle-isolation.mjs` (run in CI) proves the
production bundle contains none of the above, and that the test bundle does.

**Picking a scan result:** a flow opens `useby://e2e?fixture=<name>` before
pressing the shutter. The names are in `e2e/app/scenarios.ts`: `milk`,
`yoghurt`, `chicken`, `cheese`, `unreadable`, `server-error`. Dates are
relative to today. `scripts/e2e-scenarios.test.mjs` checks each canned answer
against the real response contract.

Capture does not wait for the answer, so the fixture is **fixed at the
shutter**: the stand-in camera records it when it takes the picture, and the
stand-in proxy hands it to the first request carrying that scan id. A flow can
therefore switch fixture for the next shot while earlier ones are still being
read. The camera's `Test camera · <fixture>` label re-renders on every switch;
`common/shoot.yaml` waits for it (and for the shutter to be enabled) before
pressing.

## How a scan looks to a flow

The camera has two modes, chosen on the camera with "Single item" /
"Multiple items". Every fresh visit starts in **Single item**.

- **Single item:** Capture → straight back to Home → the draft appears under
  "JUST SCANNED" as "Checking…", then its result → tap it → Review & Save →
  Home.
- **Multiple items:** Capture → the camera stays open, a running count
  ("2 checking · 1 to review") and **Finish (n)** appear → answers arrive as a
  result card on the camera → tapping the card opens Review & Save, and Save
  returns to the camera → Finish returns Home with every draft intact.
- **Cancel** (top-left) leaves without capturing anything.

Nothing opens by itself and nothing is saved without the review step.

Fixtures: `milk`, `yoghurt`, `chicken`, `cheese`, `unreadable`,
`server-error`, and `slow-milk` (milk, answered after six seconds instead of
0.7, so a flow can see a draft still "Checking…" on Home).

## Flows

| File | Covers |
|---|---|
| `flows/add-item.yaml` | Add by scan (Single item): clean read with its photo on the Home row, unreadable label, scanner down (draft kept and finished by hand), manual add showing the "No photo" placeholder |
| `flows/capture-modes.yaml` | Cancel without capturing; Single item returns Home before the answer exists, which then lands on the right draft and still needs review; Multiple items stays open, counts, and Finish keeps every draft; a fresh visit is Single item again |
| `flows/dashboard-sorted.yaml` | Four shots in one Multiple items visit, Finish, each reviewed from Home; list sorted most-urgent-first under the right headings |
| `flows/retake.yaml` | Retake replaces its draft from a Home draft (Single item: back Home, one draft) and from the camera card (Multiple items: back to the same camera, next shot is a new item, Finish reaches Home) |
| `flows/item-detail-edit.yaml` | Item Detail shows the retained photo; editing the name keeps the item and its photo; photo on Home and Detail survive an app restart; Used it from Item Detail |
| `flows/pending-restart.yaml` | A scan killed mid-recognition comes back after a restart as "Didn't finish checking" (no spinner), retries on tap; a finished result killed before Save comes back as it was without being re-read; Save moves it into the list once and a further restart leaves no draft |
| `flows/reminders.yaml` | Reminders off until turned on; turning on asks permission; saving an item schedules two (read back from Android's own pending list); opting in to the day after makes three; changing the time keeps three; a restart reconciles to the same; Used it clears them; turning off clears all; refused permission leaves them off with a way to settings |
| `flows/mark-used-delete.yaml` | Row swipe: "Used it" removes; Delete asks, Cancel keeps, confirm removes |

Shared steps are in `flows/common/`: `launch-clean`, `open-camera`, `shoot`,
`close-camera`, `scan-and-save`.

Every flow starts from a cleared app (`common/launch-clean.yaml`). Not covered:
changing the date through the wheel picker (the date round trip is covered by
`scripts/item-lifecycle.test.mjs`); a photo file deleted from under a saved
item, which a flow cannot arrange (covered by `scripts/photos.test.mjs` and
`scripts/item-lifecycle.test.mjs`); and the real camera, which stays a by-hand
check, as is whether a reminder is actually *delivered* at its time (the
flow checks what is scheduled with the OS, not the notification appearing).
Not covered because the features don't exist: barcode scanning,
recording an item as *wasted*.

## Running locally (optional)

You need Android Studio's emulator, Java 17 and the Maestro CLI. Then:

```bash
USEBY_E2E=1 EXPO_PUBLIC_USEBY_PROXY_URL=https://e2e.invalid EXPO_PUBLIC_USEBY_PROXY_SECRET=x \
  npx expo prebuild --platform android --clean
USEBY_E2E=1 EXPO_PUBLIC_USEBY_PROXY_URL=https://e2e.invalid EXPO_PUBLIC_USEBY_PROXY_SECRET=x \
  sh -c 'cd android && ./gradlew assembleRelease'
bash e2e/run-flows.sh android/app/build/outputs/apk/release/app-release.apk
```

Run `npx expo prebuild --clean` again without `USEBY_E2E` before any normal
local build.

Changing the fixture image? Run `node e2e/scripts/embed-fixture.mjs`.
