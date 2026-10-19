#!/usr/bin/env bash
# Republishes the exact update that preview received onto the production
# channel. Same bundle, byte for byte: nothing is rebuilt. Runs only after
# you approve the `production` environment in GitHub.
set -euo pipefail

: "${GROUP:?update group to promote}"
: "${MESSAGE:?release message}"

# Approving an old request after a newer release would move production
# backwards. Only the newest preview update may be promoted.
LATEST="$(eas update:list --branch preview -p android --json --non-interactive --limit 1 | jq -r '.currentPage[0].group')"
if [ "$LATEST" != "$GROUP" ]; then
  echo "::warning::Skipped. A newer preview update ($LATEST) exists; approve that release instead."
  echo "Skipped: a newer preview update exists. Approve the newest one." >> "$GITHUB_STEP_SUMMARY"
  exit 0
fi

eas channel:view production --json --non-interactive > /dev/null 2>&1 \
  || eas channel:create production --non-interactive

eas update:republish --group "$GROUP" --destination-channel production \
  --message "Promoted from preview: $MESSAGE" --non-interactive

echo "### Promoted to production" >> "$GITHUB_STEP_SUMMARY"
echo "Update group \`$GROUP\` ($MESSAGE)." >> "$GITHUB_STEP_SUMMARY"
