import type { CaptureSource } from '../shared/protocol';
const selection = document.getElementById('selection')!;
const actions = document.getElementById('actions')!;
let source: CaptureSource;
let rect = { x: 0, y: 0, width: 0, height: 0 };
let start = { x: 0, y: 0, rect: { ...rect } };
let mode: 'new' | 'move' | 'resize' | null = null;
let submitting = false;
function render() {
  Object.assign(selection.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  selection.hidden = false;
  actions.hidden = source?.captureMode === 'instant' || rect.width < 2 || rect.height < 2 || !!mode;
  document.getElementById('dimensions')!.textContent = `${Math.round(rect.width * (source?.width || innerWidth) / innerWidth)} × ${Math.round(rect.height * (source?.height || innerHeight) / innerHeight)} px`;
}
document.addEventListener('pointerdown', event => {
  if ((event.target as HTMLElement).closest('#actions') || submitting) return;
  start = { x: event.clientX, y: event.clientY, rect: { ...rect } };
  mode = (event.target as HTMLElement).id === 'handle' ? 'resize' : event.target === selection ? 'move' : 'new';
  if (mode === 'new') rect = { x: event.clientX, y: event.clientY, width: 0, height: 0 };
  render();
});
document.addEventListener('pointermove', event => {
  if (!mode) return;
  const x = Math.max(0, Math.min(innerWidth, event.clientX)), y = Math.max(0, Math.min(innerHeight, event.clientY));
  if (mode === 'new') rect = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
  if (mode === 'move') { rect.x = Math.max(0, Math.min(innerWidth - rect.width, start.rect.x + x - start.x)); rect.y = Math.max(0, Math.min(innerHeight - rect.height, start.rect.y + y - start.y)); }
  if (mode === 'resize') { rect.width = Math.max(2, Math.min(innerWidth - rect.x, start.rect.width + x - start.x)); rect.height = Math.max(2, Math.min(innerHeight - rect.y, start.rect.height + y - start.y)); }
  render();
});
document.addEventListener('pointerup', () => { if (!mode) return; mode = null; render(); if (source?.captureMode === 'instant' && rect.width >= 2 && rect.height >= 2) void finish(); });
async function finish() {
  if (rect.width < 2 || rect.height < 2 || submitting) return;
  submitting = true; (document.getElementById('confirm') as HTMLButtonElement).disabled = true;
  try { await window.snapflow.finishCapture(rect); } catch (e: any) { document.getElementById('hint')!.textContent = e.message; submitting = false; (document.getElementById('confirm') as HTMLButtonElement).disabled = false; }
}
document.getElementById('confirm')!.addEventListener('click', () => void finish());
document.getElementById('cancel')!.addEventListener('click', () => void window.snapflow.cancelCapture());
document.addEventListener('keydown', event => { if (event.key === 'Escape') void window.snapflow.cancelCapture(); if (event.key === 'Enter') void finish(); });
void window.snapflow.captureSource().then(value => { source = value; document.getElementById('hint')!.textContent = value.captureMode === 'instant' ? 'Drag to select · Release to capture · Esc to cancel' : 'Drag to select · Move or resize · Enter to capture · Esc to cancel'; (document.getElementById('screen') as HTMLImageElement).src = value.dataUrl; }).catch(e => { document.getElementById('hint')!.textContent = `Capture failed: ${e.message}. Press Escape to cancel.`; });
