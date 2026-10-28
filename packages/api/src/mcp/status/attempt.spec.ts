import { EventEmitter } from 'node:events';
import type { MCPConnectionStateRecord, MCPConnectionStateScope } from './types';
import type { ObservedMCPConnection } from './attempt';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '../capabilities';
import { createMCPCatalogStore } from '../catalog/store';
import { runMCPConnectionAttempt } from './attempt';

function fixture() {
  const values = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: unknown) => {
      values.set(key, value);
      return true;
    },
    delete: async (key: string) => values.delete(key),
  };
  const store = createMCPCatalogStore({ getCache: () => cache, cacheConfig: {} });
  const params = {
    userId: 'user',
    serverName: 'server',
    serverConfig: {
      type: 'streamable-http' as const,
      url: 'https://mcp.example/mcp',
      startup: false,
      requiresOAuth: false,
    },
    capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
    policy: { attemptTimeoutMs: 100, leaseDurationMs: 3000, failureRetentionMs: 10000 },
  };
  const connection = Object.assign(new EventEmitter(), { isConnected: jest.fn(async () => true) });
  const observations: MCPConnectionStateRecord[] = [];
  let observedScope: MCPConnectionStateScope | undefined;
  const deps = {
    ...store,
    getGeneration: () => store.getMCPToolsCacheGeneration(params),
    setMCPConnectionState: async (
      scope: MCPConnectionStateScope,
      value: MCPConnectionStateRecord,
      ttl: number,
      claim?: boolean | 'ifAbsent',
    ) => {
      observedScope = scope;
      const accepted = await store.setMCPConnectionState(scope, value, ttl, claim);
      if (accepted) observations.push(value);
      return accepted;
    },
    connect: async (capture: (value: ObservedMCPConnection) => void) => {
      capture(connection);
      return { success: true };
    },
  };
  return { store, params, connection, observations, deps, scope: () => observedScope! };
}

