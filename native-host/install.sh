#!/bin/sh
# Register the Keychain native messaging host for the PowerTrack Assistant extension.
# Usage: ./install.sh <extension-id> [edge|chrome]   (default: edge)
set -eu

EXT_ID="${1:?usage: $0 <extension-id> [edge|chrome]}"
BROWSER="${2:-edge}"
case "$EXT_ID" in *[!a-p]*|"") echo "invalid extension id: $EXT_ID" >&2; exit 1 ;; esac
[ "${#EXT_ID}" -eq 32 ] || { echo "extension id must be 32 characters" >&2; exit 1; }

case "$BROWSER" in
  edge) DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
  chrome) DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  *) echo "browser must be edge or chrome" >&2; exit 1 ;;
esac

NAME="com.dsd_hamsa.powertrack_keychain"
HOST="$(cd "$(dirname "$0")" && pwd)/powertrack_keychain_host.py"
chmod +x "$HOST"
mkdir -p "$DIR"
cat > "$DIR/$NAME.json" <<EOF
{
  "name": "$NAME",
  "description": "Save the PowerTrack session to the macOS Keychain",
  "path": "$HOST",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
echo "Registered $NAME for $BROWSER -> $HOST"
