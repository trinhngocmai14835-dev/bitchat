#!/bin/sh

set -eu

# Xcode Cloud runs this after cloning the repository. The generated config is
# ignored by Git and keeps account-specific signing identifiers out of source.
team_id="${BITCHAT_TEAM_ID:-}"
bundle_suffix="${BITCHAT_BUNDLE_SUFFIX:-$team_id}"

if [ -z "$team_id" ]; then
    if [ "${CI_XCODE_CLOUD:-}" = "TRUE" ]; then
        echo "BITCHAT_TEAM_ID must be set in the Xcode Cloud workflow environment."
        exit 1
    fi
    echo "BITCHAT_TEAM_ID is not set; leaving local signing configuration unchanged."
    exit 0
fi

case "$team_id" in
    *[!A-Za-z0-9]*)
        echo "BITCHAT_TEAM_ID may contain only letters and numbers."
        exit 1
        ;;
esac

case "$bundle_suffix" in
    ""|*[!A-Za-z0-9.-]*)
        echo "BITCHAT_BUNDLE_SUFFIX may contain only letters, numbers, dots, and hyphens."
        exit 1
        ;;
esac

cat > Configs/Local.xcconfig <<EOF
DEVELOPMENT_TEAM = $team_id
PRODUCT_BUNDLE_IDENTIFIER = chat.bitchat.$bundle_suffix
APP_GROUP_ID = group.chat.bitchat.$bundle_suffix
EOF

echo "Generated Configs/Local.xcconfig for Xcode Cloud team $team_id."
