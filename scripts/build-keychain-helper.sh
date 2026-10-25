#!/usr/bin/env bash
# Builds the helper with its stable local signing identity. On the login keychain,
# adding code-signing trust can prompt once for the login password.
set -euo pipefail

out="native/keychain-helper/build/qlb-keychain-helper"
src="native/keychain-helper/main.swift"
identity="QLB Keychain Helper"
keychain="${QLB_HELPER_KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
tmp="$(mktemp -d)"
# The PKCS#12 passphrase protects this short-lived export. `security import -P`
# accepts only argv, so this single-use throwaway value necessarily reaches argv there.
p12_pass="$(/usr/bin/openssl rand -hex 32)"
cleanup() {
  unset p12_pass QLB_HELPER_P12_PASS
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$out")" "$HOME/.qlb/helper-prev"
has_identity=false
if security find-identity -p codesigning "$keychain" 2>/dev/null | grep -Fq "$identity"; then
  has_identity=true
fi

if [ "$has_identity" != true ]; then
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -subj "/CN=$identity/" -addext "extendedKeyUsage=codeSigning" -days 3650
  export QLB_HELPER_P12_PASS="$p12_pass"
  /usr/bin/openssl pkcs12 -export -out "$tmp/identity.p12" \
    -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -passout env:QLB_HELPER_P12_PASS
  security import "$tmp/identity.p12" -k "$keychain" -P "$p12_pass" -T /usr/bin/codesign
  security add-trusted-cert -p codeSign -k "$keychain" "$tmp/cert.pem"
fi

candidate="$tmp/qlb-keychain-helper"
/usr/bin/swiftc "$src" -o "$candidate"
if ! codesign --force --sign "$identity" --timestamp=none "$candidate"; then
  echo "qlb-keychain-helper: signing failed; the '$identity' identity may not be trusted for code signing in $keychain" >&2
  exit 1
fi
codesign --verify --strict "$candidate"
codesign -dv "$candidate" >/dev/null 2>&1

# Do not replace the known-good helper until the candidate is signed and verified.
if [ -x "$out" ]; then
  cp "$out" "$HOME/.qlb/helper-prev/qlb-keychain-helper"
fi
mv "$candidate" "$out"
