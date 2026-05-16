/**
 * Luna X Desktop — Preload Script
 * 
 * This runs in a privileged context and exposes safe APIs to the web app.
 * The web app (lunaxmedia.com) can call window.lunaxDesktop.* methods
 * which proxy to Electron's native capabilities.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lunaxDesktop', {
  // ── Identity ────────────────────────────────────────────────────────────
  isDesktop: true,

  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // ── File System ──────────────────────────────────────────────────────────
  // Open native folder picker dialog
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // Open native file picker dialog  
  pickFile: (options) => ipcRenderer.invoke('pick-file', options),

  // Read all media files from a folder path
  readFolder: (folderPath) => ipcRenderer.invoke('read-folder', folderPath),

  // Read a single file as base64 for upload
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

  // Save a folder path with a label for persistence
  saveFolderPath: (folderPath, label) => ipcRenderer.invoke('save-folder-path', folderPath, label),

  // Load all saved folder paths
  loadFolderPaths: () => ipcRenderer.invoke('load-folder-paths'),

  // ── Notifications ────────────────────────────────────────────────────────
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),

  // ── Updates ──────────────────────────────────────────────────────────────
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
  installUpdate: () => ipcRenderer.invoke('install-update'),
});
