const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell, safeStorage, Tray, Menu, nativeImage, screen, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Agent, MODEL } = require('./agent');
const { run } = require('./exec');
const prs = require('./prs');
const { Inbox } = require('./inbox');
const { ClaudeCodeRunner, findClaude } = require('./claudecode');

const SHORTCUT = 'CommandOrControl+Shift+Space';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';
const SHORTCUT_LABEL = IS_MAC ? '⌘⇧Space' : 'Ctrl+Shift+Space';
// Where saved API keys are encrypted, in words for Settings.
const SECRET_STORE = IS_MAC ? 'your macOS keychain' : IS_WIN ? 'Windows (DPAPI, tied to your account)' : 'your system keyring (GNOME Keyring / KWallet)';

// Wayland: let Electron register the global shortcut through the desktop portal.
if (IS_LINUX) app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
if (IS_WIN) app.setAppUserModelId('dev.revai.app'); // needed for Windows toast notifications

let win = null;
let tray = null;
let modalOpen = false; // native dialogs steal focus; don't auto-hide behind them
const agent = new Agent();
const claudeRunner = new ClaudeCodeRunner();
const pendingConfirms = new Map();

// ---------- settings ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return { repos: [], currentRepo: null };
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}
let settings = null;

function storedKey() {
  if (!settings.apiKeyEnc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(settings.apiKeyEnc, 'base64'));
  } catch {
    return '';
  }
}

/**
 * Which AI provider to use, and its key. A key saved in Settings wins over the environment.
 * OpenRouter keys start with "sk-or-", Groq keys with "gsk_"; anything else is treated as an Anthropic key.
 */
const providerFor = (key) => (key.startsWith('sk-or-') ? 'openrouter' : key.startsWith('gsk_') ? 'groq' : 'anthropic');
function getProvider() {
  // Your Claude plan through Claude Code comes first when it's installed, unless you turned it off in Settings.
  if (settings.useClaude !== false && findClaude()) return { type: 'claude-code', key: null, fromEnv: false };
  const key = storedKey();
  if (key) return { type: providerFor(key), key, fromEnv: false };
  if (process.env.GROQ_API_KEY) return { type: 'groq', key: process.env.GROQ_API_KEY, fromEnv: true };
  if (process.env.OPENROUTER_API_KEY) return { type: 'openrouter', key: process.env.OPENROUTER_API_KEY, fromEnv: true };
  if (process.env.ANTHROPIC_API_KEY) return { type: 'anthropic', key: process.env.ANTHROPIC_API_KEY, fromEnv: true };
  return null;
}
const getApiKey = () => storedKey() || process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '';

// ---------- window: the island ----------
// Rev sits at the top center of the screen as a small black pill that merges with the notch,
// like the iPhone's Dynamic Island. It morphs open into the full app, peeks out for new GitHub
// notifications, and shrinks back when you click elsewhere (unless pinned).
// The window itself is always there and transparent; outside the pill it lets clicks through.
// Size of the opened app. Drag the handle at its bottom to change it; it's saved in settings.
// To change the default by hand, edit DEFAULT_SIZE here and --app-width / --app-height in styles.css.
const DEFAULT_SIZE = { w: 340, h: 470 };
const MIN_SIZE = { w: 300, h: 340 };
const MAX_SIZE = { w: 720, h: 1000 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));
function appSize() {
  const s = settings?.islandSize || DEFAULT_SIZE;
  return { w: clamp(s.w, MIN_SIZE.w, MAX_SIZE.w), h: clamp(s.h, MIN_SIZE.h, MAX_SIZE.h) };
}
// The window is the app plus room for its shadow, and never narrower than a notification peek.
const windowSize = ({ w, h }) => ({ width: Math.max(w + 60, 420), height: Math.max(h + 70, 120) });
let expanded = false;

// On macOS the island hangs from the very top so it merges with the notch. Elsewhere there is no notch,
// so it floats as a pill at the top center of the work area (below a top taskbar or GNOME's top bar).
// On Linux the window can't let clicks through while still seeing the pointer, so there is no
// collapsed pill: the window shows when opened (tray, shortcut) and hides when it closes.
const FLOAT_TOP = 8;
function placeIsland(size = appSize()) {
  if (!win) return;
  const d = screen.getPrimaryDisplay();
  const area = IS_MAC ? d.bounds : d.workArea;
  const { width, height } = windowSize(size);
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = IS_MAC ? area.y : area.y + (IS_LINUX ? 0 : FLOAT_TOP);
  win.setBounds({ x, y, width, height: Math.min(height, area.height) }, false);
}

