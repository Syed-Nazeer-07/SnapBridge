import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { WebSocket } from 'ws';
import { fixture } from './site-fixture.mjs';
await mkdir('.test-results', { recursive: true });
await build({ entryPoints: ['desktop/bridge.ts'], outfile: '.test-results/bridge.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { BrowserBridge } = await import(pathToFileURL(path.resolve('.test-results/bridge.mjs')));
const bridge = new BrowserBridge(null, async () => {}); await bridge.listen();
const directory = await mkdtemp(path.join(tmpdir(), 'snapflow-adapters-'));
const png = await readFile('assets/icon.png'); const base64 = png.toString('base64');
await writeFile(path.join(directory, 'chatgpt.html'), fixture('ChatGPT', base64));
await writeFile(path.join(directory, 'gemini.html'), fixture('Gemini', base64));
const content = await readFile('dist/extension/content.js', 'utf8');
const background = await readFile('dist/extension/background.js', 'utf8');
const id = 'a'.repeat(32); const origin = `chrome-extension://${id}`;
const intervals = new Set(), timeouts = new Set(), sockets = new Set();
const messages = [];
let app;
let page;
let receive;
let cachedTabs = [];
let stopping = false;
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
const storage = () => { const data = {}; return { async get(key) { return { [key]: data[key] }; }, async set(items) { Object.assign(data, items); }, async remove(key) { delete data[key]; } }; };
async function waitFor(fn, ms = 10_000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Adapter readiness timed out.'); }
try {
  app = await electron.launch({ args: ['--no-sandbox', '--disable-gpu', path.resolve('scripts/adapter-host.cjs')], env: { ...process.env, SNAPFLOW_FIXTURES: directory, DISPLAY: process.env.DISPLAY || ':99', XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory } });
  page = await app.firstWindow();
  await page.addInitScript(({ id }) => {
    window.__listener = undefined;
    window.chrome = { runtime: { id, onMessage: { addListener(fn) { window.__listener = fn; } }, async sendMessage(message) { return window.__progress(message); } } };
  }, { id });
  await page.exposeFunction('__progress', message => { messages.push(message); if (receive) receive(message, { id, tab: { id: 31 }, url: page.url() }, () => {}); });
  const onUpdated = event();
  const chrome = {
    runtime: { id, getURL: value => `${origin}/${value}`, onMessage: { addListener(fn) { receive = fn; } } },
    storage: { local: storage(), session: storage() },
    tabs: {
      async query() { return cachedTabs; }, async get(tabId) { if (tabId !== 31) throw new Error('No tab'); return { id: 31, url: page.url(), windowId: 1 }; },
      async update() { await page.bringToFront(); },
      async sendMessage(tabId, message) {
        return page.evaluate(({ message, id }) => new Promise((resolve, reject) => {
          if (!window.__listener) return reject(new Error('No content script'));
          const handled = window.__listener(message, { id }, resolve);
          if (handled === false && message.type !== 'snapflow:ping') resolve({ ok: false, error: 'Message refused.' });
        }), { message, id });
      },
      onUpdated, onRemoved: event(), onCreated: event()
    },
    windows: { async update() {} },
    scripting: { async executeScript() { await page.addScriptTag({ content }); } },
    alarms: { create() {}, onAlarm: event() }
  };
  const context = vm.createContext({ chrome, URL, console, WebSocket: class extends WebSocket { constructor(url) { super(url, { origin }); sockets.add(this); } },
    setTimeout: (...args) => { if (stopping) return 0; const timer = setTimeout(...args); timeouts.add(timer); return timer; }, clearTimeout,
    setInterval: (...args) => { if (stopping) return 0; const timer = setInterval(...args); intervals.add(timer); return timer; }, clearInterval
  });
  vm.runInContext(background, context);
  await new Promise(resolve => receive({ type: 'pair', code: bridge.code }, { id, url: `${origin}/popup.html` }, resolve));
  await waitFor(() => bridge.connected);
  async function load(provider) {
    const url = provider === 'ChatGPT' ? 'https://chatgpt.com/c/fixture' : 'https://gemini.google.com/app/fixture';
    await page.goto(url); cachedTabs = [{ id: 31, title: `${provider} fixture`, url, windowId: 1 }];
    for (const fn of onUpdated.listeners) fn();
    await waitFor(() => bridge.tabs[0]?.url === url);
  }
  function job() { return { tab: bridge.tabs[0], images: [{ id: 'first', name: 'first.png', base64 }, { id: 'second', name: 'second.png', base64 }], prompt: 'Compare these two captures.' }; }
  for (const provider of ['ChatGPT', 'Gemini']) {
    await load(provider);
    const composer = page.locator('textarea,[contenteditable]');
    await composer.fill('Do not overwrite my draft');
    await assert.rejects(bridge.prepare(job()), /unsent draft/);
    assert.equal(await composer.innerText().catch(() => ''), provider === 'Gemini' ? 'Do not overwrite my draft' : '');
    if (provider === 'ChatGPT') assert.equal(await composer.inputValue(), 'Do not overwrite my draft');
    await composer.fill('');
    const evidence = await bridge.prepare(job()); assert.match(evidence,/Nothing was submitted/);
    assert.equal(await page.evaluate(()=>window.fixture.submissions.length),0,'Preparation must never submit');
    const files=await page.locator('input[type=file]').evaluate(async input=>Promise.all([...input.files].map(async f=>[...new Uint8Array(await f.arrayBuffer())])));
    for(const file of files)assert.deepEqual(Buffer.from(file),png);
    assert.equal(await composer.evaluate(el=>el.value??el.innerText),'Compare these two captures.');
    await assert.rejects(bridge.prepare(job()),/unsent draft/);
    await page.locator('#send').click(); await page.waitForFunction(()=>window.fixture.submissions.length===1);
    const duplicateJob = { ...job(), type:'prepare', jobId:randomUUID(), images:[], prompt:'Text-only draft.' };
    const first=await chrome.tabs.sendMessage(31,{type:'snapflow:prepare',job:duplicateJob});assert.equal(first.ok,true);
    const second=await chrome.tabs.sendMessage(31,{type:'snapflow:prepare',job:duplicateJob});assert.equal(second.ok,false);assert.match(second.error,/Duplicate/);
    assert.equal(await page.evaluate(()=>window.fixture.submissions.length),1,'Text preparation also never submits');
    await load(provider); await page.evaluate(()=>{window.fixture.failUpload=true;});
    await assert.rejects(bridge.prepare(job()),/attachment error/);
    assert.equal(await page.evaluate(()=>window.fixture.submissions.length),0);
    console.log(`PASS ${provider}: real DOM multi-file upload with exact original bytes; prompt insertion; upload readiness; no automatic submission; existing-draft protection; duplicate refusal; text-only draft; upload-error retention.`);
  }
  // Background rejects a target that navigated after selection and refuses replayed job IDs.
  const stale = job(); await page.goto('https://gemini.google.com/app/different');
  await assert.rejects(bridge.prepare(stale), /navigated/);
  const replayId = randomUUID(); await chrome.storage.session.set({ [`job:${replayId}`]: { state: 'confirmed' } });
  // Capture the authenticated socket's outbound result for a replay of a previously persisted job ID.
  let replayResult;
  bridge.on('change', () => {});
  const socket = [...sockets].find(ws => ws.readyState === WebSocket.OPEN);
  const originalSend = socket.send.bind(socket);
  socket.send = (data, ...args) => { const message = JSON.parse(String(data)); if (message.type === 'result' && message.jobId === replayId) replayResult = message; return originalSend(data, ...args); };
  // Deliver through the browser socket's incoming WebSocket event path.
  socket.emit('message', Buffer.from(JSON.stringify({ ...stale, type: 'prepare', jobId: replayId })), false);
  await waitFor(() => replayResult); assert.equal(replayResult.ok, false); assert.match(replayResult.error, /Duplicate/);
  assert.ok(messages.some(m => /uploading/.test(m.message)), 'Upload progress reported');
  console.log('PASS background script: popup pairing; authenticated WebSocket; provider tab discovery; dispatch to real content code; navigation refusal; session-persisted replay protection. Chrome APIs were simulated; unpacked MV3 loading and live authenticated sites were not tested.');
} finally {
  stopping = true;
  for (const timer of intervals) clearInterval(timer); for (const timer of timeouts) clearTimeout(timer);
  for (const ws of sockets) ws.terminate(); await bridge.close(); await app?.close(); await rm(directory, { recursive: true, force: true });
}
