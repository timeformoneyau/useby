# UseBy

Android-first Expo / React Native app for tracking food use-by dates. Whatever
needs eating soonest sits at the top of the list.

## Status

Phase 3A — local storage, plus one network call. Items live on the device in
AsyncStorage and there is still no account and no sign-in. The single outbound
call is the camera scan: a photo goes to UseBy's own proxy, which calls the
Anthropic API and returns the item name, date and date type for you to review
before saving. Nothing is uploaded unless you take a photo, and the proxy keeps
nothing — the image lives only for the length of the request.

## Requirements

- Node 22.6+ (`.nvmrc` pins 22; the test runner needs Node's type stripping)
- An Expo account (for EAS builds)
- Android device or emulator

## Getting started

```bash
npm install
npm start          # then press 'a' for Android
npm run android    # or build and run a dev client directly
npm run typecheck
npm run lint
npm test           # offline unit tests. No network, no key needed.
npm run verify     # everything CI's quick checks run, in one go
```

## Scanning: pointing the app at the proxy

Capture posts the photo to UseBy's own proxy (`timeformoneyau/usebyproxy`),
which calls the Anthropic API and returns the item name, date and date type.
Two environment variables configure it — copy `.env.example` to `.env` for local
work, and set them on the EAS build profile for a real build:

| Variable | Required | Purpose |
|---|---|---|
| `EXPO_PUBLIC_USEBY_PROXY_URL` | No | Proxy origin. Falls back to the production deployment. Point it at a preview deployment to test one. |
| `EXPO_PUBLIC_USEBY_PROXY_SECRET` | For scanning | The proxy's `MOBILE_APP_SECRET`, sent as `Authorization: Bearer`. |

Neither is committed. `.env` is gitignored; only `.env.example`, which holds
names and no values, is in the repo.

### The secret is a deployment guard, not authentication

`EXPO_PUBLIC_` is Expo's marker for "inlined into the bundle at build time and
readable by anyone holding the binary", and that is exactly what this value is.
The prefix is deliberate: it keeps the caveat visible at the point of use.

Its only job is stopping the deployment sitting open to anyone who guesses the
URL and quietly running up the Anthropic bill. It does not identify a user,
cannot be revoked per device, and rotating it means shipping a new build. Once
real per-user sessions exist it is replaced — not supplemented — by a validated
session token.

Without it the app still runs: scanning reports itself as unavailable and the
user goes straight to manual entry.

**Local gotcha:** Metro caches the transform that inlines these values, so
changing `.env` may not take effect until you clear the cache
(`npx expo start --clear`). EAS builds start clean, so this only bites local
iteration.

### Diagnosing a scan

The screen tells the user one plain sentence and nothing more — no status
codes, no confidence readouts. That is the accepted design and it stays. During
device testing, though, the person holding the phone is also the person
diagnosing it, so each scan writes one line to the Android log instead:

```bash
adb logcat -s ReactNativeJS | grep useby.scan
```

Every scan is named at the shutter and writes two lines — one for the capture,
one for the round trip — both carrying the same `scanId`:

```
useby.scan {"scanId":"p-mfk2j8x1-4b7c9","stage":"capture","outcome":"ok",
            "shot":{"w":3000,"h":4000},"sent":{"w":1200,"h":1600},"kb":287}
useby.scan {"scanId":"p-mfk2j8x1-4b7c9","stage":"request","totalMs":4820,
            "captureMs":310,"resizeMs":240,"requestMs":4210,"serverMs":3990,
            "overheadMs":220,"modelMs":3550,"kb":287,"outcome":"ok","status":200,
            "read":"name-only","dropped":[],"type":"unknown","idEchoed":true}
```

**Where a slow scan spent its time.** The `request` line accounts for the whole
wait, so `grep useby.scan` answers it without opening Vercel:

| Field | What it covers |
|---|---|
| `totalMs` | Shutter to result — the wait the person actually sat through |
| `captureMs` | `takePictureAsync`: the shutter and the file write |
| `resizeMs` | `manipulateAsync`: resize, JPEG re-encode, base64 encode |
| `requestMs` | The whole `fetch` |
| `serverMs` | What the proxy says it spent, from its response header |
| `overheadMs` | `requestMs − serverMs` — upload, TLS, Vercel routing, response transfer |
| `modelMs` | The Anthropic call, from the proxy's header |

Upload and download are **not** separated: React Native's `fetch` exposes no
transfer timings, so `overheadMs` is one honest aggregate rather than an
invented split. `serverMs`, `overheadMs` and `modelMs` are absent when the proxy
did not report them — better silence than a fabricated number.

**`scanId` is the whole point.** The app sends it to the proxy in an
`X-UseBy-Scan-Id` header, the proxy adopts it as its own log id and echoes it
back, so one scan is one identifiable thing on both sides of the wire. Matching
a phone log line to a server log line never depends on comparing timestamps.
The id begins with a base-36 timestamp, so ids sort by time — which is what
turns "it failed about an hour ago" into a bounded search.

| Field | What it tells you |
|---|---|
| `stage` | `capture` (camera → resized JPEG) or `request` (the round trip) |
| `outcome` | `ok`, or why it stopped: `capture-failed`, `network`, `timeout`, `server`, `unreadable`, `malformed`, `unauthorized`, `too-large`, `rejected`, `not-configured` |
| `read` | On a `200`: `both`, `name-only`, `date-only`, `neither` |
| `dropped` | Fields the server sent that this build then refused. Should always be empty; anything here means the two deployments disagree |
| `at` | On `capture-failed`: `camera`, `resize` or `encode`. On `malformed`: `json` or `contract` |
| `code` | The proxy's own failure category, on a failure |
| `reachedProxy` | Present and `false` when the request never left the phone's network — expect **no** server line for that `scanId` |
| `idEchoed` | Whether the proxy echoed the same id back |
| `shot` / `sent` | What the camera produced, and what was actually uploaded |

**A `200` is not the same as a useful read.** The model can return nulls for
both fields and still succeed, so `"outcome":"ok","read":"neither"` is the line
that means "the pipeline works and the photo defeated it" — a completely
different problem from any failure.

Nothing secret goes into these lines: not the bearer token, not the image, not
the error object — which in some runtimes stringifies the request that produced
it, headers included — and not the item name the model read, which is the
contents of someone's fridge.

The matching server-side line is in the proxy's Vercel log, one JSON entry per
request under `"evt":"parse-expiry"`, carrying the same `scanId` as `id`. Between
the two, a failed scan can be placed at capture, transport, upstream, parsing,
validation or the model itself.

## How releases work

*Written for the product owner. No setup knowledge assumed.*

**The short version:** a change is tested automatically, then turns up on
your phone by itself. You try it, and if you're happy you tap Approve in the
GitHub app to send the same version to production.

**Step by step**

1. **A change is made on a side copy of the code** (a *branch*) and proposed
   as a *pull request*. Nothing reaches your phone at this point.
2. **GitHub tests it automatically**, in two stages:
   - *Quick checks* (about 2 minutes): no passwords or keys accidentally
     included, no code errors, the logic tests pass, and the test-only code
     is definitely not in the real app.
   - *Flow tests* (about 12–15 minutes): a simulated Android phone in the cloud
     opens the app and adds items by "scanning", checks the list is in the
     right order, and marks items used and deleted.
3. **If anything fails, it stops there.** Nothing is published. The failure
   is fixed and the change is tested again.
4. **When everything passes, the change merges into `main` and is published
   to the `preview` channel** (the version your phone runs). One of two
   things happens:
   - *Most changes:* an **update** is published. Next time you open UseBy, a
     banner says **"New version ready — tap to restart"**. Tap it.
   - *Occasionally* (a new phone feature, a camera setting, a new native
     package): the change can't travel as an update, so a **new app is
     built**. A GitHub issue titled *"New UseBy app to install"* appears with
     a download link. Tap it on your phone and install over the top.
5. **Promotion to production waits for you.** GitHub sends a push
   notification ("review deployment"). Approve it in the GitHub mobile app
   and the *exact same* update goes to the `production` channel, unchanged,
   not rebuilt. If you approve an old request after a newer release, it is
   skipped so production never goes backwards. A request left alone expires
   after 30 days and costs nothing.

**If something goes wrong**

- *A bad update reached your phone:* say "roll back" to Claude, or in GitHub
  go to Actions → Rollback → Run workflow. The previous version goes out as
  an update within a few minutes.
- *How you'd know something is broken:* GitHub emails you (and notifies the
  GitHub app) when a test run or release fails. A red cross on the pull
  request means it stopped before your phone. A *"Real scan check"* failure
  means the live scanner (the proxy or Claude) read the test label wrong or
  didn't answer.

