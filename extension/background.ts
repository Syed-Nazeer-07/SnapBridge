import { ChunkReceiver } from './native-transport';
import { eligibleUrl, PORT, TabSchema, type SendJob } from '../shared/protocol';
let socket: WebSocket | undefined;
let connected = false;
let paused = false;
let nativePort: chrome.runtime.Port | undefined;
let status = 'Open SnapFlow, then pair using the code in Settings.';
let heartbeat: ReturnType<typeof setInterval> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let activeJob: string | null = null;
let generation = 0;
const notify = (message: string) => { status = message; };
const emit = (value: unknown) => { if (nativePort) nativePort.postMessage(value); else if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
async function tabs() {
  const found = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://gemini.google.com/*'] });
  return found.filter(t => t.id !== undefined && t.url && eligibleUrl(t.url)).slice(0, 100).map(t => ({ id: t.id!, title: (t.title || 'Conversation').slice(0, 240), url: t.url!, provider: t.url!.startsWith('https://chatgpt.com/') ? 'ChatGPT' as const : 'Gemini' as const }));
}
async function publishTabs() { if (connected) emit({ type: 'tabs', tabs: await tabs() }); }
async function focusTab(tab: SendJob['tab']) {
  const current = await chrome.tabs.get(tab.id);
  if (!current.url || !eligibleUrl(current.url) || current.url !== tab.url) throw new Error('The selected tab navigated or closed. Select it again in SnapFlow.');
  await chrome.tabs.update(tab.id, { active: true });
  if (current.windowId !== undefined) await chrome.windows.update(current.windowId, { focused: true });
}
async function execute(job: SendJob) {
  const parsedTab = TabSchema.safeParse(job.tab);
  if (!parsedTab.success || typeof job.prompt !== 'string' || job.prompt.length > 20_000 || !Array.isArray(job.images) || !/^[a-f0-9-]{36}$/.test(job.jobId)) return;
  const key = `job:${job.jobId}`;
  const previous = (await chrome.storage.session.get(key))[key];
  if (previous || activeJob) { emit({ type: 'result', jobId: job.jobId, ok: false, error: 'Duplicate or concurrent transfer refused. Check the conversation before retrying.' }); return; }
  activeJob = job.jobId;
  await chrome.storage.session.set({ [key]: { state: 'started', time: Date.now() } });
  try {
    await focusTab(job.tab);
    emit({ type: 'progress', jobId: job.jobId, message: 'Preparing the selected conversation…' });
    try { await chrome.tabs.sendMessage(job.tab.id, { type: 'snapflow:ping' }); }
    catch { await chrome.scripting.executeScript({ target: { tabId: job.tab.id }, files: ['content.js'] }); }
    const response = await chrome.tabs.sendMessage(job.tab.id, { type: 'snapflow:prepare', job });
    if (!response || typeof response.ok !== 'boolean') throw new Error('The website did not respond. Queue retained; use manual export.');
    await chrome.storage.session.set({ [key]: { state: response.ok ? 'prepared' : 'uncertain', time: Date.now() } });
    emit({ type: 'result', jobId: job.jobId, ok: response.ok, outcome: response.outcome, evidence: response.evidence, error: response.error });
    notify(response.ok ? 'Draft prepared. Review and press Send in your browser.' : response.error);
  } catch (e: any) {
    await chrome.storage.session.set({ [key]: { state: 'uncertain', time: Date.now() } });
    const error = `${e.message || 'Transfer interrupted.'} Queue retained. Check the conversation before retrying.`;
    emit({ type: 'result', jobId: job.jobId, ok: false, error: error.slice(0, 1000) }); notify(error);
  } finally { activeJob = null; }
}
async function handleIncoming(msg: any) {
  if (msg.type === 'paired') await chrome.storage.local.set({ bridgeToken: msg.token });
  if (msg.type === 'ready') {
    connected = true; notify('Connected. Prepare a draft from the desktop app.');
    await publishTabs(); clearInterval(heartbeat);
    heartbeat = setInterval(() => { emit({ type: 'ping' }); void publishTabs(); }, 20_000);
  }
  if (msg.type === 'error') notify(msg.error);
  if (msg.type === 'prepare' && connected) void execute(msg);
  if (msg.type === 'focus' && connected) await focusTab(TabSchema.parse(msg.tab));
}
async function connectNative() {
  if (connected || nativePort) return;
  generation++; socket?.close(); socket = undefined; clearInterval(heartbeat); clearTimeout(reconnect);
  const currentGeneration = generation;
  try {
    const port = chrome.runtime.connectNative('app.snapflow.bridge'); nativePort = port;
    const receiver = new ChunkReceiver();
    notify('Connecting to the installed SnapFlow app…');
    port.onMessage.addListener(message => {
      if (currentGeneration !== generation) return;
      try { const value = receiver.accept(message); if (value) void handleIncoming(value).catch(e => notify(e.message)); }
      catch (e: any) { notify(e.message); port.disconnect(); }
    });
    port.onDisconnect.addListener(() => {
      if (currentGeneration !== generation) return;
      const error = chrome.runtime.lastError?.message;
      nativePort = undefined; connected = false; clearInterval(heartbeat);
      notify(error ? `Native connection unavailable: ${error}. Install or update SnapFlow, then reconnect.` : 'Desktop disconnected. Your captures are retained.');
    });
  } catch { nativePort = undefined; notify('The native host is unavailable. Install SnapFlow or use manual pairing for a source build.'); }
}
async function connect(code?: string) {
  generation++; nativePort?.disconnect(); nativePort = undefined; const currentGeneration = generation;
  clearTimeout(reconnect); clearInterval(heartbeat); connected = false;
  socket?.close();
  const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
  if (!code && !bridgeToken) { notify('Paste the pairing code from SnapFlow Settings.'); return; }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`); socket = ws;
  notify('Connecting to SnapFlow…');
  ws.addEventListener('open', () => ws.send(JSON.stringify(code ? { type: 'pair', code } : { type: 'auth', token: bridgeToken })));
  ws.addEventListener('message', event => {
    if (generation !== currentGeneration) return;
    void handleIncoming(JSON.parse(event.data)).catch(e => notify(e.message || 'Bridge message failed.'));
  });
  ws.addEventListener('close', event => {
    if (generation !== currentGeneration) return;
    connected = false; clearInterval(heartbeat);
    if (event.code === 1008 || event.reason === 'Unpaired') { notify('Pairing expired or rejected. Enter a fresh code from Settings.'); return; }
    notify('SnapFlow is offline. Start the desktop app to reconnect.');
    reconnect = setTimeout(() => void connect(), 4000);
  });
  ws.addEventListener('error', () => notify('Cannot reach SnapFlow. Start the desktop app, then connect.'));
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'snapflow:progress' && sender.tab && message.jobId === activeJob && typeof message.message === 'string') {
    emit({ type: 'progress', jobId: message.jobId, message: message.message.slice(0, 300) }); return false;
  }
  // Pairing is accepted only from this extension's popup, never from a content script.
  if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
  if (message?.type === 'connect') { paused = false; void chrome.storage.local.set({ connectionPaused: false }).then(() => connectNative()).then(() => reply({ ok: true })); return true; }
  if (message?.type === 'status') { reply({ connected, status }); return false; }
  if (message?.type === 'pair' && typeof message.code === 'string' && /^[a-f0-9]{48}$/.test(message.code)) { paused = false; void chrome.storage.local.set({ connectionPaused: false }).then(() => connect(message.code)).then(() => reply({ ok: true })); return true; }
  if (message?.type === 'disconnect') { paused = true; void chrome.storage.local.set({ connectionPaused: true }); generation++; nativePort?.disconnect(); nativePort = undefined; socket?.close(); socket = undefined; clearInterval(heartbeat); clearTimeout(reconnect); connected = false; void chrome.storage.local.remove('bridgeToken').then(() => { notify('Disconnected. Pair again to reconnect.'); reply({ ok: true }); }); return true; }
  return false;
});
chrome.tabs.onUpdated.addListener(() => void publishTabs());
chrome.tabs.onRemoved.addListener(() => void publishTabs());
chrome.tabs.onCreated.addListener(() => void publishTabs());
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (!paused && !connected && !activeJob) void connectNative(); });
void chrome.storage.local.get('connectionPaused').then(saved => { paused = saved.connectionPaused === true; if (!paused) void connectNative(); else notify('Disconnected. Click Connect when you are ready.'); });