function setIslandSize(size, save) {
  const s = { w: clamp(size?.w, MIN_SIZE.w, MAX_SIZE.w), h: clamp(size?.h, MIN_SIZE.h, MAX_SIZE.h) };
  placeIsland(s);
  if (save) {
    settings.islandSize = s;
    saveSettings(settings);
  }
  return s;
}

function createWindow() {
  win = new BrowserWindow({
    width: windowSize(appSize()).width,
    height: windowSize(appSize()).height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false, // the island draws its own shadow
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Above the menu bar and full-screen apps, on every Space / virtual desktop.
  win.setAlwaysOnTop(true, 'screen-saver');
  if (!IS_WIN) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (!IS_LINUX) win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => {
    placeIsland();
    // Linux has no always-visible pill, so open once at launch to show where Rev is.
    if (IS_LINUX) expandIsland();
    else win.showInactive();
  });
  win.on('blur', () => {
    if (settings.pinned || modalOpen || pendingConfirms.size) return;
    collapseIsland();
  });
  screen.on('display-metrics-changed', placeIsland);
  screen.on('display-added', placeIsland);
  screen.on('display-removed', placeIsland);
}

function expandIsland() {
  if (!win) return;
  expanded = true;
  if (IS_LINUX) {
    placeIsland();
    win.show();
  } else if (!win.isVisible()) win.showInactive();
  if (!IS_LINUX) win.setIgnoreMouseEvents(false);
  win.webContents.send('island', 'expanded');
  if (IS_MAC) app.focus({ steal: true });
  win.focus();
}

function collapseIsland() {
  if (!win || !expanded) return;
  expanded = false;
  win.webContents.send('island', 'collapsed');
  if (IS_LINUX) win.hide();
  else win.setIgnoreMouseEvents(true, { forward: true });
}

// Kept for the code paths that already call these names.
const showWindow = expandIsland;
const hideWindow = collapseIsland;

function toggleWindow() {
  if (expanded) collapseIsland();
  else expandIsland();
}

function setPinned(on) {
  settings.pinned = Boolean(on);
  saveSettings(settings);
  win?.webContents.send('pinned', settings.pinned);
  refreshTrayMenu();
}

// The Rev logo (assets/app-icon.svg, rendered by `npm run icons`).
const APP_ICON = path.join(__dirname, 'assets', 'icon.png');
const LOGO_MENU = () => {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
};

// macOS tints the black template icon to match the menu bar. Windows taskbars and Linux panels
// don't, and are usually dark, so there the tray shows the full-color app icon.
function trayIcon() {
  if (IS_MAC) return LOGO_MENU();
  return nativeImage.createFromPath(APP_ICON).resize({ width: IS_WIN ? 32 : 24, height: IS_WIN ? 32 : 24, quality: 'best' });
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Rev', icon: IS_MAC ? LOGO_MENU() : undefined, accelerator: 'CommandOrControl+Shift+Space', click: showWindow },
    { label: 'Open GitHub Notifications', click: () => shell.openExternal('https://github.com/notifications') },
    { label: 'Mark All Notifications Read', enabled: inbox?.unreadCount > 0, click: () => inbox.markAllRead() },
    { type: 'separator' },
    { label: 'Reset Size', click: () => win?.webContents.send('island-size', setIslandSize(DEFAULT_SIZE, true)) },
    { label: 'Keep Island Open', type: 'checkbox', checked: Boolean(settings.pinned), click: (i) => setPinned(i.checked) },
    { label: 'Desktop Notifications', type: 'checkbox', checked: settings.notify !== false, click: (i) => { settings.notify = i.checked; saveSettings(settings); refreshTrayMenu(); } },
    { label: 'New Conversation', click: () => { agent.reset(); claudeRunner.reset(); win?.webContents.send('chat-reset'); } },
    { type: 'separator' },
    { label: 'Quit Rev', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Rev AI');
  if (IS_LINUX) {
    // Linux panels (StatusNotifierItem / AppIndicator) only show a menu: clicks don't reach the app.
    // GNOME needs the "AppIndicator and KStatusNotifierItem Support" extension to show it at all.
    refreshTrayMenu();
  } else {
    tray.on('click', toggleWindow);
    tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
  }
}

// Linux keeps a fixed tray menu, so rebuild it when what it shows changes.
function refreshTrayMenu() {
  if (IS_LINUX && tray) tray.setContextMenu(trayMenu());
}

function updateBadge(count) {
  if (!tray) return;
  if (IS_MAC) tray.setTitle(count ? ` ${count > 99 ? '99+' : count}` : '', { fontType: 'monospacedDigit' });
  tray.setToolTip(count ? `Rev AI · ${count} unread on GitHub` : 'Rev AI');
  refreshTrayMenu();
}

// ---------- GitHub notifications ----------
let inbox = null;
function startInbox() {
  inbox = new Inbox({
    onUpdate: (items) => {
      updateBadge(items.filter((i) => i.unread).length);
      win?.webContents.send('inbox', { items, error: inbox.error });
    },
    onNew: (fresh) => {
      if (!IS_LINUX) win?.webContents.send('island-peek', fresh[0]); // Linux has no pill to peek from
      if (settings.notify === false || !Notification.isSupported()) return;
      const list = fresh.slice(0, 3);
      for (const it of list) {
        const n = new Notification({ title: it.reasonLabel, subtitle: it.repo, body: it.title, icon: APP_ICON, silent: false });
        n.on('click', () => { shell.openExternal(it.url); inbox.markRead(it.id); });
        n.show();
      }
      if (fresh.length > list.length) {
        const n = new Notification({ title: 'GitHub', body: `${fresh.length - list.length} more new notifications`, icon: APP_ICON });
        n.on('click', showWindow);
        n.show();
      }
    },
  });
  inbox.start();
}

// ---------- repo helpers ----------
async function repoInfo(dir) {
  if (!dir) return null;
  const top = await run('git', ['rev-parse', '--show-toplevel'], dir);
  if (top.code !== 0) return { dir, error: 'Not a git repository' };
  const st = await run('git', ['status', '--porcelain=v2', '--branch'], dir);
  let branch = '?';
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  for (const line of st.stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14);
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { ahead = +m[1]; behind = +m[2]; }
    } else if (line && !line.startsWith('#')) changes++;
  }
  return { dir: top.stdout.trim(), name: path.basename(top.stdout.trim()), branch, ahead, behind, changes };
}

