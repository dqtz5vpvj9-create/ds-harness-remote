/** Standalone source plugin. Remote supplies transport; the native source keeps
 * its original data directory, execution, authorization and durable receipts. */
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { parseSources, parseSourceWorkspaces } from './remote/config.ts';
import { installSources, registerSourceContract } from './remote/service.ts';

export const name = 'dsh-remote-native-sources';
export const inject = ['typert', 'remoteAccess', 'connection'];
export interface Config { configFile: string }
const configuration = z.strictObject({ version: z.literal(1), directory: z.string().min(1).max(8192),
    sources: z.array(z.unknown()), sourceWorkspaces: z.array(z.unknown()).default([]) });
export function parseNativeHostConfig(value: unknown) {
    const parsed = configuration.parse(value);
    if (!isAbsolute(parsed.directory) || parsed.directory.includes('\0')) throw new Error('Native source data directory must be absolute.');
    const sources = parseSources(parsed.sources);
    return { version: 1 as const, directory: parsed.directory, sources,
        sourceWorkspaces: parseSourceWorkspaces(parsed.sourceWorkspaces, sources) };
}
export async function readNativeHostConfig(path: string) {
    if (!isAbsolute(path)) throw new Error('Native source configuration path must be absolute.');
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Native source configuration must be a bounded regular file.');
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) throw new Error('Native source configuration must not be writable by another account.');
    return parseNativeHostConfig(JSON.parse(await readFile(path, 'utf8')));
}
export async function apply(ctx: Context, config: Config): Promise<void> {
    const runtime = await readNativeHostConfig(config.configFile);
    // Registering another service can replace a still-live source owner. Refuse
    // before opening a native process or changing any persisted source state.
    if (ctx.get('hhpi') || ctx.get('sourceWorkspace') || ctx.get('sourceTerminal')) {
        throw new Error('Native source services already have an owner in this Host. Disable the previous source plugin before switching.');
    }
    registerSourceContract(ctx);
    installSources(ctx, runtime.sources, runtime.directory, runtime.sourceWorkspaces);
}
