# Luna X Desktop App

Electron wrapper for Luna X — gives the web app native file system access, solving the voice → file picker limitation.

## Setup

```bash
cd lunax-desktop
npm install
npm start          # development
npm run build:mac  # build for Mac (creates .dmg)
npm run build:win  # build for Windows (creates .exe installer)
npm run build:all  # build all platforms
```

## What this adds over the web app

- **Native file picker** — `window.lunaxDesktop.pickFolder()` opens the real OS file dialog, works from voice callbacks
- **Direct folder reading** — reads all media files from a folder instantly, no browser permission dance
- **Persistent folder paths** — saved to `~/Library/Application Support/Luna X/folders.json`
- **Native notifications** — "Your post just went live" system notifications
- **System tray** — app runs in background, accessible from menu bar
- **Auto-updater** — push updates via GitHub Releases, users get prompted automatically

## How the file system bridge works

The web app (`lunaxmedia.com`) checks `window.lunaxDesktop?.isDesktop` on load.
If true, it uses `window.lunaxDesktop.pickFolder()` instead of `showDirectoryPicker()`.
This works from voice callbacks because it goes through Electron's IPC, not the browser security sandbox.

## Building icons

You need these icon files in `build/`:
- `icon.icns` — Mac (use `luna-x-icon-1024.png` → convert via Image2Icon or iconutil)
- `icon.ico` — Windows (use an online converter)  
- `icon.png` — Linux + tray (1024x1024 PNG)

Copy `luna-x-icon-1024.png` to `build/icon.png` to start.

## Publishing updates

1. Bump version in `package.json`
2. `npm run build:mac` (or all)
3. Create GitHub Release with the built files
4. Users get auto-update notification within 24 hours

## GitHub repo

Create `Gio124816/lunax-desktop` and push this folder.
Set `GH_TOKEN` env var for publishing.