**What the automated tests do not cover** (these still need your phone)

- The real camera: focus, lighting, glare, a crumpled label.
- How well Claude reads real packaging. The weekly *Real scan check* sends
  one clean test label through the live scanner, but real fridges are messier.
- Feel, speed and layout on your particular phone.
- Push notifications and anything Supabase, once they exist.

**What it costs**

| | Cost | Where the limit bites |
|---|---|---|
| GitHub Actions (all testing) | Free: the repo is public | No minute limit on standard runners |
| EAS Update (over-the-air updates) | Free plan | Covers ~1,000 monthly users |
| EAS Build (new app installs) | Free plan, ~15 Android builds a month | Builds queue at busy times (minutes to an hour or more). Only native changes use one |
| Real scan check | About a cent or less per run | Capped at 8 runs per 30 days |
| Flow tests | Free | They never call the real scanner |

**Settings that live outside the code**

- The scanner's key is stored on EAS as `EXPO_PUBLIC_USEBY_PROXY_SECRET` for
  the `preview` and `production` environments, never in this repo. A release
  refuses to publish if it's missing from preview.
- A production promotion reuses the preview update unchanged, including the
  preview scanner settings baked into it. Keep the two EAS environments'
  scanner values the same.
- The GitHub token for Expo is the `EXPO_TOKEN` repository secret.

