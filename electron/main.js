'use strict';
// Laxorq Reception — Electron desktop shell.
// Boots the existing zero-dependency Node server in-process, then shows the
// dashboard in a desktop window. Stores the database in a writable per-user
// location and wires GitHub one-click auto-updates.

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('node:path');

// One running copy per machine — a second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// The DB must live somewhere writable (inside a packaged app the program folder is
// read-only). Point the server at the per-user app data folder.
const DATA_DIR = path.join(app.getPath('userData'), 'data');
process.env.RECEPTION_DATA_DIR = DATA_DIR;

let win;
let serverPort = process.env.PORT || 4100;

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 960, minHeight: 640,
    backgroundColor: '#0D0D0D',
    title: 'Laxorq Reception',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(url);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Reception',
      submenu: [
        { label: 'Check for updates…', click: () => manualUpdateCheck() },
        { label: 'Open dashboard in browser', click: () => shell.openExternal(`http://localhost:${serverPort}`) },
        { label: 'Open data folder (backups)', click: () => shell.openPath(DATA_DIR) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]);
}

// node:sqlite needs a recent Node. If this Electron's Node cannot load it, fail
// loudly with a clear message instead of a blank window.
function sqliteOk() {
  try { require('node:sqlite'); return true; }
  catch (e) {
    dialog.showErrorBox('Database engine unavailable',
      'This build of Laxorq Reception needs a newer Electron (node:sqlite).\n\n' + e.message);
    return false;
  }
}

async function boot() {
  if (!sqliteOk()) { app.quit(); return; }
  let server;
  try {
    server = require(path.join(__dirname, '..', 'server.js')); // backs up DB + runs migrations on require
    const info = await server.start();
    serverPort = info.port;
  } catch (e) {
    // Most likely the port is busy (another instance/server). Load it anyway.
    console.error('server start:', e.message);
    serverPort = server?.PORT || serverPort;
  }
  Menu.setApplicationMenu(buildMenu());
  createWindow(`http://localhost:${serverPort}`);
  setupUpdates();
}

// ----------------------------------------------------------------- AUTO UPDATE
let autoUpdater = null;
function setupUpdates() {
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-downloaded', async (info) => {
    const r = await dialog.showMessageBox(win, {
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0,
      title: 'Update ready',
      message: `Laxorq Reception ${info.version} has been downloaded.`,
      detail: 'Your data is automatically backed up on every launch, so updating is safe. Restart to apply?',
    });
    if (r.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', e => console.error('updater:', e?.message || e));
  // Only check once GitHub publishing is configured (owner filled in). Avoids noisy
  // 404s before the repo is set up.
  let owner = '';
  try { owner = require('../package.json').build.publish.owner || ''; } catch {}
  const configured = owner && !/REPLACE/i.test(owner);
  if (app.isPackaged && configured) autoUpdater.checkForUpdates().catch(() => {});
}

async function manualUpdateCheck() {
  if (!app.isPackaged || !autoUpdater) {
    dialog.showMessageBox(win, { type: 'info', message: 'Updates run in the installed app.', detail: 'Auto-update checks GitHub Releases once this is installed from a published build.' });
    return;
  }
  try {
    const r = await autoUpdater.checkForUpdates();
    if (!r || !r.updateInfo || r.updateInfo.version === app.getVersion()) {
      dialog.showMessageBox(win, { type: 'info', message: 'You are up to date.', detail: 'Version ' + app.getVersion() });
    }
  } catch (e) {
    dialog.showMessageBox(win, { type: 'error', message: 'Update check failed', detail: e.message });
  }
}

app.whenReady().then(boot);
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(`http://localhost:${serverPort}`); });
