import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(import.meta.url);
const installer = path.join(path.dirname(require.resolve('electron/package.json')), 'install.js');
const result = spawnSync(process.execPath, [installer, '--no'], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', electron_config_cache: process.env.electron_config_cache || path.join(tmpdir(), 'snapflow-electron-cache') } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