The one-off setup steps are in [`docs/owner-checklist.md`](docs/owner-checklist.md).

### For whoever changes the code

- `runtimeVersion` uses Expo's **fingerprint** policy. `.github/scripts/publish-preview.sh`
  computes the native fingerprint, looks for an EAS build with that
  fingerprint, and either publishes an update or starts a build. It fails the
  release if the published update's runtime version differs from the
  fingerprint it checked, because that would mean phones silently never get it.
- Flow tests run against a separate build with test mode compiled in. See
  [`e2e/README.md`](e2e/README.md).
- Every change ships with its tests: unit tests in `scripts/*.test.mjs` for
  logic, a Maestro flow in `e2e/flows/` for anything a person taps through.
  Run `npm run verify` before pushing.

## Layout

```
App.tsx                       navigation container (3 screens)
src/types/                    UseByItem, scan contract, status labels, nav params
src/config/proxy.ts           deployed proxy URL + deployment guard, from env
src/domain/items/             service (the only entry point for mutations),
                              AsyncStorage persistence, derived fields
src/domain/scan/              parse-expiry client + pure response→prefill mapping
src/theme/                    design tokens: colour, type, spacing, radii
src/utils/dateUtils.ts        date parsing/formatting
src/utils/statusUtils.ts      urgency ladder and sorting (five bands)
src/domain/items/presentation.ts  how an item reads: four visible groups, row copy
src/components/               ItemCard (the row), DatePickerModal
src/screens/                  MainListScreen, AddItemScreen, CaptureScreen
src/components/UpdateBanner.tsx  "New version ready" prompt (expo-updates)
src/testing/e2eHook.ts        empty in real builds; test mode attaches here
scripts/                      offline tests (no network, no key) and CI checks
e2e/                          flow-test mode, fixtures and Maestro flows
.github/workflows/            ci, release, rollback, real-scan
```

Screens never touch storage directly — all mutations go through
`src/domain/items/service.ts`.

## Urgency model

An item is a name, a use-by date, and what the packaging called that date. The
date drives everything.

