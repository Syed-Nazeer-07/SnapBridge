import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { BrowserBridge, extensionOrigin, type Binding } from '../desktop/bridge';
import { eligibleUrl, ClientMessage } from '../shared/protocol';
const origin = `chrome-extension://${'a'.repeat(32)}`;
let bridge: BrowserBridge;
let clients: WebSocket[] = [];
const tab = { id: 17, title: 'Existing conversation', provider: 'ChatGPT' as const, url: 'https://chatgpt.com/c/example' };
async function start(binding: Binding | null = null) { bridge = new BrowserBridge(binding, async () => {}); await bridge.listen(0); }
function client(customOrigin = origin) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`, { origin: customOrigin }); clients.push(ws);
  const messages: any[] = [];
  ws.on('message', data => messages.push(JSON.parse(String(data))));
  const waitFor = async (type: string) => { for (let i = 0; i < 100; i++) { const index = messages.findIndex(m => m.type === type); if (index >= 0) return messages.splice(index, 1)[0]; await new Promise(r => setTimeout(r, 10)); } throw new Error(`No ${type} message`); };
  return { ws, waitFor, open: new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); }) };
}
async function paired() { const c = client(); await c.open; c.ws.send(JSON.stringify({ type: 'pair', protocol: 2, code: bridge.code })); const pair = await c.waitFor('paired'); await c.waitFor('ready'); return { ...c, token: pair.token }; }
afterEach(async () => { clients.forEach(c => c.terminate()); clients = []; if (bridge) await bridge.close(); });
describe('authenticated loopback browser bridge', () => {
  it('accepts extension origins and rejects web origins, lookalikes, and insecure AI URLs', () => {
    expect(extensionOrigin(origin)).toBe(true);
    for (const url of ['https://chatgpt.com', 'null', `${origin}.evil`, 'chrome-extension://bad']) expect(extensionOrigin(url)).toBe(false);
    for (const url of ['http://chatgpt.com/c/a', 'https://chatgpt.com.evil/c/a', 'https://gemini.google.com:123/a', 'file:///tmp/a']) expect(eligibleUrl(url)).toBe(false);
    expect(ClientMessage.safeParse({ type: 'tabs', tabs: [{ ...tab, url: 'https://evil.example/' }] }).success).toBe(false);
  });
  it('rejects an ordinary website before WebSocket connection', async () => {
    await start(); const c = client('https://chatgpt.com'); await expect(c.open).rejects.toThrow();
  });
  it('requires a secret before accepting tab updates', async () => {
    await start(); const c = client(); await c.open; c.ws.send(JSON.stringify({ type: 'tabs', tabs: [tab] }));
    await c.waitFor('error'); expect(bridge.tabs).toEqual([]); expect(bridge.connected).toBe(false);
  });
  it('pairs once, rotates the code, then accepts token authentication', async () => {
    await start(); const code = bridge.code; const c = await paired();
    expect(bridge.code).not.toBe(code); expect(bridge.connected).toBe(true);
    const second = client(); await second.open; second.ws.send(JSON.stringify({ type: 'auth', protocol: 2, token: c.token })); await second.waitFor('ready');
    second.ws.send(JSON.stringify({ type: 'tabs', tabs: [tab] })); await new Promise(r => setTimeout(r, 20)); expect(bridge.tabs).toEqual([tab]);
  });
  it('pins authentication to the paired extension origin', async () => {
    await start(); const c = await paired(); const other = client(`chrome-extension://${'b'.repeat(32)}`); await other.open;
    other.ws.send(JSON.stringify({ type: 'auth', protocol: 2, token: c.token })); await other.waitFor('error');
  });
  it('rejects false success without submission evidence and prevents concurrent sends', async () => {
    await start(); const c = await paired(); const pending = bridge.prepare({ tab, images: [], prompt: 'hello' });
    const failure = expect(pending).rejects.toThrow('could not be confirmed');
    await expect(bridge.prepare({ tab, images: [], prompt: 'duplicate' })).rejects.toThrow('already running');
    const job = await c.waitFor('prepare'); c.ws.send(JSON.stringify({ type: 'result', jobId: job.jobId, ok: true })); await failure;
  });
  it('matches results to job ID and reports verified success', async () => {
    await start(); const c = await paired(); const pending = bridge.prepare({ tab, images: [], prompt: 'hello' }); const job = await c.waitFor('prepare');
    c.ws.send(JSON.stringify({ type: 'result', jobId: randomUUID(), ok: true, outcome: 'prepared', evidence: 'unrelated' }));
    c.ws.send(JSON.stringify({ type: 'result', jobId: job.jobId, ok: true, outcome: 'prepared', evidence: 'New user turn with expected images.' }));
    await expect(pending).resolves.toMatch('expected images');
  });
  it('fails an in-flight send on disconnect rather than claiming success', async () => {
    await start(); const c = await paired(); const pending = bridge.prepare({ tab, images: [], prompt: 'hello' });
    const failure = expect(pending).rejects.toThrow('Check the conversation'); c.ws.close(); await failure;
  });
});

it('refuses an older extension protocol before accepting a connection', async () => { await start(); const c=client();await c.open;c.ws.send(JSON.stringify({type:'pair',code:bridge.code}));await c.waitFor('error');expect(bridge.connected).toBe(false); });
