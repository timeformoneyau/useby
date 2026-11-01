# UseBy — working notes

## Build Log

Record meaningful implementation work in the Confluence Build Log:

https://oathley.atlassian.net/wiki/spaces/UseBy/pages/2785672/Build+Log

The Build Log parent page is a stable index and logging contract. **Do not append
entries to it and do not rewrite historical build records.**

For each meaningful implementation task, completed work package, or spike,
create a **new child page beneath pageId `2785672`** titled:

`YYYY-MM-DD — concise summary`

Conventions, set on the page itself:

- A work package may contain several commits. Do not create separate child
  pages for trivial housekeeping, tiny follow-up commits, or mechanical fixes
  that belong to the same work package.
- Dates are the owner's local date in `Australia/Adelaide` — not UTC.
- Write it for someone who wasn't watching the work: what landed, the key
  implementation decisions, what's verified versus unverified, meaningful
  issues or deviations, current status, anything blocked on the owner, and
  what was deliberately deferred.
- Reference the repository, branch and commit(s) so the entry can be traced
  back to the code.
- Keep detail proportional to the work. Do not pad a small change to fill a
  template.
- Once written, historical build-entry child pages are immutable. Corrections
  or follow-up implementation go in a new child page and may link back to the
  earlier entry.

Use the Atlassian MCP page-creation tool to create the child page under
pageId `2785672` in the UseBy space. **Do not read and re-emit the parent Build
Log page as part of ordinary logging.** The archived 24–26 August history is
read-only and must remain untouched unless explicitly instructed.

This replaces the original "one `<h2>` entry per push, prepended to the parent
page" convention, which is obsolete. If a branch still carries that older
wording in this file, follow this version and the parent page, not it.

## Build Plan

The compact execution brief is the Confluence **Build Plan** (pageId
`2752798`). It records which branch carries the current app, what is awaiting
review or device validation, and the locked product decisions. **`main` is not
necessarily the current app** — check the Build Plan's status table before
assuming a feature is or is not built. Read only the sections a task needs.

## Project

Expo SDK 54, Android-first. See README.md for the port history from
`timeformoneyau/since-fresh`, what was stripped, and what's deferred.

## Tests

`npm test` runs every `scripts/*.test.mjs` with `node:test`, offline.

- Modules with no value imports (`pending.ts`, `photos.ts`, `edit.ts`,
  `saveScan.ts`, `trust.ts`, …) load directly under Node's type stripping.
- Modules that reach AsyncStorage or `expo-file-system` (`service.ts`,
  `storage.ts`, `photoStore.ts`, and `statusUtils.ts` through its
  extensionless imports) are loaded through `scripts/support/app-loader.mjs`,
  which compiles them with TypeScript and swaps those two native modules for
  the in-memory fakes in `scripts/support/fakes.mjs`. Register it at the top
  of the test file; see `scripts/item-lifecycle.test.mjs`. No app code is
  stubbed beyond those two modules.
- A `{ todo }` test documents a known gap that is deliberately not fixed yet.
  It reports but does not fail. Do not convert one to a skip or delete it to
  get green; fix the gap or leave it.

## Commit author identity — set this before committing

```bash
git config --local user.name  "timeformoneyau"
git config --local user.email "180406668+timeformoneyau@users.noreply.github.com"
```

That is the GitHub account that owns this repository. The sandbox default is
`Claude <noreply@anthropic.com>`, which maps to no GitHub account at all, and
local git config does not survive a fresh clone — so set it explicitly at the
start of any session that will commit.

This matters most in the sibling repo `timeformoneyau/usebyproxy`, where a
wrong author causes **Vercel to block the production deployment outright**: it
is private, the Vercel project is on the Hobby plan, and Hobby will not deploy
a commit authored by anyone but the project owner. Commit `dadfd11` there was
blocked for exactly this reason. Nothing in this repo deploys automatically, so
the consequence here is only misattributed history — but keep the two repos
consistent.
