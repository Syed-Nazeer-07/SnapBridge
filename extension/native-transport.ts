export class ChunkReceiver {
  private pending?: { id: string; total: number; parts: string[]; bytes: number; started: number };
  accept(message: any): unknown | null {
    if (message?.type !== 'chunk') return message;
    const { transferId, index, total, data } = message;
    if (typeof transferId !== 'string' || transferId.length > 64 || !Number.isInteger(index) || !Number.isInteger(total) || total < 1 || total > 4096 || typeof data !== 'string' || data.length > 65536) throw new Error('Invalid native transfer chunk.');
    if (index === 0) {
      if (this.pending) throw new Error('Overlapping native transfers.');
      this.pending = { id: transferId, total, parts: [], bytes: 0, started: Date.now() };
    }
    const pending = this.pending;
    if (!pending || pending.id !== transferId || pending.total !== total || pending.parts.length !== index || Date.now() - pending.started > 60_000) { this.pending = undefined; throw new Error('Interrupted native transfer.'); }
    pending.bytes += data.length;
    if (pending.bytes > 192 * 1024 * 1024) { this.pending = undefined; throw new Error('Native transfer is too large.'); }
    pending.parts.push(data);
    if (index + 1 !== total) return null;
    this.pending = undefined;
    return JSON.parse(pending.parts.join(''));
  }
}
