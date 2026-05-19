const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
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

// ── APP READY ──────────────────────────────────────────────────────────────
// ── PERMISSIONS ────────────────────────────────────────────────────────────
app.commandLine.appendSwitch('enable-features', 'WebRTC');
app.commandLine.appendSwitch('enable-speech-dispatcher');
app.commandLine.appendSwitch('auto-accept-camera-and-microphone-capture');
// Allow Google Speech API for webkitSpeechRecognition
app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', 'http://speech.googleapis.com');

app.whenReady().then(() => {
  createWindow();
  createTray();
  
  if (!isDev) {
    // Check for updates after 3 seconds
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
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select your media folder',
    buttonLabel: 'Use this folder',
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
    return { files, folderPath, folderName: path.basename(folderPath) };
  } catch(e) {
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
