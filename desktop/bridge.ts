import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { ClientMessage, PORT, type TargetTab, type SendJob } from '../shared/protocol';
export const extensionOrigin = (origin: string) => /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
export const secretEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export interface Binding { token: string; origin: string }
export class BrowserBridge extends EventEmitter {
  code = randomBytes(24).toString('hex');
  tabs: TargetTab[] = [];
  private socket?: WebSocket;
  private pending?: { id: string; resolve: (evidence: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private server = createServer((_req, res) => { res.writeHead(403); res.end(); });
  private wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  private attempts: number[] = [];
  constructor(private binding: Binding | null, private save: (binding: Binding | null) => Promise<void>, private nativeBinding?: { token: string; origins: string[] }) {
    super();
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/bridge' || !extensionOrigin(req.headers.origin || '') || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') || !['127.0.0.1', `127.0.0.1:${this.port}`].includes(req.headers.host || '')) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws, req.headers.origin!));
    });
  }
  port = PORT;
  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
  async listen(port = PORT) {
    this.port = port;
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); this.port = (this.server.address() as any).port; resolve(); }); });
  }
  private accept(ws: WebSocket, origin: string) {
    let authenticated = false;
    let handling = false;
    const timeout = setTimeout(() => ws.close(1008, 'Pairing required'), 5000);
    ws.on('error', () => {});
    ws.on('message', async data => {
      try {
        if (handling) { ws.close(1008); return; }
        const msg = ClientMessage.parse(JSON.parse(data.toString()));
        if (!authenticated) {
          handling = true;
          if (msg.type === 'pair') {
            this.attempts = this.attempts.filter(t => Date.now() - t < 60_000);
            if (this.attempts.length >= 8) throw new Error('Too many pairing attempts. Wait one minute.');
            this.attempts.push(Date.now());
            if (!secretEqual(msg.code, this.code)) throw new Error('Invalid pairing code.');
            const binding = { token: randomBytes(32).toString('hex'), origin };
            await this.save(binding); this.binding = binding;
            this.code = randomBytes(24).toString('hex');
            ws.send(JSON.stringify({ type: 'paired', token: binding.token }));
          } else if (msg.type === 'native-auth') {
            if (!this.nativeBinding || !this.nativeBinding.origins.includes(origin) || !secretEqual(msg.token, this.nativeBinding.token)) throw new Error('Native connection is not authorized.');
          } else if (msg.type !== 'auth' || !this.binding || this.binding.origin !== origin || !secretEqual(msg.token, this.binding.token)) throw new Error('Pair SnapFlow again from Settings.');
          if (this.socket && this.socket !== ws) { this.fail('Browser connection was replaced. Queue retained. Check the conversation before retrying.'); this.socket.close(1000, 'Reconnected'); }
          this.socket = ws; authenticated = true; handling = false; clearTimeout(timeout);
          ws.send(JSON.stringify({ type: 'ready' })); this.emit('change'); return;
        }
        if (ws !== this.socket) { ws.close(1008); return; }
        if (msg.type === 'tabs') { this.tabs = msg.tabs; this.emit('change'); }
        else if (msg.type === 'progress' && this.pending?.id === msg.jobId) this.emit('progress', msg.message);
        else if (msg.type === 'result' && this.pending?.id === msg.jobId) {
          const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer);
          if (msg.ok && msg.outcome === 'prepared' && msg.evidence) pending.resolve(msg.evidence);
          else pending.reject(new Error(msg.error || 'Draft preparation could not be confirmed. Check the conversation before retrying.'));
        } else if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch (e: any) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', error: e.message?.slice(0, 300) || 'Invalid bridge message.' })); ws.close(1008); }
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (this.socket === ws) {
        this.socket = undefined; this.tabs = [];
        this.fail('Browser disconnected. Queue retained. Check the conversation before retrying.'); this.emit('change');
      }
    });
  }
  async unpair() { await this.save(null); this.binding = null; this.code = randomBytes(24).toString('hex'); this.socket?.close(1000, 'Unpaired'); this.tabs = []; this.emit('change'); }
  private fail(message: string) { if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(message)); this.pending = undefined; } }
  prepare(job: Omit<SendJob, 'jobId' | 'type'>) {
    if (!this.connected || !this.socket) return Promise.reject(new Error('Connect the browser extension first.'));
    if (this.pending) return Promise.reject(new Error('A transfer is already running.'));
    const socket = this.socket;
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID();
      this.pending = { id, resolve, reject, timer: setTimeout(() => this.fail('Draft preparation timed out. Queue retained. Check the conversation before retrying.'), 180_000) };
      socket.send(JSON.stringify({ ...job, type: 'prepare', jobId: id }), error => { if (error) this.fail('Browser transfer failed. Queue retained.'); });
    });
  }
  focus(tab: TargetTab) { if (!this.connected) throw new Error('The extension is disconnected.'); this.socket!.send(JSON.stringify({ type: 'focus', tab })); }
  async close() {
    this.fail('Bridge stopped.');
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise<void>(resolve => this.wss.close(() => resolve()));
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
