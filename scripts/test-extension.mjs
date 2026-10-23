import { fixture as makeFixture } from './site-fixture.mjs';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
await mkdir('.test-results', { recursive: true });
await build({ entryPoints: ['desktop/bridge.ts'], outfile: '.test-results/bridge.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { BrowserBridge } = await import(pathToFileURL(path.resolve('.test-results/bridge.mjs')));
const bridge = new BrowserBridge(null, async () => {});
await bridge.listen();
const profile = await mkdtemp(path.join(tmpdir(), 'snapflow-browser-'));
const extension = path.resolve('dist/extension');
const png = await readFile('assets/icon.png');
const base64 = png.toString('base64');
let context;
bridge.on('progress', message => console.log('Progress:', message));
bridge.on('change', () => console.log('Bridge:', bridge.connected, bridge.tabs.length, 'tabs'));
async function waitFor(fn, timeout = 12_000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error('Browser readiness timeout'); }

try {
  console.log('Starting Chromium extension test');
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(), headless: false, ignoreDefaultArgs: ['--disable-extensions'], env: { ...process.env, XDG_CACHE_HOME: path.join(profile, 'cache'), XDG_CONFIG_HOME: path.join(profile, 'config'), DISPLAY: process.env.DISPLAY || ':99' }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  context.setDefaultTimeout(15_000); console.log('Chromium launched', context.serviceWorkers().map(w => w.url()));
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: makeFixture('ChatGPT', base64) }));
  await context.route('https://gemini.google.com/**', route => route.fulfill({ contentType: 'text/html', body: makeFixture('Gemini', base64) }));
  let worker = context.serviceWorkers()[0]; if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).hostname; console.log('Extension loaded', id);
  const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  console.log('Popup opened');
  await popup.locator('#code').fill(bridge.code); await popup.getByRole('button', { name: 'Connect to SnapFlow' }).click();
  await waitFor(() => bridge.connected); console.log('Paired');
  const chatgpt = await context.newPage(); await chatgpt.goto('https://chatgpt.com/c/snapflow-test');
  const gemini = await context.newPage(); await gemini.goto('https://gemini.google.com/app/snapflow-test');
  await waitFor(() => bridge.tabs.length === 2);
  const job = provider => ({ tab: bridge.tabs.find(t => t.provider === provider), images: [{ id: 'first', name: 'first.png', base64 }, { id: 'second', name: 'second.png', base64 }], prompt: 'Explain these two captures.' });
  // Draft protection: no overwriting text or uploading into an existing draft.
  await chatgpt.locator('#prompt-textarea').fill('Existing unsent draft');
  await assert.rejects(bridge.send(job('ChatGPT')), /unsent draft/);
  assert.equal(await chatgpt.locator('#prompt-textarea').inputValue(), 'Existing unsent draft');
  assert.equal(await chatgpt.evaluate(() => window.fixture.submissions.length), 0);
  await chatgpt.locator('#prompt-textarea').fill('');
  for (const [provider, page] of [['ChatGPT', chatgpt], ['Gemini', gemini]]) {
    console.log('Testing', provider);
    const evidence = await bridge.send(job(provider)); assert.match(evidence, /new user turn/);
    const submissions = await page.evaluate(() => window.fixture.submissions);
    assert.equal(submissions.length, 1); assert.equal(submissions[0].text, 'Explain these two captures.');
    assert.equal(submissions[0].files.length, 2);
    for (const file of submissions[0].files) { assert.equal(file.type, 'image/png'); assert.deepEqual(Buffer.from(file.bytes), png); }
  }
  // A provider upload error must never trigger submission.
  await gemini.evaluate(() => { window.fixture.failUpload = true; });
  await assert.rejects(bridge.send(job('Gemini')), /attachment error/);
  assert.equal(await gemini.evaluate(() => window.fixture.submissions.length), 1);
  // A navigation between target selection and send is refused by the extension.
  const stale = job('ChatGPT'); await chatgpt.goto('https://chatgpt.com/c/different');
  await assert.rejects(bridge.send(stale), /navigated/);
  await popup.screenshot({ path: '.test-results/extension.png' });
  console.log('PASS: unpacked MV3 extension loaded in Chromium; popup pairing; real WebSocket bridge; eligible tab discovery; original-byte multi-image upload; prompt insertion; readiness wait; single submission and new-turn confirmation for both adapter fixtures; draft protection; upload error; navigation refusal. Live authenticated websites were not tested.');
} finally { await context?.close(); await bridge.close(); await rm(profile, { recursive: true, force: true }); }
