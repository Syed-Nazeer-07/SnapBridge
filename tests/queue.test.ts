import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CaptureQueue } from '../desktop/queue';
import { MAX_IMAGE_BYTES } from '../shared/protocol';
let directory: string;
let queue: CaptureQueue;
const png = await readFile(new URL('../assets/icon.png', import.meta.url));
const details = { width: 32, height: 32, thumbnail: `data:image/png;base64,${png.toString('base64')}` };
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'snapflow-queue-')); queue = new CaptureQueue(directory); await queue.load(); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
describe('persistent original-quality capture queue', () => {
  it('retains exact PNGs and order across restarts', async () => {
    const a = await queue.add(png, details), b = await queue.add(png, details);
    await queue.reorder([b.id, a.id]);
    const restored = new CaptureQueue(directory); await restored.load();
    expect(restored.images.map(i => i.id)).toEqual([b.id, a.id]);
    expect(await restored.read(a.id)).toEqual(png);
    expect(restored.bytes).toBe(png.length * 2);
  });
  it('removes only confirmed batch IDs, preserving captures added later', async () => {
    const sent = await queue.add(png, details), later = await queue.add(png, details);
    await queue.remove([sent.id]);
    expect(queue.images.map(i => i.id)).toEqual([later.id]);
    expect(await readdir(directory)).not.toContain(`${sent.id}.png`);
  });
  it('refuses malformed reorder without changing the persisted queue', async () => {
    const a = await queue.add(png, details), b = await queue.add(png, details);
    await expect(queue.reorder([a.id, a.id])).rejects.toThrow('Queue order');
    await expect(queue.reorder([b.id])).rejects.toThrow('Queue order');
    expect(queue.images.map(i => i.id)).toEqual([a.id, b.id]);
  });
  it('rejects invalid, oversized, and path traversal inputs', async () => {
    await expect(queue.add(Buffer.from('not png'), details)).rejects.toThrow('PNG');
    const large = Buffer.alloc(MAX_IMAGE_BYTES + 1); png.copy(large);
    await expect(queue.add(large, details)).rejects.toThrow('16 MB');
    await expect(queue.read('../../private')).rejects.toThrow();
    expect(queue.images).toHaveLength(0);
  });
  it('does not silently discard unreadable metadata or orphaned originals', async () => {
    const a = await queue.add(png, details);
    const orphan = '12345678-1234-1234-1234-123456789abc.png';
    await writeFile(path.join(directory, orphan), png);
    const restored = new CaptureQueue(directory); await restored.load();
    expect(await readFile(path.join(directory, orphan))).toEqual(png);
    await writeFile(path.join(directory, 'queue.json'), '{broken');
    await expect(new CaptureQueue(directory).load()).rejects.toThrow('left on disk');
    expect(await readFile(path.join(directory, `${a.id}.png`))).toEqual(png);
  });
  it('returns snapshots that cannot mutate queue metadata', async () => {
    const a = await queue.add(png, details); const list = queue.images; list[0].name = 'modified'; list.length = 0;
    expect(queue.images[0].name).toBe(a.name);
  });
});
