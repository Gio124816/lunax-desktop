#!/bin/bash
set -e

# ── CONFIG ────────────────────────────────────────────────────────────────────
APP="dist/mac-arm64/Luna X.app"
APP_ID="com.lunaxmedia.lunax"
TEAM_ID="87KZ2U9V6Y"
APP_CERT="3rd Party Mac Developer Application: Giovanni Vargas (87KZ2U9V6Y)"
PKG_CERT="3rd Party Mac Developer Installer: Giovanni Vargas (87KZ2U9V6Y)"
PROVISION="build/Luna_X_Mac_App_Store.provisionprofile"
ENTITLEMENTS="build/entitlements.mas.plist"
ENTITLEMENTS_INHERIT="build/entitlements.mas.inherit.plist"
OUTPUT_PKG="dist/Luna X.pkg"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Luna X — MAS Sign & Package"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── STEP 1: Embed provisioning profile ───────────────────────────────────────
echo ""
echo "▶ Step 1: Embedding provisioning profile..."
cp "$PROVISION" "$APP/Contents/embedded.provisionprofile"
echo "  ✓ Profile embedded"

# ── STEP 2: Strip existing signatures from all helpers ───────────────────────
echo ""
echo "▶ Step 2: Stripping existing signatures..."

strip_signatures() {
  local target="$1"
  if [ -f "$target" ] || [ -d "$target" ]; then
    codesign --remove-signature "$target" 2>/dev/null || true
    xattr -cr "$target" 2>/dev/null || true
  fi
}

# Strip Login Helper
HELPER="$APP/Contents/Library/LoginItems/Luna X Login Helper.app"
if [ -d "$HELPER" ]; then
  strip_signatures "$HELPER/Contents/MacOS/Luna X Login Helper"
  strip_signatures "$HELPER"
  ditto --norsrc --noextattr --noqtn "$HELPER" /tmp/lunax_helper_clean.app
  rm -rf "$HELPER"
  mv /tmp/lunax_helper_clean.app "$HELPER"
  echo "  ✓ Login Helper cleaned"
fi

# Strip all framework helpers
for helper_app in "$APP/Contents/Frameworks/"*.app; do
  [ -d "$helper_app" ] || continue
  bin="$helper_app/Contents/MacOS/$(basename "$helper_app" .app)"
  strip_signatures "$bin" 2>/dev/null || true
  strip_signatures "$helper_app" 2>/dev/null || true
  echo "  ✓ Stripped: $(basename "$helper_app")"
done

# Strip main frameworks
for framework in "$APP/Contents/Frameworks/"*.framework; do
  [ -d "$framework" ] || continue
  codesign --remove-signature "$framework" 2>/dev/null || true
  echo "  ✓ Stripped: $(basename "$framework")"
done

strip_signatures "$APP"
echo "  ✓ Main app stripped"

# ── STEP 3: Sign helpers (inside-out) ────────────────────────────────────────
echo ""
echo "▶ Step 3: Signing helpers (inside-out)..."

sign_binary() {
  local target="$1"
  local ents="$2"
  codesign \
    --sign "$APP_CERT" \
    --force \
    --timestamp \
    --options runtime \
    --entitlements "$ents" \
    "$target"
}

# Sign Login Helper binary first, then the .app
if [ -d "$HELPER" ]; then
  HELPER_BIN="$HELPER/Contents/MacOS/Luna X Login Helper"
  sign_binary "$HELPER_BIN" "$ENTITLEMENTS_INHERIT"
  sign_binary "$HELPER" "$ENTITLEMENTS_INHERIT"
  echo "  ✓ Login Helper signed"
fi

# Sign Electron framework helpers
for helper_app in "$APP/Contents/Frameworks/"*.app; do
  [ -d "$helper_app" ] || continue
  bin="$helper_app/Contents/MacOS/$(basename "$helper_app" .app)"
  [ -f "$bin" ] && sign_binary "$bin" "$ENTITLEMENTS_INHERIT"
  sign_binary "$helper_app" "$ENTITLEMENTS_INHERIT"
  echo "  ✓ Signed: $(basename "$helper_app")"
done

# Sign frameworks
for framework in "$APP/Contents/Frameworks/"*.framework/Versions/A; do
  [ -d "$framework" ] || continue
  codesign \
    --sign "$APP_CERT" \
    --force \
    --timestamp \
    --entitlements "$ENTITLEMENTS_INHERIT" \
    "$framework"
  echo "  ✓ Signed: $(basename "$(dirname "$(dirname "$framework")")")"
done

# ── STEP 4: Sign main app ─────────────────────────────────────────────────────
echo ""
echo "▶ Step 4: Signing main app..."
codesign \
  --sign "$APP_CERT" \
  --force \
  --timestamp \
  --options runtime \
  --entitlements "$ENTITLEMENTS" \
  --deep \
  "$APP"
echo "  ✓ Main app signed"

# ── STEP 5: Verify ───────────────────────────────────────────────────────────
echo ""
echo "▶ Step 5: Verifying signature..."
codesign --verify --deep --strict "$APP"
echo "  ✓ Signature valid"

# ── STEP 6: Package ──────────────────────────────────────────────────────────
echo ""
echo "▶ Step 6: Creating .pkg for App Store..."
productbuild \
  --component "$APP" /Applications \
  --sign "$PKG_CERT" \
  "$OUTPUT_PKG"
echo "  ✓ Package created: $OUTPUT_PKG"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ Done! Upload dist/Luna X.pkg to App Store Connect"
echo "     using Transporter (free on Mac App Store)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
