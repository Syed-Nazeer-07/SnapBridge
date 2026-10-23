import { randomBytes } from 'node:crypto';
import { fixture as makeFixture } from './site-fixture.mjs';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { mkdtemp, rm, readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
await mkdir('.test-results', { recursive: true });
await build({ entryPoints: ['desktop/bridge.ts'], outfile: '.test-results/bridge.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { BrowserBridge } = await import(pathToFileURL(path.resolve('.test-results/bridge.mjs')));
const nativeConfig=JSON.parse(await readFile('dist/native-config.json','utf8'));
const nativeToken=randomBytes(32).toString('hex');
const bridge = new BrowserBridge(null, async () => {}, {token:nativeToken,origins:nativeConfig.origins});
await bridge.listen();
const profile = await mkdtemp(path.join(tmpdir(), 'snapflow-browser-'));
const dataPath=path.join(profile,'data'); await mkdir(dataPath);
await writeFile(path.join(dataPath,'native-bridge.json'),JSON.stringify({token:nativeToken}));
const wrapper=path.join(profile,'native-host');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
await writeFile(wrapper,`#!/bin/sh\nexec ${quote(process.env.SNAPFLOW_DOTNET||'dotnet')} ${quote(path.resolve('dist/native-host/linux-x64/SnapFlow.NativeHost.dll'))} "$@"\n`);
await chmod(wrapper,0o700);
for(const directory of [path.join(profile,'NativeMessagingHosts')]){await mkdir(directory,{recursive:true});
 await writeFile(path.join(directory,'app.snapflow.bridge.json'),JSON.stringify({name:'app.snapflow.bridge',description:'SnapFlow integration test',path:wrapper,type:'stdio',allowed_origins:nativeConfig.origins.map(origin=>origin+'/')}));
}
const extension = path.resolve('dist/extension');
const png = await readFile('assets/icon.png');
const base64 = png.toString('base64');
let context;
bridge.on('progress', message => console.log('Progress:', message));
bridge.on('change', () => console.log('Bridge:', bridge.connected, bridge.tabs.length, 'tabs'));
async function waitFor(fn, timeout = 12_000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error('Browser readiness timeout'); }

try {
  console.log('Starting Chromium extension test');
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: false, ignoreDefaultArgs: ['--disable-extensions'], env: { ...process.env, SNAPFLOW_DATA_DIR:dataPath, XDG_CACHE_HOME: path.join(profile, 'cache'), XDG_CONFIG_HOME: path.join(profile, 'config'), DISPLAY: process.env.DISPLAY || ':99' }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--enable-unsafe-extension-debugging', '--disable-dev-shm-usage', '--disable-gpu'] });
  context.setDefaultTimeout(15_000); console.log('Chromium launched', context.serviceWorkers().map(w => w.url()));
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: makeFixture('ChatGPT', base64) }));
  await context.route('https://gemini.google.com/**', route => route.fulfill({ contentType: 'text/html', body: makeFixture('Gemini', base64) }));
  let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).hostname; console.log('Extension loaded', id);
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  console.log('Popup opened; connecting native host');
  await popup.locator('#connect').click();
  try { await waitFor(() => bridge.connected); } catch { throw new Error('Native connection failed: '+await popup.locator('#status').innerText()); } console.log('Native host connected');
  const chatgpt = await context.newPage(); await chatgpt.goto('https://chatgpt.com/c/snapflow-test');
  const gemini = await context.newPage(); await gemini.goto('https://gemini.google.com/app/snapflow-test');
  await waitFor(() => bridge.tabs.length === 2);
  const job = provider => ({ tab: bridge.tabs.find(t => t.provider === provider), images: [{ id: 'first', name: 'first.png', base64 }, { id: 'second', name: 'second.png', base64 }], prompt: 'Explain these two captures.' });
  // Draft protection: no overwriting text or uploading into an existing draft.
  await chatgpt.locator('#prompt-textarea').fill('Existing unsent draft');
  await assert.rejects(bridge.prepare(job('ChatGPT')), /unsent draft/);
  assert.equal(await chatgpt.locator('#prompt-textarea').inputValue(), 'Existing unsent draft');
  assert.equal(await chatgpt.evaluate(() => window.fixture.submissions.length), 0);
  await chatgpt.locator('#prompt-textarea').fill('');
  for (const [provider,page] of [['ChatGPT',chatgpt],['Gemini',gemini]]) {
    const evidence=await bridge.prepare(job(provider)); assert.match(evidence,/Nothing was submitted/);
    assert.equal(await page.evaluate(()=>window.fixture.submissions.length),0,'Extension never clicks Send');
    assert.equal(await page.locator('textarea,[contenteditable]').evaluate(el=>el.value??el.innerText),'Explain these two captures.');
    const files=await page.locator('input[type=file]').evaluate(async input=>Promise.all([...input.files].map(async f=>[...new Uint8Array(await f.arrayBuffer())])));
    assert.equal(files.length,2); for(const file of files)assert.deepEqual(Buffer.from(file),png);
    await assert.rejects(bridge.prepare(job(provider)),/unsent draft/);
    await page.locator('#send').click(); await page.waitForFunction(()=>window.fixture.submissions.length===1);
  }
  // A provider upload error must never trigger submission.
  await gemini.evaluate(() => { window.fixture.failUpload = true; });
  await assert.rejects(bridge.prepare(job('Gemini')), /attachment error/);
  assert.equal(await gemini.evaluate(() => window.fixture.submissions.length), 1);
  // A navigation between target selection and send is refused by the extension.
  const stale = job('ChatGPT'); await chatgpt.goto('https://chatgpt.com/c/different');
  await assert.rejects(bridge.prepare(stale), /navigated/);
  await popup.locator('#disconnect').click(); await waitFor(() => !bridge.connected);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('connectionPaused')).connectionPaused), true);
  await popup.locator('#connect').click(); await waitFor(() => bridge.connected);
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('connectionPaused')).connectionPaused), false);
  await popup.screenshot({ path: '.test-results/extension.png' });
  console.log('PASS: unpacked MV3 extension loaded in Chrome for Testing; automatic native host connection; real WebSocket bridge; eligible tab discovery; original-byte multi-image upload; prompt insertion; readiness wait; verified prepared drafts without any submission for both adapter fixtures; draft protection; upload error; navigation refusal. Live authenticated websites were not tested.');
} finally { await context?.close(); await bridge.close(); await rm(profile, { recursive: true, force: true }); }