describe('verified MCP connection attempts', () => {
  it('records Connecting before work and Connected only after actual verification', async () => {
    const f = fixture();
    await expect(runMCPConnectionAttempt(f.params, f.deps)).resolves.toEqual({ success: true });
    expect(f.observations.map((r) => r.state)).toEqual(['connecting', 'connected']);
    expect(f.connection.isConnected).toHaveBeenCalledWith(expect.any(AbortSignal), true);
    f.connection.emit('disposed');
  });
  it('records a failed verification rather than reporting a truthy connection as success', async () => {
    const f = fixture();
    f.connection.isConnected.mockResolvedValue(false);
    await expect(runMCPConnectionAttempt(f.params, f.deps)).rejects.toThrow('verified');
    expect(f.observations[f.observations.length - 1]?.state).toBe('error');
    f.connection.emit('disposed');
  });
  it('records failure while preserving the original authentication error', async () => {
    const f = fixture();
    const error = new Error('synthetic authentication rejection');
    await expect(
      runMCPConnectionAttempt(f.params, {
        ...f.deps,
        connect: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(f.observations[f.observations.length - 1]?.state).toBe('error');
  });
  it('bounds a connect implementation that ignores cancellation', async () => {
    const f = fixture();
    const result = await runMCPConnectionAttempt(
      { ...f.params, policy: { ...f.params.policy, attemptTimeoutMs: 10 } },
      { ...f.deps, connect: () => new Promise(() => {}) },
    );
    expect(result).toMatchObject({ success: false, message: expect.stringContaining('timed out') });
    expect(f.observations[f.observations.length - 1]?.state).toBe('error');
  });
  it('prevents an older connection from resurrecting success after authorization invalidation', async () => {
    const f = fixture();
    await runMCPConnectionAttempt(f.params, f.deps);
    await f.store.invalidateCachedTools(f.params);
    await expect(
      f.store.setMCPConnectionState(
        f.scope(),
        { ...f.observations[f.observations.length - 1]!, state: 'connected' },
        10000,
      ),
    ).resolves.toBe(false);
    f.connection.emit('disposed');
  });
  it('prevents a replaced attempt from publishing a late success', async () => {
    const f = fixture();
    await runMCPConnectionAttempt(f.params, f.deps);
    const old = f.observations[f.observations.length - 1]!;
    await f.store.setMCPConnectionState(
      f.scope(),
      { ...old, attemptId: 'new', state: 'connecting' },
      10000,
      true,
    );
    await expect(f.store.setMCPConnectionState(f.scope(), old, 10000)).resolves.toBe(false);
    f.connection.emit('disposed');
  });
  it('publishes transport loss and disposal without allowing an older health probe to win', async () => {
    const f = fixture();
    let complete!: (value: boolean) => void;
    let observed!: () => void;
    const ended = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const original = f.deps.setMCPConnectionState;
    f.deps.setMCPConnectionState = async (...args) => {
      const accepted = await original(...args);
      if (args[1].state === 'disconnected') observed();
      return accepted;
    };
    await runMCPConnectionAttempt(f.params, f.deps);
    f.connection.isConnected.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    f.connection.emit('connectionChange', 'connected');
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.connection.emit('disposed');
    complete(true);
    await ended;
    expect(f.observations.map((value) => value.state)).toEqual([
      'connecting',
      'connected',
      'disconnected',
    ]);
    expect(f.connection.listenerCount('connectionChange')).toBe(0);
    expect(f.connection.listenerCount('disposed')).toBe(0);
  });
  it('bounds verification even when the transport ignores its abort signal', async () => {
    const f = fixture();
    f.connection.isConnected.mockImplementation(() => new Promise(() => {}));
    const result = await runMCPConnectionAttempt(
      { ...f.params, policy: { ...f.params.policy, attemptTimeoutMs: 10 } },
      f.deps,
    );
    expect(result).toMatchObject({ success: false });
    expect(f.connection.listenerCount('connectionChange')).toBe(0);
    expect(f.observations[f.observations.length - 1].state).toBe('error');
  });

  it('accepts the generation bound to credentials rotated by this exact connection', async () => {
    const f = fixture();
    let rotated: string | undefined;
    const connect = async (capture: (value: ObservedMCPConnection) => void) => {
      rotated = await f.store.invalidateCachedTools(f.params);
      capture(f.connection);
      return { success: true };
    };
    await expect(
      runMCPConnectionAttempt(f.params, {
        ...f.deps,
        connect,
        getConnectionGeneration: () => rotated,
      }),
    ).resolves.toEqual({ success: true });
    expect(f.scope().publicationGeneration).toBe(rotated);
    f.connection.emit('disposed');
  });
  it('does not adopt rotated credentials over another active attempt', async () => {
    const f = fixture();
    let rotated: string | undefined;
    const connect = async (capture: (value: ObservedMCPConnection) => void) => {
      rotated = await f.store.invalidateCachedTools(f.params);
      await f.store.setMCPConnectionState(
        { ...f.scope(), publicationGeneration: rotated! },
        { attemptId: 'peer', state: 'connecting', deadline: Date.now() + 1000 },
        10000,
        true,
      );
      capture(f.connection);
      return { success: true };
    };
    await expect(
      runMCPConnectionAttempt(f.params, {
        ...f.deps,
        connect,
        getConnectionGeneration: () => rotated,
      }),
    ).rejects.toThrow('superseded');
    expect((await f.store.getMCPConnectionState(f.scope()))?.attemptId).toBe('peer');
    f.connection.emit('disposed');
  });

  it('keeps user and config scopes isolated', async () => {
    const f = fixture();
    await runMCPConnectionAttempt(f.params, f.deps);
    await expect(
      f.store.getMCPConnectionState({ ...f.scope(), userId: 'other' }),
    ).resolves.toBeNull();
    await expect(
      f.store.getMCPConnectionState({ ...f.scope(), configGeneration: 'changed' }),
    ).resolves.toBeNull();
    f.connection.emit('disposed');
  });
});
