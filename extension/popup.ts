const statusElement = document.getElementById('status')!;
async function refresh() { try { const result = await chrome.runtime.sendMessage({ type: 'status' }); statusElement.textContent = result.status; (document.getElementById('disconnect') as HTMLButtonElement).disabled = !result.connected; } catch { statusElement.textContent = 'Extension is restarting. Open this popup again.'; } }
document.getElementById('pair')!.addEventListener('submit', event => { event.preventDefault(); const code = (document.getElementById('code') as HTMLInputElement).value.trim(); if (!/^[a-f0-9]{48}$/.test(code)) { statusElement.textContent = 'Paste the complete 48-character code from SnapFlow Settings.'; return; } void chrome.runtime.sendMessage({ type: 'pair', code }).then(() => { (document.getElementById('code') as HTMLInputElement).value = ''; void refresh(); }); });
document.getElementById('disconnect')!.addEventListener('click', () => { void chrome.runtime.sendMessage({ type: 'disconnect' }).then(refresh); });
void refresh(); setInterval(() => void refresh(), 1000);

document.getElementById('connect')!.addEventListener('click', () => { void chrome.runtime.sendMessage({ type: 'connect' }).then(refresh); });
