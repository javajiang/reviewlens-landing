#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/reviewlens-scraper-test"
CRAWLER_SOURCE="$ROOT_DIR/reviewlens-extension/content.js"
OUTPUT="$ROOT_DIR/reviewlens-scraper-test.zip"
STAGING_DIR="$(mktemp -d /tmp/reviewlens-scraper-test.XXXXXX)"
ARCHIVE="$STAGING_DIR/reviewlens-scraper-test.zip"

cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

if [[ ! -f "$CRAWLER_SOURCE" ]]; then
  echo "Missing production crawler: $CRAWLER_SOURCE" >&2
  exit 1
fi

cp "$SOURCE_DIR/manifest.json" "$STAGING_DIR/"
cp "$SOURCE_DIR/background.js" "$STAGING_DIR/"
cp "$SOURCE_DIR/popup.html" "$STAGING_DIR/"
cp "$SOURCE_DIR/popup.css" "$STAGING_DIR/"
cp "$SOURCE_DIR/popup.js" "$STAGING_DIR/"
cp "$SOURCE_DIR/README.md" "$STAGING_DIR/"
cp "$CRAWLER_SOURCE" "$STAGING_DIR/content.js"

(
  cd "$STAGING_DIR"
  7z a -tzip -mx=9 "$ARCHIVE" README.md background.js content.js manifest.json popup.css popup.html popup.js >/dev/null
)

7z t "$ARCHIVE" >/dev/null
mv "$ARCHIVE" "$OUTPUT"
echo "Built $OUTPUT"
sha256sum "$OUTPUT"
