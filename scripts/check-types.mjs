import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const executable = resolve(root, 'node_modules/typescript/bin/tsc');
const result = spawnSync(process.execPath, [executable, '--project', resolve(root, 'tsconfig.json')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
});
if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
