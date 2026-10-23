import type { AppState } from '../shared/protocol';
const api = window.snapflow;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let state: AppState;
let expanded = false;
let settingsOpen = false;
let dragId: string | null = null;
let lastImages = '';
let lastTabs = '';
const prompt = $<HTMLTextAreaElement>('prompt');
const target = $<HTMLSelectElement>('target');
prompt.value = localStorage.getItem('snapflow-prompt') || '';
prompt.addEventListener('input', () => { localStorage.setItem('snapflow-prompt', prompt.value); updateSend(); });
let selectedTarget: { id: number; url: string } | null = null;
try { const saved = JSON.parse(localStorage.getItem('snapflow-target') || 'null'); if (saved && typeof saved.id === 'number' && typeof saved.url === 'string') selectedTarget = saved; } catch {}
target.addEventListener('change', () => { const tab = state.tabs.find(t => String(t.id) === target.value); selectedTarget = tab ? { id: tab.id, url: tab.url } : null; localStorage.setItem('snapflow-target', JSON.stringify(selectedTarget)); updateSend(); });
function report(e: unknown) { const message = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e); $('notice').textContent = message; $('notice').classList.add('error'); $('settings-status').textContent = message; }
const action = (fn: () => Promise<unknown>) => () => { void fn().catch(report); };
function setExpanded(value: boolean) { expanded = value; $('panel').hidden = !expanded || settingsOpen || !state?.settings.setupComplete; $('expand').setAttribute('aria-expanded', String(expanded)); $('chevron').textContent = expanded ? '▴' : '▾'; void api.resize(expanded || settingsOpen); }
function showSettings(value: boolean) {
  if (!state?.settings.setupComplete) return;
  settingsOpen = value; $('settings').hidden = !value; $('panel').hidden = value || !expanded;
  if (value) { $<HTMLInputElement>('shortcut').value = state.settings.shortcut; $<HTMLInputElement>('always-on-top').checked = state.settings.alwaysOnTop; $<HTMLSelectElement>('capture-mode').value = state.settings.captureMode; }
  void api.resize(value || expanded);
  if (value) void api.extensionFolder().then(folder => { $<HTMLInputElement>('extension-folder').value = folder; });
}
function updateSend() { $<HTMLButtonElement>('send').disabled = !state || !state.settings.setupComplete || state.busy || !state.connected || !target.value || (!state.images.length && !prompt.value.trim()); }
function button(label: string, title: string, click: () => void) { const b = document.createElement('button'); b.textContent = label; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', click); return b; }
function render(next: AppState) {
  if (next.images.length > (state?.images.length || 0)) { settingsOpen = false; $('settings').hidden = true; setExpanded(true); }
  if (!next.settings.setupComplete) { $('onboarding').hidden = false; $('panel').hidden = true; $('settings').hidden = true; void api.resize(true); if (!state) $<HTMLInputElement>('setup-shortcut').value = next.settings.shortcut; }
  else if (!state?.settings.setupComplete) { $('onboarding').hidden = true; setExpanded(true); }
  if (next.error && next.status !== state?.status && !settingsOpen) setExpanded(true);
  state = next;
  $('panel').hidden = !state.settings.setupComplete || !expanded || settingsOpen;
  $('count').textContent = String(state.images.length); $('panel-count').textContent = String(state.images.length);
  $('notice').textContent = state.status; $('notice').classList.toggle('error', state.error);
  $('settings-status').textContent = state.error ? state.status : '';
  $('storage').textContent = `${(state.bytes / 1024 / 1024).toFixed(1)} MB / 128 MB local queue`;
  $('shortcut-hint').textContent = state.settings.shortcut.replace('CommandOrControl', 'Ctrl').replaceAll('+', ' ');
  $('connection-dot').classList.toggle('online', state.connected);
  $('connection-dot').title = state.connected ? 'Browser connected' : 'Open Settings to connect your browser';
  $('pair-status').textContent = state.connected ? 'Connected securely. Your browser session stays in the browser.' : 'Only one paired browser is active at a time. Pairing a new browser replaces the previous connection.';
  $<HTMLInputElement>('pair-code').value = state.pairingCode;
  $<HTMLButtonElement>('clear').disabled = !state.images.length || state.busy;
  $<HTMLButtonElement>('unpair').disabled = state.busy;
  $<HTMLButtonElement>('fallback').disabled = state.busy || !state.images.length;
  prompt.disabled = state.busy; target.disabled = state.busy;
  $('send-label').textContent = state.busy ? 'Preparing…' : 'Prepare draft';
  $('prepared-actions').hidden = !state.prepared;
  $<HTMLButtonElement>('clear-prepared').disabled = state.busy;
  const tabsKey = JSON.stringify([state.connected, state.tabs]);
  if (tabsKey !== lastTabs) {
    const previous = selectedTarget; target.replaceChildren();
    const option = document.createElement('option'); option.value = ''; option.textContent = state.connected ? 'Select conversation' : 'Connect browser'; target.append(option);
    for (const tab of state.tabs) { const o = document.createElement('option'); o.value = String(tab.id); o.textContent = `${tab.provider} · ${tab.title}`; target.append(o); }
    if (previous && state.tabs.some(t => t.id === previous.id && t.url === previous.url)) target.value = String(previous.id);
    else if (state.connected) { selectedTarget = null; localStorage.removeItem('snapflow-target'); }
    lastTabs = tabsKey;
  }
  const imageKey = JSON.stringify([state.images.map(i => i.id), state.busy]);
  if (imageKey !== lastImages) {
    const gallery = $('gallery'); gallery.replaceChildren();
    state.images.forEach((image, index) => {
      const card = document.createElement('article'); card.className = 'card'; card.draggable = !state.busy; card.dataset.id = image.id;
      card.addEventListener('dragstart', event => { dragId = image.id; event.dataTransfer?.setData('text/plain', image.id); card.classList.add('dragging'); });
      card.addEventListener('dragend', () => { dragId = null; card.classList.remove('dragging'); });
      card.addEventListener('dragover', event => { event.preventDefault(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
      card.addEventListener('drop', event => { event.preventDefault(); card.classList.remove('drag-over'); if (!dragId || dragId === image.id || state.busy) return; const ids = state.images.map(i => i.id).filter(id => id !== dragId); ids.splice(index, 0, dragId); void api.reorder(ids).catch(report); });
      const thumb = button('', `Preview capture ${index + 1}`, action(async () => { $<HTMLImageElement>('preview-image').src = await api.preview(image.id); $('preview-title').textContent = `${image.width} × ${image.height} · original PNG`; $<HTMLDialogElement>('preview').showModal(); }));
      thumb.className = 'image-button'; const img = document.createElement('img'); img.src = image.thumbnail; img.alt = `Capture ${index + 1}`; img.draggable = false; thumb.append(img);
      const badge = document.createElement('span'); badge.className = 'card-index'; badge.textContent = String(index + 1).padStart(2, '0'); thumb.append(badge); card.append(thumb);
      const footer = document.createElement('div'); footer.className = 'card-footer'; const size = document.createElement('span'); size.className = 'card-size'; size.textContent = `${image.width} × ${image.height}`; footer.append(size);
      const controls = document.createElement('div'); controls.className = 'card-controls';
      for (const [label, delta] of [['←', -1], ['→', 1]] as const) { const b = button(label, delta === -1 ? 'Move capture earlier' : 'Move capture later', action(async () => { const ids = state.images.map(i => i.id); [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]]; await api.reorder(ids); })); b.disabled = state.busy || index + delta < 0 || index + delta >= state.images.length; controls.append(b); }
      const remove = button('×', 'Remove capture', action(() => api.remove(image.id))); remove.disabled = state.busy; controls.append(remove); footer.append(controls); card.append(footer); gallery.append(card);
    });
    $('empty').hidden = state.images.length > 0; gallery.hidden = !state.images.length; lastImages = imageKey;
  }
  updateSend();
}
async function send() {
  if ($<HTMLButtonElement>('send').disabled) return;
  setExpanded(true);
  await api.prepare(Number(target.value), prompt.value); updateSend();
}
$('capture').addEventListener('click', action(() => api.capture()));
$('empty-capture').addEventListener('click', action(() => api.capture()));
$('expand').addEventListener('click', () => { if (settingsOpen) showSettings(false); setExpanded(!expanded); });
$('send').addEventListener('click', action(send));
$('clear').addEventListener('click', action(async () => { if (confirm('Remove all queued captures from this device?')) await api.clear(); }));
$('fallback').addEventListener('click', action(async () => { const folder = await api.fallback(target.value ? Number(target.value) : null, prompt.value); if (folder) { $('notice').textContent = `Saved to ${folder}. Attach these PNGs in the browser. Your prompt is on the clipboard. Queue retained.`; $('notice').classList.remove('error'); } }));
$('hide').addEventListener('click', action(() => api.hide()));
$('quit').addEventListener('click', action(() => api.quit()));
$('settings-toggle').addEventListener('click', () => showSettings(!settingsOpen));
$('settings-close').addEventListener('click', () => showSettings(false));
$('pair-code').addEventListener('click', event => (event.target as HTMLInputElement).select());
$('reveal-extension').addEventListener('click', action(() => api.revealExtension()));
$('extension-folder').addEventListener('click', event => (event.target as HTMLInputElement).select());
$('unpair').addEventListener('click', action(() => api.unpair()));
$('save-settings').addEventListener('click', action(async () => { await api.settings({ shortcut: $<HTMLInputElement>('shortcut').value, alwaysOnTop: $<HTMLInputElement>('always-on-top').checked, captureMode: $<HTMLSelectElement>('capture-mode').value as 'instant' | 'adjust', setupComplete: true }); $('settings-status').textContent = 'Preferences saved.'; }));
for (const id of ['shortcut', 'setup-shortcut']) $(id).addEventListener('keydown', event => {
  if (event.key === 'Tab') return;
  event.preventDefault(); if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) return;
  const key = event.code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  $<HTMLInputElement>(id).value = [event.ctrlKey ? 'Control' : '', event.metaKey ? 'Super' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+');
});
$('finish-setup').addEventListener('click', action(async () => {
  try { await api.settings({ shortcut: $<HTMLInputElement>('setup-shortcut').value, alwaysOnTop: true, captureMode: (document.querySelector<HTMLInputElement>('input[name="setup-mode"]:checked')!.value as 'instant' | 'adjust'), setupComplete: true }); }
  catch (e: any) { $('setup-status').textContent = e.message; throw e; }
}));
$('clear-prepared').addEventListener('click', action(async () => {
  if (!confirm('Remove the prepared batch from this device? Check your browser draft first.')) return;
  if (await api.clearPrepared(prompt.value)) { prompt.value = ''; localStorage.removeItem('snapflow-prompt'); } updateSend();
}));
$('preview-close').addEventListener('click', () => $<HTMLDialogElement>('preview').close());
$<HTMLDialogElement>('preview').addEventListener('close', () => { $<HTMLImageElement>('preview-image').src = ''; });
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void send().catch(report); } if (event.key === 'Escape') showSettings(false); });
api.onState(render); void api.state().then(render).catch(report);
