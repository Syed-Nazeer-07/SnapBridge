import { contextBridge, ipcRenderer } from 'electron';
import type { SnapflowAPI } from '../shared/protocol';
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`snapflow:${name}`, ...args);
const api: SnapflowAPI = {
  state: () => invoke('state'), capture: () => invoke('capture'), remove: id => invoke('remove', id),
  reorder: ids => invoke('reorder', ids), clear: () => invoke('clear'), preview: id => invoke('preview', id),
  send: (tabId, prompt) => invoke('send', tabId, prompt), fallback: (tabId, prompt) => invoke('fallback', tabId, prompt),
  settings: settings => invoke('settings', settings), hide: () => invoke('hide'), quit: () => invoke('quit'),
  resize: expanded => invoke('resize', expanded), unpair: () => invoke('unpair'),
  extensionFolder: () => invoke('extensionFolder'), revealExtension: () => invoke('revealExtension'),
  onState: listener => { const handler = (_event: Electron.IpcRendererEvent, state: any) => listener(state); ipcRenderer.on('snapflow:state', handler); return () => ipcRenderer.removeListener('snapflow:state', handler); },
  captureSource: () => invoke('captureSource'), finishCapture: rect => invoke('finishCapture', rect), cancelCapture: () => invoke('cancelCapture')
};
contextBridge.exposeInMainWorld('snapflow', api);
