#!/usr/bin/env bash
#
# package.sh — Build the extension and package dist/ into a distributable ZIP.
#
# Usage:
#   ./scripts/package.sh          # builds + zips
#   ./scripts/package.sh --skip-build   # zip only (assumes dist/ is up to date)
#
# Output: trustbutverify-v<version>.zip in the project root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Read version from manifest.json
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('public/manifest.json','utf8')).version)")

SKIP_BUILD=false
if [[ "${1:-}" == "--skip-build" ]]; then
  SKIP_BUILD=true
fi

# Step 1: Build
if [ "$SKIP_BUILD" = false ]; then
  echo "▸ Building extension..."
  npm run build
  echo ""
fi

# Step 2: Verify dist/ exists
if [ ! -d "dist" ]; then
  echo "✗ dist/ directory not found. Run 'npm run build' first."
  exit 1
fi

# Step 3: Verify manifest in dist
if [ ! -f "dist/manifest.json" ]; then
  echo "✗ dist/manifest.json not found. Build may have failed."
  exit 1
fi

# Step 4: Create ZIP
ZIP_NAME="trustbutverify-v${VERSION}.zip"

# Remove old ZIP if it exists
rm -f "$ZIP_NAME"

echo "▸ Packaging dist/ → ${ZIP_NAME}..."
cd dist
zip -r "../${ZIP_NAME}" . -x "*.map" "*.DS_Store"
cd ..

# Step 5: Report
ZIP_SIZE=$(du -h "$ZIP_NAME" | cut -f1)
echo ""
echo "✓ Package created: ${ZIP_NAME} (${ZIP_SIZE})"
echo "  Ready to distribute to participants."
