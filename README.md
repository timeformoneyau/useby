# UseBy

Android-first Expo / React Native app for tracking food use-by dates. Whatever
needs eating soonest sits at the top of the list.

## Status

Phase 1 — local only. Everything is stored on the device with AsyncStorage.
There is no account, no sign-in, and no network call anywhere in the app.

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
```

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
src/types/                    UseByItem, status labels, nav param list
src/domain/items/             service (the only entry point for mutations),
                              AsyncStorage persistence, derived fields
src/utils/dateUtils.ts        date parsing/formatting
src/utils/statusUtils.ts      urgency ladder, sorting, card secondary line
src/components/               ItemCard, DatePickerModal, colour tokens
src/screens/                  MainListScreen, AddItemScreen, CaptureScreen
```

Screens never touch storage directly — all mutations go through
`src/domain/items/service.ts`.

## Urgency model

An item is just a name plus a use-by date. The date drives everything:

| Days remaining | Label       |
|----------------|-------------|
| more than 3    | Fresh       |
| 1 to 3         | Use soon    |
| 0              | Use today   |
| 1 to 7 past    | Past use by |
| more than 7 past | Well past |

The list is sorted most-urgent-first, ties broken by the date itself and then
by name.

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
- **The parse proxy + Anthropic** — capture currently ends at a resized JPEG
  and hands you to the Add screen to type the name and date yourself. The
  permission, capture and resize pipeline is intact; the marked seam in
  `CaptureScreen.handleCapture()` is where the parse call plugs in.
- **Notifications** — no `expo-notifications` dependency and no scheduler.
