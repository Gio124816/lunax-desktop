const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { autoUpdater } = require('electron-updater');

// ── CONFIG ─────────────────────────────────────────────────────────────────
const isDev = process.argv.includes('--dev') || !app.isPackaged;
const LUNAX_URL = 'https://lunaxmedia.com'; // Production web app

let mainWindow = null;
let tray = null;

// Tracks when we last opened external auth (Facebook OAuth) in the system browser.
// Used by the window 'focus' handler to decide whether to reload after the user
// returns from completing OAuth.
let _externalAuthOpenedAt = 0;

// ── MAS DETECTION ─────────────────────────────────────────────────────────
// MAS (Mac App Store) builds run in a strict sandbox. Certain Chromium flags
// are not allowed and auto-updater must use Apple's mechanism instead of GitHub.
const isMAS = process.mas === true ||
  fs.existsSync(path.join(process.resourcesPath || '', '..', '_MASReceipt'));

// ── APP READY ──────────────────────────────────────────────────────────────
// ── PERMISSIONS ────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('enable-features', 'WebRTC');
if (!isMAS) {
  // Linux speech dispatcher — harmless on Mac DMG, blocked in MAS sandbox
  app.commandLine.appendSwitch('enable-speech-dispatcher');
  // Auto-accept bypasses the OS permission prompt — NOT allowed in MAS.
  // For MAS, microphone/camera permissions are granted via entitlements + macOS dialog.
  app.commandLine.appendSwitch('auto-accept-camera-and-microphone-capture');
  // Google Speech API — MAS sandbox blocks insecure-origin overrides
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'http://speech.googleapis.com');
}

