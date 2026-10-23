import { cp, access } from 'node:fs/promises';
import path from 'node:path';
const arch = process.env.SNAPFLOW_ARCH || 'x64';
if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows architecture.');
export default async function(context) {
  const expected = context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : '';
  if (expected !== arch) throw new Error('Native host architecture does not match the desktop build.');
  const source = path.resolve(`dist/native-host/win-${arch}`);
  await access(path.join(source, 'SnapFlow.NativeHost.exe'));
  const destination = path.join(context.appOutDir, 'resources/native-host');
  await cp(source, destination, { recursive: true });
  await cp('dist/native-config.json', path.join(destination, 'native-config.json'));
}
