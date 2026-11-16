/** Prepare an isolated DSH SDK for native-runtime development and CI.
 * Never writes the workspace's pnpm store or another package's SDK. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = fileURLToPath(new URL('./native-sdk/', import.meta.url));
const sha256 = data => createHash('sha256').update(data).digest('hex');

export function verifySdkBytes(data, expected) {
  if (sha256(data) !== expected) throw new Error('The pinned DSH SDK checksum does not match.');
}

export async function prepareNativeSdk(directory, archivePath) {
  const pin = JSON.parse(await readFile(join(metadata, 'pin.json'), 'utf8'));
  const expectedPackages = JSON.parse(await readFile(join(metadata, 'package.json'), 'utf8')).pnpm.overrides;
  directory = resolve(directory);
  if (directory === root || directory.startsWith(join(root, 'node_modules') + '/')) throw new Error('Use a separate SDK directory.');
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('SDK directory must be a regular directory.');
  for (const name of ['package.json', 'pnpm-lock.yaml']) {
    const expected = await readFile(join(metadata, name));
    const current = await readFile(join(directory, name)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (current && !current.equals(expected)) throw new Error(`Refusing to change another SDK environment's ${name}.`);
    if (!current) await writeFile(join(directory, name), expected, { flag: 'wx' });
  }
  const staged = await mkdtemp(join(directory, '.sdk-stage-'));
  try {
    const response = archivePath ? undefined : await fetch(pin.url, { signal: AbortSignal.timeout(60000) });
    if (response && !response.ok) throw new Error(`DSH SDK download failed (${response.status}).`);
    const bytes = archivePath ? await readFile(archivePath) : Buffer.from(await response.arrayBuffer());
    verifySdkBytes(bytes, pin.sha256);
    const archive = join(staged, 'sdk.tgz');
    await writeFile(archive, bytes, { flag: 'wx' });
    const extracted = join(staged, 'release');
    await mkdir(extracted);
    // Extraction occurs only after matching the exact published archive hash.
    execFileSync('tar', ['-xzf', archive, '--no-same-owner', '-C', extracted], { stdio: 'pipe' });
    const release = JSON.parse(await readFile(join(extracted, 'release.json'), 'utf8'));
    if (release.extRelease !== pin.extension || release.packageSetSha256 !== pin.packageSetSha256
        || release.upstreamCommit !== pin.upstreamCommit || release.packages.length !== Object.keys(expectedPackages).length) throw new Error('The DSH SDK release does not match its pin.');
    const vendor = join(directory, 'vendor');
    await mkdir(vendor, { recursive: true });
    for (const item of release.packages) {
      if (!/^deepseek-ai-[a-z0-9.-]+\.tgz$/.test(item.tarball) || expectedPackages[item.name] !== `file:vendor/${item.tarball}`) throw new Error('Unexpected SDK package archive.');
      const data = await readFile(join(extracted, item.tarball));
      verifySdkBytes(data, item.sha256);
      await writeFile(join(vendor, item.tarball), data);
    }
    execFileSync('corepack', ['pnpm', '--dir', directory, 'install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts', '--package-import-method=copy'], { stdio: 'inherit', timeout: 300000 });
    const scopes = [join(directory, 'node_modules/.pnpm/node_modules/@deepseek-ai'), join(directory, 'node_modules/@deepseek-ai')];
    const sdkPackages = new Map();
    for (const scope of scopes) for (const name of await readdir(scope)) sdkPackages.set(name, await realpath(join(scope, name)));
    const names = [...sdkPackages.keys()];
    const declared = JSON.parse(await readFile(join(metadata, 'package.json'), 'utf8')).dependencies;
    for (const name of Object.keys(declared)) if (!sdkPackages.has(name.slice('@deepseek-ai/'.length))) throw new Error(`Missing declared SDK dependency ${name}.`);
    const links = join(root, 'packages/native-runtime/node_modules/@deepseek-ai');
    await mkdir(links, { recursive: true });
    if (!(await lstat(links)).isDirectory() || (await lstat(links)).isSymbolicLink()) throw new Error('The native SDK scope must be a regular directory.');
    // Validate all destinations before replacing any links. Directory contents
    // belonging to an installer or developer must never be overwritten.
    for (const name of names) {
      const target = join(links, name);
      const state = await lstat(target).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (state && !state.isSymbolicLink()) throw new Error(`SDK destination ${name} is not a managed package link.`);
    }
    for (const name of names) {
      const target = sdkPackages.get(name);
      const temporary = join(links, `.${name}.sdk-${process.pid}`);
      await symlink(target, temporary, 'dir');
      await rename(temporary, join(links, name));
    }
    // Keep source and license materials alongside the private development SDK.
    await copyFile(join(extracted, 'release.json'), join(directory, 'release.json'));
    await copyFile(archive, join(directory, 'sdk-source-and-packages.tgz'));
    return { extension: pin.extension, packages: release.packages.length, linkedSdkPackages: names.length };
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/prepare-native-sdk.mjs <isolated-directory> [verified-archive]');
  console.log(JSON.stringify(await prepareNativeSdk(process.argv[2], process.argv[3])));
}
