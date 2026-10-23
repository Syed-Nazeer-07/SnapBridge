import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
await mkdir('.test-results', { recursive: true });
await build({ entryPoints: ['desktop/bridge.ts'], outfile: '.test-results/bridge.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external' });
await build({ entryPoints: ['extension/native-transport.ts'], outfile: '.test-results/chunks.mjs', bundle: true, platform: 'node', format: 'esm' });
const { BrowserBridge } = await import(pathToFileURL(path.resolve('.test-results/bridge.mjs')));
const { ChunkReceiver } = await import(pathToFileURL(path.resolve('.test-results/chunks.mjs')));
const config = JSON.parse(await readFile('dist/native-config.json', 'utf8'));
const token = randomBytes(32).toString('hex');
const bridge = new BrowserBridge(null, async () => {}, { token, origins: config.origins });
await bridge.listen();
const directory = await mkdtemp(path.join(tmpdir(), 'snapflow-native-'));
await writeFile(path.join(directory, 'native-bridge.json'), JSON.stringify({ token }), { mode: 0o600 });
let child;
try {
  const arch = process.env.SNAPFLOW_ARCH || 'x64';
  const command = process.platform === 'win32' ? path.resolve(`dist/native-host/win-${arch}/SnapFlow.NativeHost.exe`) : (process.env.SNAPFLOW_DOTNET || 'dotnet');
  const args = process.platform === 'win32' ? [] : [path.resolve('dist/native-host/linux-x64/SnapFlow.NativeHost.dll')];
  const launch = origin => spawn(command, [...args, origin+'/'], { env: { ...process.env, SNAPFLOW_DATA_DIR: directory }, stdio: ['pipe','pipe','pipe'] });
  const rejected = launch(`chrome-extension://${'b'.repeat(32)}`);
  const bad = []; rejected.stdout.on('data', b => bad.push(b));
  await new Promise(resolve => rejected.once('exit', resolve));
  assert.match(Buffer.concat(bad).subarray(4).toString(), /not authorized/);
  child = launch(config.origins[0]);
  const messages = []; let buffer = Buffer.alloc(0); const receiver = new ChunkReceiver();
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0); assert.ok(length <= 1024*1024);
      const raw = JSON.parse(buffer.subarray(4,4+length)); buffer = buffer.subarray(4+length);
      const message = receiver.accept(raw); if (message) messages.push(message);
    }
  });
  async function receive(type) { for(let n=0;n<200;n++){ const i=messages.findIndex(m=>m.type===type); if(i>=0)return messages.splice(i,1)[0]; await new Promise(r=>setTimeout(r,25)); } throw new Error('Native host timed out waiting for '+type); }
  function emit(message, fragmented=false) { const body=Buffer.from(JSON.stringify(message)); const frame=Buffer.alloc(4+body.length); frame.writeUInt32LE(body.length);body.copy(frame,4); if(fragmented){ child.stdin.write(frame.subarray(0,1));child.stdin.write(frame.subarray(1,3));child.stdin.write(frame.subarray(3)); } else child.stdin.write(frame); }
  await receive('ready'); assert.equal(bridge.connected,true);
  const tab={id:1,title:'Native integration',provider:'ChatGPT',url:'https://chatgpt.com/c/native-test'};
  emit({type:'tabs',tabs:[tab]},true);
  for(let i=0;i<100 && !bridge.tabs.length;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(bridge.tabs[0].url,tab.url);
  const image={id:'capture',name:'capture.png',base64:randomBytes(250_000).toString('base64')};
  const pending=bridge.prepare({tab,images:[image],prompt:'Prepare, never submit.'});
  const job=await receive('prepare');assert.equal(job.images[0].base64,image.base64);assert.equal(job.prompt,'Prepare, never submit.');
  emit({type:'result',jobId:job.jobId,ok:true,outcome:'prepared',evidence:'Draft is ready, nothing submitted.'});
  assert.match(await pending,/nothing submitted/);
  const exited=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();
  const code=await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Host did not exit after browser disconnect')),5000).unref())]);
  assert.equal(code,0);
  console.log('PASS native host: origin allowlist, desktop authentication, fragmented stdin framing, tab discovery, multi-frame screenshot transport, prepared result, and clean browser disconnect.');
} finally { child?.kill(); await bridge.close(); await rm(directory,{recursive:true,force:true}); }
