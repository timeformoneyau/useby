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

Capture → the answer arrives on the camera as a **result card** → tapping the
card opens Review & Save → Save returns to the camera → Done returns Home.
Nothing opens by itself and nothing is saved without the review step. Drafts
not opened on the camera wait on Home under "JUST SCANNED".

## Flows

| File | Covers |
|---|---|
| `flows/add-item.yaml` | Add by scan: clean read, unreadable label, scanner down (draft kept, finished by hand from Home); manual add |
| `flows/dashboard-sorted.yaml` | Four shots in one camera visit, each reviewed from Home; list sorted most-urgent-first under the right headings |
| `flows/retake.yaml` | Retake replaces its draft — from a Home draft and from the camera card — one draft, then one item; from the card it returns to the open camera, the next shot is a new item, and one Done reaches Home |
| `flows/item-detail-edit.yaml` | Item Detail shows the retained photo; editing the name keeps the item and its photo; both survive an app restart; Used it from Item Detail |
| `flows/mark-used-delete.yaml` | Row swipe: "Used it" removes; Delete asks, Cancel keeps, confirm removes |

Shared steps are in `flows/common/`: `launch-clean`, `open-camera`, `shoot`,
`close-camera`, `scan-and-save`.

Every flow starts from a cleared app (`common/launch-clean.yaml`). Not covered:
changing the date through the wheel picker (the date round trip is covered by
`scripts/item-lifecycle.test.mjs`), and the real camera, which stays a by-hand
check. Not covered because the features don't exist: barcode scanning,
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
