const { app, BrowserWindow, protocol } = require('electron');
const { readFileSync } = require('node:fs');
app.whenReady().then(async () => {
  protocol.handle('https', request => new Response(readFileSync(process.env.SNAPFLOW_FIXTURES + (new URL(request.url).hostname === 'chatgpt.com' ? '/chatgpt.html' : '/gemini.html')), { headers: { 'content-type': 'text/html' } }));
  global.fixtureWindow = new BrowserWindow({ width: 900, height: 750, show: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await global.fixtureWindow.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