**Sorting** uses the five-band ladder in `statusUtils.ts` — Fresh, Use soon, Use
today, Past use by, Well past — most-urgent-first, ties broken by the date and
then by name.

**Display** groups more coarsely, into the four headings in `presentation.ts`:

| Days remaining   | Group            | Row reads      |
|------------------|------------------|----------------|
| more than 3      | Later            | `5 days left`  |
| 1 to 3           | Use soon         | `2 days left`  |
| 0                | Today            | `Today`        |
| any amount past  | Past their date  | `Past by 9 days` |

The two are deliberately different. There is no separate "Well past" heading —
the row itself carries the exact distance, so nothing is lost by showing one
past group, and the finer bands stay available for anything that needs them
later.

## Design

The visual direction is "Warm Home Utility", from the Claude Design v3 artboard.
Time left is the headline, the item name is the subject, and the calendar date
is a footnote. Sage carries everything UseBy *does* — scan, save, focus — so the
accent reads as the brand rather than as a status; terracotta appears only on
today and overdue items. Tokens live in `src/theme/`, with each colour's
original `oklch()` value kept in a comment beside its hex so it can be checked
against the artboard.

Two deliberate departures from the artboard:

- **Rows keep their swipe actions.** The artboard taps a row through to an Item
  Detail screen carrying Used / Threw it out / Delete. That screen is later
  work, so removal stays on the swipe, widened to offer Used alongside Delete.
  Without it there would be no way to take anything off the list.
- **The date field opens the native picker** rather than parsing free text. The
  artboard's text input is a prototype convenience; the wheel is less friction
  on a phone and cannot produce an unparseable value.

## What was ported from since-fresh

Copied from `timeformoneyau/since-fresh` (`consolidation` branch), not shared
as a dependency — this repo owns its copies outright and they can diverge
freely.

- **The single "+" Add flow** — `AddItemScreen`
- **The urgency-sorted list** — `MainListScreen` + `ItemCard` + `statusUtils`
- **The camera capture screen** — `CaptureScreen` (was `ScanFoodScreen`)

Supporting pieces came along because the three above depend on them:
`DatePickerModal`, the colour tokens, `dateUtils`, and the
storage/service/derive layer.

### Stripped on the way in

since-fresh tracked recurring life admin (dentist, air filter, smoke alarm)
and treated food expiry as a second mode layered on top. UseBy only does the
food half, so the life-admin half is gone:

- **Categories** — the `category` field, `DEFAULT_CATEGORIES`, the
  `CategoryPicker` component, and the per-category `SectionList` grouping on
  the list screen. The list is now flat and purely urgency-ordered.
- **Repeat intervals** — `repeatValue` / `repeatUnit` / `RepeatUnit`, the
  unit picker in the Add form, and the interval-derived "coming up" threshold.
  A use-by date is a one-shot date, not a cadence.
- **Completion history** — `history` / `CompletionEvent`, `markItemDone`'s
  cycle-restart behaviour, and the Detail (history) screen. Food is eaten
  once; there is no log to accumulate.
- **Chore-flavoured status labels** — "It's been a while", "Long overdue" and
  friends, replaced by the expiry ladder above.
- **Quick-start suggestions** — the "Dentist / Tyre rotation / Air filter"
  chips and `suggestions.ts`, which guessed a repeat cadence from an item's
  name.

### Deliberately not wired up yet

These are a later phase, once the accounts exist:

- **Supabase** — auth screens, cloud storage, the sync engine and queue.
  App runs local-only with no sign-in step.
- **Item Detail / Edit** — the fourth screen in the accepted architecture. Used
  and Wasted belong there as explicit actions, but recording which of the two
  happened needs the Phase 3 data layer, so the screen waits for it. Removal is
  on the row's swipe until then.
- **Syncing `dateType`** — it is captured at scan time, correctable in the
  editor and persisted locally, so the list describes a best-before item
  honestly. Carrying it to other devices is part of the Phase 3 schema.
- **Notifications** — no `expo-notifications` dependency and no scheduler.
