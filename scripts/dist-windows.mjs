import { spawn } from 'node:child_process';
import path from 'node:path';
const arch=process.argv[2]||'x64';
if(!['x64','arm64'].includes(arch))throw new Error('Choose x64 or arm64.');
const env={...process.env,SNAPFLOW_ARCH:arch};
async function run(args,annotate=false){
  const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});let tail='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{process.stdout.write(chunk);tail=(tail+chunk.toString()).slice(-32000);});
  const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  if(code!==0){if(annotate&&process.env.GITHUB_ACTIONS)console.log('::error title=Windows packaging failed::'+(tail.split('\n').filter(line=>/error|warning|exception|invalid|cannot|not found|at .*\.(?:js|mjs)/i.test(line)).join('\n').slice(-8000)||tail.slice(-8000)).replaceAll('%','%25').replaceAll('\r','%0D').replaceAll('\n','%0A'));process.exit(code||1);}
}
if(!process.argv.includes('--package-only')){await run(['scripts/build.mjs']);await run(['scripts/build-native.mjs','--windows']);}
await run([path.resolve('node_modules/electron-builder/cli.js'),'--win','nsis','--'+arch],true);
