#!/usr/bin/env bash
# Publishes what is on main to the preview channel, choosing between:
#
#   update  - the JS changed but the native app did not. Publish an
#             over-the-air update; phones pick it up on next open.
#   build   - the native app changed (its fingerprint is new). An update would
#             not run on the installed app, so build a new one and open a
#             GitHub issue with the install link.
#
# Writes `kind`, `group` and `message` to $GITHUB_OUTPUT for the promotion job.
set -euo pipefail

fail() { echo "::error::$1"; exit 1; }

[ -n "${EXPO_TOKEN:-}" ] || fail "The EXPO_TOKEN secret is not set, so nothing can be published. See docs/owner-checklist.md, steps 2 and 3."

SHA="${RELEASE_SHA:-$GITHUB_SHA}"
MESSAGE="$(git log -1 --format=%s) (${SHA::7})"
echo "Publishing as: $(eas whoami)"

# Without the proxy secret the app still runs but scanning quietly reports
# itself unavailable. Catch that here, not on the phone.
# (Captured first: grep -q exiting early would trip pipefail on a match.)
PREVIEW_ENV="$(eas env:list --environment preview --format short)"
if ! grep -q 'EXPO_PUBLIC_USEBY_PROXY_SECRET' <<< "$PREVIEW_ENV"; then
  fail "EXPO_PUBLIC_USEBY_PROXY_SECRET is not set for the preview environment on EAS, so scanning would not work in this release. See docs/owner-checklist.md, step 4."
fi

FINGERPRINT="$(eas fingerprint:generate -p android -e preview --environment preview --json --non-interactive | jq -r .hash)"
echo "Native fingerprint: $FINGERPRINT"

# A build counts if it is finished or on its way.
MATCHING_BUILDS="$(eas build:list -p android -e preview --fingerprint-hash "$FINGERPRINT" --json --non-interactive --limit 10 \
  | jq '[.[] | select((.status | ascii_upcase | gsub("-"; "_")) | IN("FINISHED", "IN_PROGRESS", "IN_QUEUE", "NEW"))] | length')"

if [ "$MATCHING_BUILDS" -gt 0 ]; then
  echo "An installed-app build already matches this fingerprint: publishing an update."
  eas update --channel preview --environment preview -p android \
    --message "$MESSAGE" --non-interactive --json > update.json
  GROUP="$(jq -r '.[0].group' update.json)"
  RUNTIME="$(jq -r '.[0].runtimeVersion' update.json)"

  # The update's runtime version must match a real build, or no phone will
  # ever load it. This catches the two fingerprint calculations disagreeing.
  if [ "$RUNTIME" != "$FINGERPRINT" ]; then
    fail "Published update has runtime $RUNTIME but the build check used $FINGERPRINT. Phones may not receive it. Ask Claude to investigate the fingerprint mismatch."
  fi

  echo "Published update group $GROUP."
  {
    echo "kind=update"
    echo "group=$GROUP"
    echo "message=$MESSAGE"
  } >> "$GITHUB_OUTPUT"
  {
    echo "### Update published to preview"
    echo "Open UseBy on your phone; a banner offers the new version within a moment."
    echo "- Update group: \`$GROUP\`"
    echo "- Change: $MESSAGE"
  } >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

echo "No build matches this fingerprint: the native app changed, building a new one."
eas build -p android -e preview --non-interactive --json --wait --message "$MESSAGE" > build.json
BUILD_ID="$(jq -r '.[0].id' build.json)"
APK_URL="$(jq -r '.[0].artifacts.buildUrl' build.json)"
[ -n "$APK_URL" ] && [ "$APK_URL" != "null" ] || fail "Build $BUILD_ID finished without a download link."

OWNER="$(node -p "require('./app.json').expo.owner")"
BUILD_PAGE="https://expo.dev/accounts/$OWNER/projects/useby/builds/$BUILD_ID"

gh issue create \
  --title "New UseBy app to install ($(date -u +%Y-%m-%d), ${SHA::7})" \
  --assignee "$GITHUB_REPOSITORY_OWNER" \
  --body "$(cat <<BODY
This change touched the native side of the app, so it can't arrive as an update. Install this build once, over the top of the old one.

**On your phone, tap: [Download and install UseBy]($APK_URL)**

If Android asks, allow your browser to install apps. Updates after this one arrive by themselves again.

- Change: $MESSAGE
- Build details: $BUILD_PAGE

Close this issue once it's installed.
BODY
)"

{
  echo "kind=build"
  echo "group="
  echo "message=$MESSAGE"
} >> "$GITHUB_OUTPUT"
{
  echo "### New app build for your phone"
  echo "[Install link]($APK_URL), also sent as a GitHub issue."
} >> "$GITHUB_STEP_SUMMARY"
