import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Registry from '@deepseek-ai/dsh-typert-registry';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { apply, parseNativeHostConfig } from '../src/host.ts';

test('standalone native Host registers the actual authenticated carrier and rejects a second owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'remote-native-host-')), configFile = join(directory, 'host.json');
    const ctx = new Context();
    try {
        await writeFile(configFile, JSON.stringify({ version: 1, directory, sources: [] }), { mode: 0o600 });
        await ctx.plugin(Registry); new RemoteAccess(ctx);
        const connection = new HostConnectionService(ctx, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
        const gateway = new Gateway(ctx, Gateway.Config({}));
        await apply(ctx, { configFile });
        const catalog = await gateway.invoke({ namespace: 'hhpi', method: 'catalog', args: {}, peer: connection.browserPeer });
        assert.deepEqual((catalog as { sessions: unknown[] }).sessions, []);
        await assert.rejects(apply(ctx, { configFile }), /already have an owner/);
        assert.deepEqual(await gateway.invoke({ namespace: 'hhpi', method: 'catalog', args: {}, peer: connection.browserPeer }), catalog,
            'a rejected replacement must leave the first source services usable');
        assert.throws(() => parseNativeHostConfig({ version: 1, directory, sources: [], sourceWorkspaces: [{ sourceId: 'missing', provider: 'local-system' }] }));
        assert.throws(() => parseNativeHostConfig({ version: 1, directory: 'relative', sources: [] }));
    } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }); }
});
