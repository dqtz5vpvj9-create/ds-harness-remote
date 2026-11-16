import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
for (const file of await readdir('src/remote')) {
  if (!file.endsWith('.mjs') && !file.endsWith('.d.mts')) continue;
  await mkdir('dist/remote', { recursive: true });
  await copyFile(join('src/remote', file), join('dist/remote', file));
}
