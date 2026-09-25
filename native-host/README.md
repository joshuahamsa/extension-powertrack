# Keychain native host

Saves the PowerTrack session captured by the extension to the macOS Keychain, so
scripts can use it without copying the cookie by hand.

- Items: `powertrack-cookie`, `powertrack-ae-s` and `powertrack-ae-v` (account `powertrack`).
- The extension sends only those three values, once they stop changing for 2 seconds.
- Values are never logged. They are passed to `security` as an argument, because
  its stdin paths truncate the ~4 KB cookie (see the host's docstring).
- Status lines (no values) go to `~/Library/Logs/powertrack_keychain_host.log`.

## Install

```bash
./install.sh <extension-id> edge     # or: chrome
```

Get the ID from `edge://extensions` (Developer mode on), then reload the
extension. Open any PowerTrack page and the Keychain items update within seconds.

## Read the session

```bash
security find-generic-password -s powertrack-cookie -w
```

## Test

```bash
/usr/bin/python3 -m unittest test_host
```
