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
