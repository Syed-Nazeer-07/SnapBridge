import { eligibleUrl, PORT, TabSchema, type SendJob } from '../shared/protocol';
let socket: WebSocket | undefined;
let connected = false;
let status = 'Open SnapFlow, then pair using the code in Settings.';
let heartbeat: ReturnType<typeof setInterval> | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let activeJob: string | null = null;
let generation = 0;
const notify = (message: string) => { status = message; };
const emit = (value: unknown) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
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
    const response = await chrome.tabs.sendMessage(job.tab.id, { type: 'snapflow:send', job });
    if (!response || typeof response.ok !== 'boolean') throw new Error('The website did not respond. Queue retained; use manual export.');
    await chrome.storage.session.set({ [key]: { state: response.ok ? 'confirmed' : 'uncertain', time: Date.now() } });
    emit({ type: 'result', jobId: job.jobId, ok: response.ok, evidence: response.evidence, error: response.error });
    notify(response.ok ? 'Submission confirmed by the conversation.' : response.error);
  } catch (e: any) {
    await chrome.storage.session.set({ [key]: { state: 'uncertain', time: Date.now() } });
    const error = `${e.message || 'Transfer interrupted.'} Queue retained. Check the conversation before retrying.`;
    emit({ type: 'result', jobId: job.jobId, ok: false, error: error.slice(0, 1000) }); notify(error);
  } finally { activeJob = null; }
}
async function connect(code?: string) {
  generation++; const currentGeneration = generation;
  clearTimeout(reconnect); clearInterval(heartbeat); connected = false;
  socket?.close();
  const { bridgeToken } = await chrome.storage.local.get('bridgeToken');
  if (!code && !bridgeToken) { notify('Paste the pairing code from SnapFlow Settings.'); return; }
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/bridge`); socket = ws;
  notify('Connecting to SnapFlow…');
  ws.addEventListener('open', () => ws.send(JSON.stringify(code ? { type: 'pair', code } : { type: 'auth', token: bridgeToken })));
  ws.addEventListener('message', event => {
    if (generation !== currentGeneration) return;
    void (async () => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'paired') await chrome.storage.local.set({ bridgeToken: msg.token });
      if (msg.type === 'ready') {
        connected = true; notify('Connected securely to SnapFlow.');
        await publishTabs();
        heartbeat = setInterval(() => { emit({ type: 'ping' }); void publishTabs(); }, 20_000);
      }
      if (msg.type === 'error') notify(msg.error);
      if (msg.type === 'send' && connected) void execute(msg);
      if (msg.type === 'focus' && connected) await focusTab(TabSchema.parse(msg.tab));
    })().catch(e => notify(e.message || 'Bridge message failed.'));
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
  if (sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  if (message?.type === 'status') { reply({ connected, status }); return false; }
  if (message?.type === 'pair' && typeof message.code === 'string' && /^[a-f0-9]{48}$/.test(message.code)) { void connect(message.code).then(() => reply({ ok: true })); return true; }
  if (message?.type === 'disconnect') { generation++; socket?.close(); socket = undefined; clearInterval(heartbeat); clearTimeout(reconnect); connected = false; void chrome.storage.local.remove('bridgeToken').then(() => { notify('Disconnected. Pair again to reconnect.'); reply({ ok: true }); }); return true; }
  return false;
});
chrome.tabs.onUpdated.addListener(() => void publishTabs());
chrome.tabs.onRemoved.addListener(() => void publishTabs());
chrome.tabs.onCreated.addListener(() => void publishTabs());
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (!connected && !socket || socket?.readyState === WebSocket.CLOSED) void connect(); });
void connect();
