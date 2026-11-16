/** Structural port for DSH's resource-owned PTYs; execution stays in the DSH SDK. */
import type { Context } from '@deepseek-ai/cordis';
import * as sdk from '@deepseek-ai/dsh-api-terminal-controller';
import type { Config } from '@deepseek-ai/dsh-api-terminal-controller';
import type { TerminalCreateRequest, TerminalEnvironment, TerminalFrame, TerminalInput, TerminalRetentionFrame, TerminalShell, WebTerminalId, WebTerminalInfo } from '@deepseek-ai/dsh-api-terminal-controller/types';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { RemoteUplinkWindow } from '@deepseek-ai/dsh-typert-protocol';

export interface TerminalOwnerController {
    environment(signal: AbortSignal): TerminalEnvironment;
    shells(signal: AbortSignal): Promise<TerminalShell[]>;
    list(): WebTerminalInfo[];
    create(request: TerminalCreateRequest, signal: AbortSignal): Promise<WebTerminalInfo>;
    retain(id: WebTerminalId, signal: AbortSignal): AsyncIterable<TerminalRetentionFrame>;
    attach(id: WebTerminalId, input: AsyncIterable<TerminalInput>, signal: AbortSignal, inputWindow?: RemoteUplinkWindow): AsyncIterable<TerminalFrame>;
    rename(id: WebTerminalId, title: string): void;
    close(id: WebTerminalId): Promise<void>;
    dispose(): Promise<void>;
}
type TerminalOwnerFactory = (scope: Context, owner: {
    readonly id: SessionId;
    readonly subprocess: SubprocessRuntime;
    readonly cwd: { get(): string; ensure(signal: AbortSignal): Promise<string> };
}, config: Config) => TerminalOwnerController;

/** Check before registering any source or allocating a native process. */
export function requireTerminalOwnerFactory(module: object = sdk): TerminalOwnerFactory {
    const factory = (module as { createTerminalOwner?: unknown }).createTerminalOwner;
    if (typeof factory !== 'function') {
        throw new Error('Native source workspaces require the DSH resource-owned terminal SDK (createTerminalOwner). Install the pinned DSH extension release before enabling this source.');
    }
    return factory as TerminalOwnerFactory;
}

export const createTerminalOwner: TerminalOwnerFactory = (...args) => requireTerminalOwnerFactory()(...args);
