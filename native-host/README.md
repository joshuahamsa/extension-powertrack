# Keychain native host

Saves the PowerTrack session captured by the extension to the macOS Keychain, so
scripts can use it without copying the cookie by hand.

- Items: `powertrack-cookie` and `powertrack-ae-s` (account `powertrack`).
- The extension sends only `cookie` and `ae_s`, and only when they change.
- Values are passed to `security` over stdin, never as arguments, and never logged.

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
