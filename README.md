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
src/utils/dateUtils.ts        date parsing/formatting
src/utils/statusUtils.ts      urgency ladder, sorting, card secondary line
src/components/               ItemCard, DatePickerModal, colour tokens
src/screens/                  MainListScreen, AddItemScreen, CaptureScreen
scripts/                      offline tests (no network, no key)
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
- **Persisting `dateType`** — the scan returns `use_by` / `best_before` /
  `unknown` and the Review & Save editor shows and corrects it, but `UseByItem`
  does not carry the field and it is not written to storage. The schema for it
  is Phase 3 work, and the date-aware wording that consumes it is Phase 4. Until
  then the list describes every item as "Use by", which is not yet truthful for
  a best-before item.
- **Notifications** — no `expo-notifications` dependency and no scheduler.
