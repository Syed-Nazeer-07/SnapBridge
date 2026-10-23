import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const config=JSON.parse(await readFile('dist/native-config.json','utf8'));
const child=spawn(process.env.SNAPFLOW_INSTALLED_HOST,[config.origins[0]+'/'],{stdio:['pipe','pipe','pipe']});
let buffer=Buffer.alloc(0);const messages=[];
child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE(0)){const n=buffer.readUInt32LE(0);messages.push(JSON.parse(buffer.subarray(4,4+n)));buffer=buffer.subarray(4+n);}});
async function receive(type){for(let n=0;n<400;n++){const i=messages.findIndex(m=>m.type===type);if(i>=0)return messages.splice(i,1)[0];await new Promise(r=>setTimeout(r,50));}throw new Error('Installed native host did not respond: '+JSON.stringify(messages));}
try{await receive('ready');const body=Buffer.from('{"type":"ping"}');const header=Buffer.alloc(4);header.writeUInt32LE(body.length);child.stdin.write(Buffer.concat([header,body]));await receive('pong');console.log('PASS installed desktop + native host authentication and framed round trip.');}finally{child.stdin.end();child.kill();}
