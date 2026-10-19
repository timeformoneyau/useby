# UseBy — working notes

## Build Log

After **every push** to this repo, post a summary entry to the Confluence Build Log:

https://oathley.atlassian.net/wiki/spaces/UseBy/pages/2785672/Build+Log

Conventions, set on the page itself:

- Newest entry at the top.
- One entry per push: an `<h2>` date heading, a one-line summary of what
  changed, then a few bullets if it's more than one thing.
- Dates are the owner's local date (AEST, UTC+10) — not UTC.
- Write it for someone who wasn't watching the work: what landed, what's
  verified, anything blocked on them, and what was deliberately deferred.
- Reference the branch and commit so an entry can be traced back to the code.

Use the Atlassian MCP tools (`getConfluencePage` / `updateConfluencePage`,
cloudId `oathley.atlassian.net`, pageId `2785672`). Read the page first and
preserve the existing entries — prepend, never overwrite.

## Project

Expo SDK 54, Android-first. See README.md for the port history from
`timeformoneyau/since-fresh`, what was stripped, and what's deferred.

## Standard for every change

Pushing to `main` publishes to the owner's phone (see README "How releases
work"), so every change follows this, without being asked:

1. **Work on a `claude/…` branch.** Never push to `main` directly.
2. **Include or update the tests that cover the change.**
   - Logic: a `node:test` file in `scripts/*.test.mjs`. Keep testable code
     free of React Native imports so these can load it.
   - Anything a person taps through: a Maestro flow in `e2e/flows/`.
   - A change to the proxy contract: update `e2e/app/scenarios.ts` too.
     `scripts/e2e-scenarios.test.mjs` fails if they disagree.
3. **Run `npm run verify` and get it green before pushing.** If you touched
   `metro.config.js`, `index.ts`, `app.config.js` or `e2e/app/`, also run
   `node scripts/check-bundle-isolation.mjs`.
4. **Push, open a PR, enable auto-merge** (`gh pr merge --auto --squash`).
   CI's `checks` and `flow-tests` gate the merge; `release.yml` publishes.
5. **Watch the CI run to the end.** Fix failures before calling the work
   done, and report failures honestly, with the log, if you can't.
6. **Production is the owner's call.** Never promote to production, change
   the production EAS environment, or (once Supabase lands) touch production
   data or schema without asking first. Supabase schema changes will be
   migration files applied by CI, with production gated the same way.
7. **No shared dependencies with Minded.** Copy code; don't share packages.

Never commit secrets. `.env*` (except `.env.example`, names only), keystores
and credential files are gitignored and CI fails on them; tokens live in
GitHub secrets or EAS environment variables.

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
