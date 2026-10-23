import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { MAX_BYTES, MAX_IMAGE_BYTES, type Screenshot } from '../shared/protocol';
export class CaptureQueue {
  private items: Screenshot[] = [];
  constructor(readonly directory: string) {}
  get images() { return this.items.map(item => ({ ...item })); }
  get bytes() { return this.items.reduce((total, item) => total + item.bytes, 0); }
  private file(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid capture ID.');
    return path.join(this.directory, `${id}.png`);
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let saved: Screenshot[];
    try { saved = JSON.parse(await readFile(path.join(this.directory, 'queue.json'), 'utf8')); }
    catch (e: any) { if (e.code === 'ENOENT') return; throw new Error('The saved queue could not be read. Captures have been left on disk.'); }
    if (!Array.isArray(saved)) throw new Error('Invalid saved queue. Captures have been left on disk.');
    let total = 0;
    for (const item of saved) {
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.thumbnail !== 'string' || !Number.isFinite(item.width) || !Number.isFinite(item.height)) throw new Error('Invalid capture metadata; original files are retained.');
      const buffer = await readFile(this.file(item.id));
      if (!isPNG(buffer) || buffer.length > MAX_IMAGE_BYTES || total + buffer.length > MAX_BYTES) throw new Error('Saved queue exceeds safe limits or has a damaged image. Original files are retained.');
      item.bytes = buffer.length; total += buffer.length;
    }
    this.items = saved;

  }
  private async commit(items: Screenshot[]) {
    const tmp = path.join(this.directory, 'queue.json.tmp');
    await writeFile(tmp, JSON.stringify(items), { mode: 0o600 });
    await rename(tmp, path.join(this.directory, 'queue.json'));
    this.items = items;
  }
  async add(buffer: Buffer, details: { width: number; height: number; thumbnail: string }) {
    if (!isPNG(buffer)) throw new Error('Capture is not a valid PNG image.');
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('This image exceeds 16 MB. Select a smaller region.');
    if (this.bytes + buffer.length > MAX_BYTES) throw new Error('The local queue has reached 128 MB. Send or remove some captures first.');
    const id = randomUUID();
    const item: Screenshot = { id, name: `SnapFlow-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}.png`, createdAt: Date.now(), bytes: buffer.length, ...details };
    await writeFile(this.file(item.id), buffer, { mode: 0o600, flag: 'wx' });
    try { await this.commit([...this.items, item]); } catch (e) { await unlink(this.file(item.id)); throw e; }
    return item;
  }
  async read(id: string) {
    if (!this.items.some(item => item.id === id)) throw new Error('Capture no longer exists.');
    return readFile(this.file(id));
  }
  async remove(ids: string[]) {
    const removed = this.items.filter(item => ids.includes(item.id));
    await this.commit(this.items.filter(item => !ids.includes(item.id)));
    await Promise.all(removed.map(item => unlink(this.file(item.id)).catch(() => {})));
  }
  async reorder(ids: string[]) {
    if (ids.length !== this.items.length || new Set(ids).size !== ids.length || ids.some(id => !this.items.some(i => i.id === id))) throw new Error('Queue order has changed. Try again.');
    await this.commit(ids.map(id => this.items.find(item => item.id === id)!));
  }
}
export function isPNG(buffer: Buffer) { return buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); }