// ---------- IPC ----------
function emit(ev) {
  win?.webContents.send('agent-event', ev);
}

/**
 * Can saved keys really be encrypted? On Linux without a keyring, Electron falls back to a
 * hard-coded password ("basic_text"), which is no better than plain text, so we refuse that.
 */
function secretStoreUsable() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (IS_LINUX && typeof safeStorage.getSelectedStorageBackend === 'function') {
    return !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend());
  }
  return true;
}

ipcMain.handle('state', async () => ({
  hasKey: Boolean(getApiKey()),
  claudeAvailable: Boolean(findClaude()),
  useClaude: settings.useClaude !== false,
  keyFromEnv: Boolean(getProvider()?.fromEnv),
  provider: getProvider()?.type || null,
  repos: settings.repos,
  repo: await repoInfo(settings.currentRepo),
  model: MODEL,
  shortcut: SHORTCUT_LABEL,
  platform: process.platform,
  secretStore: SECRET_STORE,
  pinned: Boolean(settings.pinned),
  notify: settings.notify !== false,
  islandSize: appSize(),
  defaultSize: DEFAULT_SIZE,
  minSize: MIN_SIZE,
  maxSize: MAX_SIZE,
}));

ipcMain.handle('set-api-key', (_e, key) => {
  key = String(key || '').trim();
  if (!key) delete settings.apiKeyEnc;
  else if (secretStoreUsable()) settings.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
  else throw new Error(IS_LINUX
    ? 'No system keyring found (install and unlock GNOME Keyring or KWallet), so Rev won\'t save the key. You can set GROQ_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY instead.'
    : 'Secure key storage is not available; set GROQ_API_KEY, OPENROUTER_API_KEY or ANTHROPIC_API_KEY instead.');
  saveSettings(settings);
  return { hasKey: Boolean(getApiKey()), provider: getProvider()?.type || null };
});
ipcMain.handle('set-use-claude', (_e, on) => {
  settings.useClaude = Boolean(on);
  saveSettings(settings);
  agent.reset();
  claudeRunner.reset();
  return { provider: getProvider()?.type || null };
});

ipcMain.handle('pick-repo', async () => {
  modalOpen = true;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], message: 'Choose a git repository' }).finally(() => { modalOpen = false; });
  if (r.canceled || !r.filePaths[0]) return null;
  return selectRepo(r.filePaths[0]);
});

