import { normalizeShortcut } from '../shared/shortcut';
import { describe,it,expect } from 'vitest';
import { ChunkReceiver } from '../extension/native-transport';
import { SettingsSchema } from '../shared/protocol';
describe('native screenshot transport integrity',()=>{
  it('reassembles a split JSON message without losing Unicode or image data',()=>{
    const receiver=new ChunkReceiver(); const text=JSON.stringify({prompt:'Explain 日本語 and 🖼',base64:'a'.repeat(90_000)});
    expect(receiver.accept({type:'chunk',transferId:'transfer',index:0,total:2,data:text.slice(0,65536)})).toBeNull();
    expect(receiver.accept({type:'chunk',transferId:'transfer',index:1,total:2,data:text.slice(65536)})).toEqual(JSON.parse(text));
  });
  it('rejects missing, repeated, reordered, and overlapping chunks',()=>{
    expect(()=>new ChunkReceiver().accept({type:'chunk',transferId:'id',index:1,total:2,data:'{}'})).toThrow('Interrupted');
    const receiver=new ChunkReceiver();receiver.accept({type:'chunk',transferId:'id',index:0,total:2,data:'{'});
    expect(()=>receiver.accept({type:'chunk',transferId:'id',index:0,total:2,data:'{'})).toThrow('Overlapping');
  });
  it('bounds declared transfer sizes before allocating chunks',()=>{
    expect(()=>new ChunkReceiver().accept({type:'chunk',transferId:'id',index:0,total:100000,data:'x'})).toThrow('Invalid');
    expect(()=>new ChunkReceiver().accept({type:'chunk',transferId:'id',index:0,total:1,data:'x'.repeat(65537)})).toThrow('Invalid');
  });
});
it('migrates old preferences into first-launch shortcut and capture setup',()=>{
  expect(SettingsSchema.parse({shortcut:'Control+Shift+S',alwaysOnTop:true})).toMatchObject({captureMode:'instant',setupComplete:false});
});

it('recognizes equivalent default accelerators without treating them as a shortcut conflict',()=>{expect(normalizeShortcut('CommandOrControl+Shift+S')).toBe(normalizeShortcut('Shift+Ctrl+S'));expect(normalizeShortcut('CommandOrControl+S',true)).toBe('Command+S');});
