import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
const ids = [...new Set([id, ...(process.env.SNAPFLOW_EXTENSION_IDS || '').split(',').filter(Boolean)])];
if (ids.some(value => !/^[a-p]{32}$/.test(value))) throw new Error('Invalid extension ID.');
const config = { origins: ids.map(value => `chrome-extension://${value}`) };
await mkdir('dist', { recursive: true });
await writeFile('dist/native-config.json', JSON.stringify(config));
