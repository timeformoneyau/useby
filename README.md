# UseBy

Android-first Expo / React Native app for tracking food use-by dates. Whatever
needs eating soonest sits at the top of the list.

## Status

Phase 2 — local storage, plus one network call. Items live on the device in
AsyncStorage and there is still no account and no sign-in. The single outbound
call is the camera scan: a photo goes to UseBy's own proxy, which calls the
Anthropic API and returns the item name, date and date type for you to review
before saving. Nothing is uploaded unless you take a photo, and the proxy keeps
nothing — the image lives only for the length of the request.

## Requirements

- Node 20+
- An Expo account (for EAS builds)
- Android device or emulator

## Getting started

```bash
npm install
npm start          # then press 'a' for Android
npm run android    # or build and run a dev client directly
npm run typecheck
npm test           # offline: scan response mapping. No network, no key needed.
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

## Remaining setup: link the EAS project

This has **not** been run yet — it needs an interactive login to your Expo
account, which the environment this was scaffolded in did not have:

```bash
npx eas-cli login
npx eas-cli init
```

`eas init` creates the project on your account and writes
`expo.extra.eas.projectId` into `app.json`. `eas.json` is already committed
with development / preview / production profiles; the preview profile builds
an APK for sideloading onto a device.

After that:

```bash
npx eas-cli build --platform android --profile preview
```

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
scripts/                      offline tests (no network, no key)
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
