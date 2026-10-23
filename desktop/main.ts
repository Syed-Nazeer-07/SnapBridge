import { app, BrowserWindow, Tray, Menu, nativeImage, globalShortcut, desktopCapturer, screen, ipcMain, dialog, clipboard, safeStorage, shell } from 'electron';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { normalizeShortcut } from '../shared/shortcut';
import { SettingsSchema, type PreparedBatch } from '../shared/protocol';
import { z } from 'zod';
import { CaptureQueue } from './queue';
import { BrowserBridge, type Binding } from './bridge';
import type { AppState, Settings, CaptureSource } from '../shared/protocol';
const root = path.resolve(__dirname, '../..');
const uiFile = path.join(root, 'dist/renderer/index.html');
const captureFile = path.join(root, 'dist/renderer/capture.html');
let window: BrowserWindow;
let tray: Tray;
let bridge: BrowserBridge;
let queue: CaptureQueue;
let settings: Settings = SettingsSchema.parse({ shortcut: 'CommandOrControl+Shift+S', alwaysOnTop: true });
let prepared: PreparedBatch | null = null;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
let status = 'Ready to capture. Your screenshots stay on this device.';
let error = false;
let busy = false;
let capturing = false;
let queueHealthy = true;
let overlays = new Map<number, { window: BrowserWindow; image: Electron.NativeImage; display: Electron.Display }>();
let mutation = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = mutation.then(fn); mutation = next.then(() => {}, () => {}); return next; };
const dataPath = (...parts: string[]) => path.join(app.getPath('userData'), ...parts);
function state(): AppState { return { images: queue.images, tabs: bridge.tabs, connected: bridge.connected, pairingCode: bridge.code, prepared, settings, busy, status, error, bytes: queue.bytes }; }
function publish(message?: string, isError = false) { if (message) { status = message; error = isError; } if (window && !window.isDestroyed()) window.webContents.send('snapflow:state', state()); }
function show() { if (window) { window.show(); window.focus(); } }
function secure(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}
async function bindingFile(binding: Binding | null) {
  if (!binding) { await writeFile(dataPath('browser-binding'), '', { mode: 0o600 }); return; }
  const plain = JSON.stringify(binding);
  const contents = safeStorage.isEncryptionAvailable() ? `encrypted:${safeStorage.encryptString(plain).toString('base64')}` : `local:${plain}`;
  await writeFile(dataPath('browser-binding'), contents, { mode: 0o600 });
}
async function loadBinding(): Promise<Binding | null> {
  try {
    const saved = await readFile(dataPath('browser-binding'), 'utf8');
    const plain = saved.startsWith('encrypted:') ? safeStorage.decryptString(Buffer.from(saved.slice(10), 'base64')) : saved.startsWith('local:') ? saved.slice(6) : '';
    const parsed = JSON.parse(plain);
    return z.object({ token: z.string().regex(/^[a-f0-9]{64}$/), origin: z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/) }).parse(parsed);
  } catch { return null; }
}
function makeWindow() {
  const display = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({ width: 720, height: 112, x: Math.round(display.x + (display.width - 720) / 2), y: display.y + 38, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, maximizable: false, fullscreenable: false, alwaysOnTop: settings.alwaysOnTop, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  secure(window); window.setContentProtection(true);
  window.on('close', event => { if (!(app as any).isQuitting) { event.preventDefault(); window.hide(); } });
  window.once('ready-to-show', () => window.show());
  void window.loadFile(uiFile);
  tray = new Tray(nativeImage.createFromPath(path.join(root, 'assets/icon.png')));
  tray.setToolTip('SnapFlow — capture to your conversation');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show SnapFlow', click: show }, { label: 'Capture region', click: () => void capture().catch(e => publish(e.message, true)) }, { type: 'separator' }, { label: 'Quit', click: () => app.quit() }]));
  tray.on('click', show);
}
function closeOverlays() { for (const item of overlays.values()) if (!item.window.isDestroyed()) item.window.destroy(); overlays.clear(); capturing = false; globalShortcut.unregister('Escape'); show(); }
async function capture() {
  if (capturing) return;
  if (!queueHealthy) throw new Error('Saved queue needs recovery before more screenshots can be added.');
  capturing = true;
  window.hide();
  await new Promise(resolve => setTimeout(resolve, 200));
  try {
    const displays = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.max(...displays.map(d => Math.round(d.size.width * d.scaleFactor))), height: Math.max(...displays.map(d => Math.round(d.size.height * d.scaleFactor))) } });
    for (const display of displays) {
      const source = sources.find(s => s.display_id === String(display.id)) || (displays.length === 1 ? sources[0] : undefined);
      if (!source || source.thumbnail.isEmpty()) throw new Error('Screen capture is unavailable. Check operating-system screen capture permissions.');
      const overlay = new BrowserWindow({ ...display.bounds, frame: false, transparent: false, backgroundColor: '#14151f', resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      secure(overlay);
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlays.set(overlay.webContents.id, { window: overlay, image: source.thumbnail, display });
      overlay.once('ready-to-show', () => { overlay.show(); overlay.focus(); });
      await overlay.loadFile(captureFile);
    }
    globalShortcut.register('Escape', closeOverlays);
  } catch (e) { closeOverlays(); throw e; }
}
function handle(name: string, fn: (...args: any[]) => any, captureOnly = false) {
  ipcMain.handle(`snapflow:${name}`, async (event, ...args) => {
    const expected = captureOnly ? captureFile : uiFile;
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pathToFileURL(expected).href || (captureOnly ? !overlays.has(event.sender.id) : event.sender !== window.webContents)) throw new Error('Untrusted IPC sender.');
    try { return await fn(event, ...args); } catch (e: any) { publish(e.message || 'Operation failed.', true); throw e; }
  });
}
function requireMutable() { if (!queueHealthy) throw new Error('Queue recovery is required. Original captures are retained on disk.'); if (busy) throw new Error('Wait for the current transfer to finish.'); }
function registerIPC() {
  handle('state', () => state());
  handle('capture', () => capture());
  handle('remove', (_event, id) => serial(async () => { requireMutable(); await queue.remove([z.string().uuid().parse(id)]); publish(); }));
  handle('clear', () => serial(async () => { requireMutable(); await queue.remove(queue.images.map(i => i.id)); publish('Queue cleared.'); }));
  handle('reorder', (_event, ids) => serial(async () => { requireMutable(); await queue.reorder(z.array(z.string().uuid()).parse(ids)); publish(); }));
  handle('preview', async (_event, id) => `data:image/png;base64,${(await queue.read(z.string().uuid().parse(id))).toString('base64')}`);
  handle('prepare', async (_event, tabId, text) => {
    requireMutable();
    const prompt = z.string().max(20_000).parse(text);
    const tab = bridge.tabs.find(t => t.id === z.number().int().parse(tabId));
    if (!tab) throw new Error('Select a connected conversation tab.');
    const items = queue.images;
    if (!items.length && !prompt.trim()) throw new Error('Add a capture or a message first.');
    if (prepared && prepared.url === tab.url && prepared.tabId === tab.id && prepared.promptDigest === digest(prompt) && JSON.stringify(prepared.ids) === JSON.stringify(items.map(i => i.id))) {
      bridge.focus(tab); publish('This batch is already prepared. Review it in the browser and press Send there.'); return;
    }
    busy = true; publish('Preparing the draft in your selected conversation…');
    try {
      const images = [];
      for (const item of items) images.push({ id: item.id, name: item.name, base64: (await queue.read(item.id)).toString('base64') });
      const evidence = await bridge.prepare({ tab, images, prompt });
      prepared = { ids: items.map(i => i.id), tabId: tab.id, url: tab.url, promptDigest: digest(prompt), time: Date.now() };
      await writeFile(dataPath('prepared.json.tmp'), JSON.stringify(prepared), { mode: 0o600 });
      await rename(dataPath('prepared.json.tmp'), dataPath('prepared.json'));
      publish(`Ready in ${tab.provider}. Review the draft and press Send in your browser. Your captures are kept here. ${evidence}`);
    } finally { busy = false; publish(); }
  });
  handle('clearPrepared', (_event, text) => serial(async () => {
    requireMutable(); const prompt = z.string().max(20_000).parse(text);
    if (!prepared) return false;
    const matches = prepared.promptDigest === digest(prompt);
    await queue.remove(prepared.ids); prepared = null;
    await unlink(dataPath('prepared.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
    publish('Prepared captures removed from the local queue.'); return matches;
  }));
  handle('fallback', async (_event, tabId, text) => {
    const prompt = z.string().max(20_000).parse(text);
    const result = await dialog.showOpenDialog(window, { title: 'Export captures for manual attachment', buttonLabel: 'Save captures here', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled || !result.filePaths[0]) return '';
    const folder = path.join(result.filePaths[0], `SnapFlow-${Date.now()}`);
    await mkdir(folder, { mode: 0o700 });
    for (const item of queue.images) await writeFile(path.join(folder, item.name), await queue.read(item.id), { mode: 0o600, flag: 'wx' });
    if (prompt) clipboard.writeText(prompt);
    const tab = bridge.tabs.find(t => t.id === tabId);
    if (tab) bridge.focus(tab);
    // The local export is the user's explicit manual fallback; the queue remains untouched.
    publish('Captures exported; prompt copied. Attach the PNGs in your conversation, paste the prompt, and submit. Queue retained.');
    return folder;
  });
  handle('settings', async (_event, value) => {
    const next = SettingsSchema.parse(value);
    if (normalizeShortcut(next.shortcut, process.platform === 'darwin') !== normalizeShortcut(settings.shortcut, process.platform === 'darwin')) {
      let registered = false;
      try { registered = globalShortcut.register(next.shortcut, () => void capture().catch(e => publish(e.message, true))); } catch {}
      if (!registered) throw new Error('This shortcut is invalid or already in use. Choose another.');
      globalShortcut.unregister(settings.shortcut);
    }
    settings = next; window.setAlwaysOnTop(settings.alwaysOnTop);
    await writeFile(dataPath('settings.json'), JSON.stringify(settings), { mode: 0o600 }); publish('Settings saved.');
  });
  handle('hide', () => window.hide());
  handle('quit', () => app.quit());
  handle('resize', (_event, expanded) => { z.boolean().parse(expanded); const area = screen.getDisplayMatching(window.getBounds()).workArea; const height = Math.min(expanded ? 650 : 112, area.height); const width = Math.min(720, area.width); const bounds = window.getBounds(); window.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) }); });
  handle('unpair', () => bridge.unpair());
  const extensionFolder = () => app.isPackaged ? path.join(process.resourcesPath, 'browser-extension') : path.join(root, 'dist/extension');
  handle('extensionFolder', () => extensionFolder());
  handle('revealExtension', async () => { const error = await shell.openPath(extensionFolder()); if (error) throw new Error(error); });
  handle('captureSource', event => {
    const item = overlays.get(event.sender.id)!;
    const size = item.image.getSize();
    return { dataUrl: item.image.toDataURL(), width: size.width, height: size.height, displayId: item.display.id, captureMode: settings.captureMode } satisfies CaptureSource;
  }, true);
  handle('finishCapture', async (event, value) => {
    const rect = z.object({ x: z.number().min(0), y: z.number().min(0), width: z.number().min(2), height: z.number().min(2) }).strict().parse(value);
    const item = overlays.get(event.sender.id)!;
    const bounds = item.display.bounds, size = item.image.getSize();
    const x = Math.round(rect.x * size.width / bounds.width), y = Math.round(rect.y * size.height / bounds.height);
    const width = Math.min(Math.round(rect.width * size.width / bounds.width), size.width - x), height = Math.min(Math.round(rect.height * size.height / bounds.height), size.height - y);
    if (x < 0 || y < 0 || width < 2 || height < 2 || x >= size.width || y >= size.height) throw new Error('Choose a region inside the screen.');
    const image = item.image.crop({ x, y, width, height });
    const buffer = image.toPNG();
    await serial(() => queue.add(buffer, { width, height, thumbnail: image.resize({ width: Math.min(260, width) }).toDataURL() }));
    closeOverlays(); publish('Capture added. Keep going, or send when ready.');
  }, true);
  handle('cancelCapture', () => closeOverlays(), true);
}
if (process.env.SNAPFLOW_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.SNAPFLOW_TEST_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('before-quit', () => { (app as any).isQuitting = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); void bridge?.close(); });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
    try { settings = SettingsSchema.parse(JSON.parse(await readFile(dataPath('settings.json'), 'utf8'))); } catch {}
    queue = new CaptureQueue(dataPath('captures'));
    try { await queue.load(); } catch (e: any) { queueHealthy = false; status = e.message; error = true; }
    try { prepared = z.object({ ids: z.array(z.string().uuid()), tabId: z.number().int(), url: z.string().url(), promptDigest: z.string().regex(/^[a-f0-9]{64}$/), time: z.number() }).parse(JSON.parse(await readFile(dataPath('prepared.json'), 'utf8'))); } catch {}
    const nativeFile = dataPath('native-bridge.json');
    let nativeToken: string;
    try { nativeToken = z.string().regex(/^[a-f0-9]{64}$/).parse(JSON.parse(await readFile(nativeFile, 'utf8')).token); } catch { nativeToken = randomBytes(32).toString('hex'); }
    await writeFile(nativeFile, JSON.stringify({ token: nativeToken, port: 47831 }), { mode: 0o600 });
    const nativeConfig = JSON.parse(await readFile(path.join(root, 'dist/native-config.json'), 'utf8')) as { origins: string[] };
    bridge = new BrowserBridge(await loadBinding(), bindingFile, { token: nativeToken, origins: nativeConfig.origins });
    bridge.on('change', () => publish()); bridge.on('progress', message => publish(message));
    try { await bridge.listen(); } catch (e: any) { status = `Browser bridge could not start (${e.code || e.message}). Close other SnapFlow instances and restart. Local captures still work.`; error = true; }
    registerIPC(); makeWindow();
    try { if (!globalShortcut.register(settings.shortcut, () => void capture().catch(e => publish(e.message, true)))) publish('Global shortcut is already in use. Set another shortcut in Settings.', true); }
    catch { publish('Saved shortcut is unavailable. Choose another in Settings.', true); }
  }).catch(e => { dialog.showErrorBox('SnapFlow could not start', e.message); app.quit(); });
}