async function selectRepo(dir) {
  const info = await repoInfo(dir);
  if (!info || info.error) return info;
  settings.currentRepo = info.dir;
  settings.repos = [info.dir, ...settings.repos.filter((d) => d !== info.dir)].slice(0, 10);
  saveSettings(settings);
  agent.reset(); // a new repo starts a fresh conversation
  return info;
}
ipcMain.handle('select-repo', (_e, dir) => selectRepo(dir));
ipcMain.handle('repo-info', () => repoInfo(settings.currentRepo));

ipcMain.handle('agent-send', async (_e, prompt) => {
  if (!settings.currentRepo) return emit({ type: 'error', text: 'Pick a repository first.' }), emit({ type: 'done' });
  const provider = getProvider();
  if (!provider) return emit({ type: 'error', text: 'Install Claude Code and sign in, or add an API key (Groq, OpenRouter or Anthropic) in Settings.' }), emit({ type: 'done' });
  win.webContents.send('island-busy', true);
  const runner = provider.type === 'claude-code' ? claudeRunner : agent;
  await runner.send(String(prompt), {
    provider,
    cwd: settings.currentRepo,
    emit,
    confirm: (req) =>
      new Promise((resolve) => {
        pendingConfirms.set(req.id, resolve);
        if (!expanded) expandIsland();
      }),
  });
  win.webContents.send('island-busy', false);
});
ipcMain.handle('agent-confirm', (_e, id, ok) => {
  const r = pendingConfirms.get(id);
  if (r) { pendingConfirms.delete(id); r(Boolean(ok)); }
});
ipcMain.handle('agent-cancel', () => {
  for (const r of pendingConfirms.values()) r(false);
  pendingConfirms.clear();
  agent.cancel();
  claudeRunner.cancel();
});
ipcMain.handle('agent-reset', () => { agent.reset(); claudeRunner.reset(); });

// PR manager
ipcMain.handle('prs-load', () => prs.load(settings.currentRepo));
ipcMain.handle('pr-open', (_e, url) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); });
ipcMain.handle('pr-checkout', (_e, number) => prs.checkout(settings.currentRepo, number));
ipcMain.handle('pr-create', (_e, form) => prs.create(settings.currentRepo, form));
ipcMain.handle('pr-merge', async (_e, { repo, number, title, method, deleteBranch }) => {
  modalOpen = true;
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    icon: nativeImage.createFromPath(APP_ICON),
    buttons: ['Merge', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Merge #${number} into its base branch?`,
    detail: `${repo}\n${title}\nMethod: ${method}${deleteBranch ? ', delete branch after' : ''}`,
  }).finally(() => { modalOpen = false; });
  if (r.response !== 0) return { code: -1, stderr: 'Cancelled' };
  return prs.merge(settings.currentRepo, { repo, number, method, deleteBranch });
});

ipcMain.handle('hide', () => collapseIsland());
ipcMain.handle('expand', () => expandIsland());
// While collapsed, the renderer tells us when the pointer is over the pill so it can be clicked.
ipcMain.handle('island-hover', (_e, over) => {
  if (!expanded && !IS_LINUX) win.setIgnoreMouseEvents(!over, { forward: true });
});
ipcMain.handle('set-pinned', (_e, on) => setPinned(on));
// While you drag the resize handle the window follows; on release the size is saved.
ipcMain.handle('island-resize', (_e, size, save) => setIslandSize(size, save));
ipcMain.handle('inbox-load', () => ({ items: inbox?.items || [], error: inbox?.error || null }));
ipcMain.handle('inbox-refresh', () => inbox?.poll());
ipcMain.handle('inbox-open', (_e, id) => {
  const it = inbox?.items.find((i) => i.id === String(id));
  if (it) { shell.openExternal(it.url); inbox.markRead(it.id); }
});
ipcMain.handle('inbox-read', (_e, id) => inbox?.markRead(id));
ipcMain.handle('inbox-read-all', () => inbox?.markAllRead());
ipcMain.handle('set-notify', (_e, on) => { settings.notify = Boolean(on); saveSettings(settings); });
ipcMain.handle('quit', () => app.quit());

// ---------- lifecycle ----------
// One Rev at a time; launching it again (Start menu, app launcher) opens the running one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else app.on('second-instance', () => expandIsland());

app.whenReady().then(() => {
  if (!gotLock) return;
  settings = loadSettings();
  if (IS_MAC) {
    app.dock?.setIcon(APP_ICON); // Rev logo instead of Electron's, if the Dock icon is ever shown
    app.dock?.hide(); // behave like an overlay, not a regular app
  }
  createTray();
  createWindow();
  startInbox();
  if (!globalShortcut.register(SHORTCUT, toggleWindow)) console.warn(`Could not register ${SHORTCUT}`);
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