app.whenReady().then(() => {
  console.log('[Luna X main] build = main-2026-05-27-checkpoint-v5');
  createWindow();
  createTray();
  
  if (!isDev && !isMAS) {
    // Direct download builds use electron-updater via GitHub releases.
    // MAS builds are updated by the App Store — never call autoUpdater there.
    setTimeout(() => autoUpdater.checkForUpdatesAndNotify(), 3000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

// ── CREATE WINDOW ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f0f14',
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Allow loading lunaxmedia.com content
      allowRunningInsecureContent: false,
    },
    show: false, // show after ready-to-show
  });

  // Load the web app
  mainWindow.loadURL(LUNAX_URL);

  // Show when ready to avoid white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools();
  });

  // Set CSP to allow Google Speech API
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"]
      }
    });
  });

  // Grant microphone and camera permissions for voice input
  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'microphone', 'camera', 'notifications'];
    if (allowedPermissions.includes(permission)) {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Also handle permission checks
  mainWindow.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    const allowedPermissions = ['media', 'microphone', 'camera', 'notifications'];
    return allowedPermissions.includes(permission);
  });

  // Open external links in browser, not Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Handle navigation — keep OAuth callbacks in Electron, route Facebook to system browser
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Facebook / Meta OAuth: open in the user's default browser.
    // Why: Facebook's passkey ("Confirm it's you") challenge invokes the OS
    // platform authenticator (Touch ID on macOS / Windows Hello on Windows),
    // which requires the requesting app to be code-signed with the right
    // entitlement (com.apple.developer.web-browser.public-key-credential on
    // macOS — only browsers and password managers get this from Apple).
    // Electron can't get there, so the passkey dialog hangs on a spinner.
    // System browser is signed and can use the keychain, so OAuth completes
    // normally. As a bonus, the user's browser is likely already logged into
    // Facebook, making the connect flow one click.
    if (url.includes('facebook.com') || url.includes('fb.com')) {
      event.preventDefault();
      _externalAuthOpenedAt = Date.now();
      shell.openExternal(url);
      // The Electron window may have started navigating toward Railway's
      // /oauth/meta start endpoint before the redirect to facebook.com.
      // Bring it back to the main app so the user lands somewhere coherent
      // when they return from the browser.
      const currentUrl = mainWindow.webContents.getURL();
      if (!currentUrl.startsWith(LUNAX_URL)) {
        mainWindow.loadURL(LUNAX_URL);
      }
      // Tell the renderer to start polling /auth/me so we can auto-return
      // to the desktop app the moment OAuth completes in the browser.
      try {
        mainWindow.webContents.send('external-auth-started', { platform: 'facebook' });
      } catch (err) {
        console.warn('Failed to notify renderer of external auth start:', err.message);
      }
      return;
    }

    const isOAuth = url.includes('accounts.google.com') ||
                    url.includes('www.tiktok.com/v2/auth') ||
                    url.includes('www.linkedin.com/oauth');

    // Allow OAuth flows in Electron window
    if (isOAuth) return;

    // Allow lunaxmedia.com and Railway backend
    if (url.includes('lunaxmedia.com') || url.includes('railway.app')) return;

    // Everything else opens in browser
    event.preventDefault();
    shell.openExternal(url);
  });

  // Intercept OAuth callbacks and redirect back to app
  mainWindow.webContents.on('did-navigate', (event, url) => {
    // After OAuth, redirect back to lunaxmedia.com with params
    if (url.includes('railway.app') && (
      url.includes('youtube=connected') ||
      url.includes('tiktok=connected') ||
      url.includes('linkedin=connected') ||
      url.includes('meta=connected') ||
      url.includes('facebook=connected') ||
      url.includes('youtube=error') ||
      url.includes('tiktok=error') ||
      url.includes('linkedin=error') ||
      url.includes('meta=error') ||
      url.includes('youtube=no_channel')
    )) {
      const urlObj = new URL(url);
      const params = urlObj.search;
      mainWindow.loadURL(`${LUNAX_URL}${params}`);
    }
  });

  // When the window regains focus after an external OAuth attempt, reload so
  // the renderer picks up the new connection state from /auth/me. The 5-second
  // guard avoids reloading when the user briefly tabs away without actually
  // completing OAuth. Session token lives in localStorage so the reload keeps
  // the user logged in.
  mainWindow.on('focus', () => {
    if (_externalAuthOpenedAt > 0 && Date.now() - _externalAuthOpenedAt > 5000) {
      _externalAuthOpenedAt = 0;
      mainWindow.webContents.reload();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── SYSTEM TRAY ────────────────────────────────────────────────────────────
function createTray() {
  try {
    const icon = nativeImage.createFromPath(getAppIconSmall());
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open Luna X', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
      { type: 'separator' },
      { label: 'Check for Updates', click: () => autoUpdater.checkForUpdatesAndNotify() },
      { type: 'separator' },
      { label: 'Quit Luna X', click: () => app.quit() }
    ]);

    tray.setToolTip('Luna X — AI Social Scheduler');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
  } catch(e) {
    console.log('Tray creation failed (icon missing?):', e.message);
  }
}

// ── IPC: FILE SYSTEM ACCESS ────────────────────────────────────────────────
// This is the key feature — native file picker from voice commands

// Open folder picker dialog
ipcMain.handle('pick-folder', async (event, opts) => {
  // Accept an optional { defaultPath, title, buttonLabel } so callers can pop
  // the picker AT a specific folder (e.g. "is this the folder you meant?").
  // Otherwise default to Downloads so it doesn't reopen at the last-used spot.
  let defaultPath;
  try {
    if (opts && opts.defaultPath && fs.existsSync(opts.defaultPath)) {
      defaultPath = opts.defaultPath;
    } else {
      const dl = path.join(os.homedir(), 'Downloads');
      defaultPath = fs.existsSync(dl) ? dl : os.homedir();
    }
  } catch { defaultPath = undefined; }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: (opts && opts.title) || 'Select your media folder',
    buttonLabel: (opts && opts.buttonLabel) || 'Use this folder',
    ...(defaultPath ? { defaultPath } : {}),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Open file picker dialog
ipcMain.handle('pick-file', async (event, options = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    title: options.title || 'Select a media file',
    buttonLabel: 'Use this file',
    filters: options.filters || [
      { name: 'Media Files', extensions: ['mp4', 'mov', 'avi', 'webm', 'jpg', 'jpeg', 'png', 'gif', 'webp'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Read files from a folder
ipcMain.handle('read-folder', async (event, folderPath) => {
  console.log(`[read-folder] RECEIVED path: ${JSON.stringify(folderPath)}`);
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const files = entries
      .filter(e => e.isFile())
      .map(e => {
        const fullPath = path.join(folderPath, e.name);
        const stat = fs.statSync(fullPath);
        const ext = path.extname(e.name).toLowerCase().slice(1);
        const isVideo = ['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext);
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'].includes(ext);
        if (!isVideo && !isImage) return null;
        return {
          name: e.name,
          path: fullPath,
          size: stat.size,
          lastModified: stat.mtime.getTime(),
          type: isVideo ? 'video' : 'image',
          ext,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.lastModified - a.lastModified);
    console.log(`[read-folder] found ${files.length} media file(s) in ${path.basename(folderPath)}`);
    return { files, folderPath, folderName: path.basename(folderPath) };
  } catch(e) {
    console.error(`[read-folder] ERROR reading ${folderPath}:`, e.message);
    return { error: e.message, files: [] };
  }
});

// Read file as base64 (for upload)
ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const mimeTypes = {
      mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
      webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', gif: 'image/gif', webp: 'image/webp'
    };
    return {
      base64: buffer.toString('base64'),
      mimeType: mimeTypes[ext] || 'application/octet-stream',
      size: buffer.length,
      name: path.basename(filePath),
    };
  } catch(e) {
    return { error: e.message };
  }
});

// Save file path to persistent storage
ipcMain.handle('save-folder-path', async (event, folderPath, label) => {
  try {
    const storePath = path.join(app.getPath('userData'), 'folders.json');
    let folders = {};
    if (fs.existsSync(storePath)) {
      folders = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    }
    folders[label || folderPath] = folderPath;
    fs.writeFileSync(storePath, JSON.stringify(folders));
    return { ok: true };
  } catch(e) {
    return { error: e.message };
  }
});

// Load saved folder paths
ipcMain.handle('load-folder-paths', async () => {
  try {
    const storePath = path.join(app.getPath('userData'), 'folders.json');
    if (!fs.existsSync(storePath)) return {};
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch(e) {
    return {};
  }
});

// Find a folder anywhere in the user's home directory by name. Used when a
// voice command mentions a folder we haven't saved yet — instead of forcing
// the user to navigate via the picker, we try a fast filesystem search and
// auto-use the result. On macOS this is Spotlight-fast (mdfind hits the
// system index). On Linux we fall back to GNU find with a depth cap. We
// stay inside the home directory only — never touch /System, /Library,
// /Applications, etc. Filter rules:
//   - Skip hidden directories and node_modules / .git
//   - Cap results at 20 (sanity)
//   - Sort by path length ascending; shortest path wins (more likely the
//     canonical location, e.g. ~/Documents/X over deeply nested copies)
ipcMain.handle('find-folder-by-name', async (event, folderName) => {
  try {
    console.log(`[find-folder-by-name] RECEIVED query: ${JSON.stringify(folderName)}`);
    if (!folderName || typeof folderName !== 'string') {
      return { error: 'Invalid folder name' };
    }
    // Sanitize: only keep alphanumerics, spaces, hyphens, underscores, dots.
    // This protects against any injection if the args path is ever shell'd.
    const safeName = folderName.replace(/[^\w\s.\-]/g, '').trim();
    if (safeName.length < 2) return { matches: [] };

    const home = os.homedir();

    // Runs a search command and returns an array of directory paths whose
    // basename matches safeName (case-insensitive, substring-tolerant).
    const runSearch = (cmd, args, timeoutMs = 4000) => new Promise((resolve) => {
      const collected = [];
      const child = execFile(cmd, args, {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024
      }, (err, stdout) => {
        if (err && err.code !== 'ENOENT') {
          console.warn(`[find-folder-by-name] ${cmd}:`, err.message);
        }
        const lines = (stdout || '').split('\n').map(s => s.trim()).filter(Boolean);
        const needle = safeName.toLowerCase();
        for (const line of lines) {
          try {
            const stat = fs.statSync(line);
            if (!stat.isDirectory()) continue;
          } catch { continue; }
          // Skip hidden and noise paths
          if (/\/(node_modules|\.[^/]+)(\/|$)/.test(line)) continue;
          // mdfind -name can match on path/metadata, not just the folder name —
          // require the folder's OWN name to actually contain what we searched for.
          const base = path.basename(line).toLowerCase();
          if (!base.includes(needle)) continue;
          collected.push(line);
          if (collected.length >= 30) break;
        }
        resolve(collected);
      });
      setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs + 1000);
    });

    let matches = [];

    if (process.platform === 'darwin') {
      // 1) Spotlight first — fast when the location is indexed.
      matches = await runSearch('mdfind', ['-onlyin', home, '-name', safeName]);

      // 2) Spotlight misses non-indexed spots (fresh folders, some Downloads,
      //    Dropbox/iCloud "optimized" dirs). Fall back to a direct find across
      //    the common media roots — Downloads first.
      if (matches.length === 0) {
        const roots = ['Downloads', 'Desktop', 'Documents', 'Movies', 'Pictures']
          .map(d => path.join(home, d))
          .filter(p => { try { return fs.existsSync(p); } catch { return false; } });
        // Also include home itself at a shallow depth as a last resort.
        for (const root of roots) {
          const found = await runSearch('find', [
            root, '-maxdepth', '4', '-type', 'd',
            '-iname', `*${safeName}*`,
            '-not', '-path', '*/node_modules/*',
            '-not', '-path', '*/.*'
          ], 3000);
          for (const f of found) if (!matches.includes(f)) matches.push(f);
          if (matches.length) break; // stop at the first root that yields hits
        }
      }
    } else if (process.platform === 'linux') {
      const roots = ['Downloads', 'Desktop', 'Documents', home]
        .map(d => d === home ? home : path.join(home, d))
        .filter(p => { try { return fs.existsSync(p); } catch { return false; } });
      for (const root of roots) {
        const found = await runSearch('find', [
          root, '-maxdepth', root === home ? '4' : '6', '-type', 'd',
          '-iname', `*${safeName}*`,
          '-not', '-path', '*/node_modules/*',
          '-not', '-path', '*/.*'
        ], 3000);
        for (const f of found) if (!matches.includes(f)) matches.push(f);
        if (matches.length) break;
      }
    } else {
      // Windows: no good built-in equivalent; let it fall through to picker.
      return { matches: [] };
    }

    // 3) FUZZY fallback. If exact/substring search found nothing, the user may
    //    have spelled the name slightly differently than the folder on disk
    //    (e.g. asked for "Yuzuka Media" but the folder is "Yusuka Media"). List
    //    folders in the common roots and pick the closest name by edit distance.
    if (matches.length === 0 && process.platform !== 'win32') {
      // Normalized Levenshtein distance similarity in [0,1]; 1 = identical.
      const lev = (a, b) => {
        if (a === b) return 1;
        const m = a.length, n = b.length;
        if (!m || !n) return 0;
        const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++)
          for (let j = 1; j <= n; j++)
            dp[i][j] = Math.min(
              dp[i - 1][j] + 1,
              dp[i][j - 1] + 1,
              dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        return 1 - dp[m][n] / Math.max(m, n);
      };

      // Combined similarity that tolerates BOTH spelling slips (Yuzuka/Yusuka)
      // AND partial names (user says "Yuzuka", folder is "Yusuka Media"). We take
      // the best of: whole-string Levenshtein, and the best per-token match where
      // each query word is fuzzily matched against each folder word.
      const sim = (query, name) => {
        query = query.toLowerCase().trim();
        name = name.toLowerCase().trim();
        if (query === name) return 1;
        const whole = lev(query, name);
        // Token-level: how well does every query word find a home in the name?
        const qWords = query.split(/\s+/).filter(Boolean);
        const nWords = name.split(/\s+/).filter(Boolean);
        let tokenScore = 0;
        if (qWords.length && nWords.length) {
          let sum = 0;
          for (const qw of qWords) {
            let bestW = 0;
            for (const nw of nWords) bestW = Math.max(bestW, lev(qw, nw));
            sum += bestW;
          }
          tokenScore = sum / qWords.length; // avg best-match per query word
        }
        return Math.max(whole, tokenScore);
      };

      const roots = ['Downloads', 'Desktop', 'Documents', 'Movies', 'Pictures']
        .map(d => path.join(home, d))
        .filter(p => { try { return fs.existsSync(p); } catch { return false; } });

      const candidates = [];
      for (const root of roots) {
        // Only scan the immediate children of each root (fast, no deep walk).
        let entries = [];
        try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
        for (const ent of entries) {
          if (!ent.isDirectory()) continue;
          if (ent.name.startsWith('.')) continue;
          candidates.push({ path: path.join(root, ent.name), name: ent.name });
        }
      }

      let best = null, bestScore = 0;
      for (const c of candidates) {
        const s = sim(safeName, c.name);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      // Diagnostic: show what was scanned and the closest result.
      console.log(`[find-folder-by-name] fuzzy: scanned ${candidates.length} folders for "${safeName}"; ` +
        `best = ${best ? `"${best.name}" (${bestScore.toFixed(2)})` : 'none'}; threshold 0.7`);
      if (candidates.length) {
        const top = [...candidates]
          .map(c => ({ name: c.name, s: sim(safeName, c.name) }))
          .sort((a, b) => b.s - a.s).slice(0, 5)
          .map(x => `${x.name}=${x.s.toFixed(2)}`).join(', ');
        console.log(`[find-folder-by-name] fuzzy top5: ${top}`);
      }
      // Only accept a fuzzy hit if it's a strong match — avoids grabbing an
      // unrelated folder. 0.7 tolerates a couple of off letters in a name.
      if (best && bestScore >= 0.7) {
        matches.push(best.path);
        console.log(`[find-folder-by-name] fuzzy MATCHED "${safeName}" -> "${best.name}" (${bestScore.toFixed(2)})`);
      }
    }

    // Prefer exact-name matches, then shortest path (canonical-location heuristic).
    const exact = safeName.toLowerCase();
    matches.sort((a, b) => {
      const ae = path.basename(a).toLowerCase() === exact ? 0 : 1;
      const be = path.basename(b).toLowerCase() === exact ? 0 : 1;
      if (ae !== be) return ae - be;
      return a.length - b.length;
    });

    console.log(`[find-folder-by-name] RETURNING ${matches.length} match(es): ${JSON.stringify(matches.slice(0,3))}`);
    return { matches };
  } catch (err) {
    console.error('[find-folder-by-name] threw:', err);
    return { error: err.message, matches: [] };
  }
});

// Native notification
ipcMain.handle('notify', async (event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body, icon: getAppIconSmall() }).show();
  }
});

// Bring the app window to the front. Called by the renderer when it detects
// (via polling /auth/me) that an external OAuth flow has completed in the
// system browser. Clearing _externalAuthOpenedAt prevents the 'focus' listener
// from triggering a second reload — the renderer reloads itself right after
// this resolves.
ipcMain.handle('bring-to-front', () => {
  _externalAuthOpenedAt = 0;
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') {
    // steal:true is what makes the dock icon bounce / app actually come
    // forward over the user's current browser
    app.focus({ steal: true });
  }
});

// ── IPC: APP INFO ──────────────────────────────────────────────────────────
ipcMain.handle('get-app-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  isDesktop: true,
  // Build marker — bump this string whenever main.js changes so you can verify
  // from DevTools (await window.lunaxDesktop.getAppInfo()) that the running app
  // is actually using the latest main.js, not a stale packaged copy.
  mainBuild: 'main-2026-05-27-checkpoint-v5',
}));

// ── AUTO UPDATER ───────────────────────────────────────────────────────────
autoUpdater.on('update-available', () => {
  mainWindow?.webContents.send('update-available');
});

autoUpdater.on('update-downloaded', () => {
  mainWindow?.webContents.send('update-downloaded');
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

// ── HELPERS ────────────────────────────────────────────────────────────────
function getAppIcon() {
  if (process.platform === 'darwin') return path.join(__dirname, 'build', 'icon.icns');
  if (process.platform === 'win32') return path.join(__dirname, 'build', 'icon.ico');
  return path.join(__dirname, 'build', 'icon.png');
}

function getAppIconSmall() {
  return path.join(__dirname, 'build', 'icon.png');
}

// ── QUIT BEHAVIOR ──────────────────────────────────────────────────────────
app.on('window-all-closed', () => {
  // On Mac, keep app running in tray when all windows closed
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  tray?.destroy();
});
