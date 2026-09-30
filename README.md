# PowerTrack Extension

Chrome extension for programmatic interaction with the AE PowerTrack web app. It monitors API calls, extracts auth context, and helps automate tasks.

## What it does
- Observes network activity on `apps.alsoenergy.com`.
- Captures API endpoints and request details.
- Provides a popup UI for reviewing captured data.

## Install for development
1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select `extensions/extension-powertrack/PowerTrackExtension`.

## Quickstart
1. Navigate to `https://apps.alsoenergy.com` and sign in.
2. Open the extension popup and start capture.
3. Use the app normally so API calls are recorded.
4. Review captured endpoints in the popup and export if needed.

## Project layout
- `PowerTrackExtension/manifest.json` - extension metadata and permissions.
- `PowerTrackExtension/scripts/` - background, content, and injected scripts.
- `PowerTrackExtension/popup.html` + `PowerTrackExtension/styles.css` - popup UI.
- `PowerTrackExtension/icons/` - extension icons.

## Keychain session
The extension saves the PowerTrack session (`cookie`, `ae_s`, `ae_v`) to the macOS
Keychain through the shared native host in `endpoint-extensions/native-host/`
(items `powertrack-cookie`, `powertrack-ae-s`, `powertrack-ae-v`). Install it from
there with `install.py edge powertrack=<extension-id>`.
