import { EventEmitter } from 'node:events';
import type { MCPConnectionStateRecord, MCPConnectionStateScope } from './types';
import type { ObservedMCPConnection } from './types';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '../capabilities';
import { createMCPCatalogStore } from '../catalog/store';
import { runMCPConnectionAttempt } from './attempt';

const connections: EventEmitter[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.emit('disposed');
  await new Promise<void>((resolve) => setImmediate(resolve));
});

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
    policy: { attemptTimeoutMs: 100, evidenceFreshnessMs: 3000, resultRetentionMs: 10000 },
  };
  const connection = Object.assign(new EventEmitter(), {
    isConnected: jest.fn(async () => true),
    dispose: jest.fn(async () => {}),
  });
  connections.push(connection);
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

describe('bounded explicit Connect operations', () => {
  it('publishes pending before work and finishes with a verified, immutable result', async () => {
    const f = fixture();
    const result = await runMCPConnectionAttempt(f.params, f.deps);
    expect(result).toMatchObject({
      success: true,
      connectionAttempt: { state: 'connected', remainingMs: expect.any(Number) },
    });
    expect(f.observations.map((r) => r.state)).toEqual(['connecting', 'connected']);
    expect(f.connection.isConnected).toHaveBeenCalledWith(expect.any(AbortSignal), true);
    const terminal = await f.store.getMCPConnectionState(f.scope());
    expect(
      await f.store.setMCPConnectionState(f.scope(), { ...terminal!, state: 'error' }, 10000),
    ).toBe(false);
    expect((await f.store.getMCPConnectionState(f.scope()))?.state).toBe('connected');
  });

  it('leaves no listeners or idle work on a shared physical connection after 1,000 users', async () => {
    const f = fixture();
    for (let i = 0; i < 1000; i++) {
      const params = { ...f.params, userId: `user-${i}` };
      await runMCPConnectionAttempt(params, {
        ...f.deps,
        getGeneration: () => f.store.getMCPToolsCacheGeneration(params),
      });
    }
    expect(f.connection.listenerCount('connectionChange')).toBe(0);
    expect(f.connection.listenerCount('disposed')).toBe(0);
    expect(f.connection.isConnected).toHaveBeenCalledTimes(1000);
    f.connection.emit('connectionChange', 'connected');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.connection.isConnected).toHaveBeenCalledTimes(1000);
    expect(f.observations).toHaveLength(2000);
  });

  it('preserves the original authentication failure and records a terminal failure', async () => {
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
    expect((await f.store.getMCPConnectionState(f.scope()))?.state).toBe('error');
    expect(
      await f.store.setMCPConnectionState(
        f.scope(),
        { ...f.observations[0], state: 'connected', verifiedUntil: Date.now() + 1000 },
        10000,
      ),
    ).toBe(false);
  });

  it('does not mistake a connection object for verified success', async () => {
    const f = fixture();
    f.connection.isConnected.mockResolvedValue(false);
    await expect(runMCPConnectionAttempt(f.params, f.deps)).rejects.toThrow('verified');
    expect((await f.store.getMCPConnectionState(f.scope()))?.state).toBe('error');
  });

  it('rejects a final success write delayed past the deadline at the actual store boundary', async () => {
    const f = fixture();
    const original = f.deps.setMCPConnectionState;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = await runMCPConnectionAttempt(
      { ...f.params, policy: { ...f.params.policy, attemptTimeoutMs: 10 } },
      {
        ...f.deps,
        setMCPConnectionState: async (...args) => {
          if (args[1].state === 'connected') await held;
          return original(...args);
        },
      },
    );
    expect(result).toMatchObject({ success: false });
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await f.store.getMCPConnectionState(f.scope()))?.state).toBe('error');
  });

  it('bounds admission and does not start transport work after a delayed claim', async () => {
    const f = fixture();
    const connect = jest.fn(f.deps.connect);
    const original = f.deps.setMCPConnectionState;
    await expect(
      runMCPConnectionAttempt(
        { ...f.params, policy: { ...f.params.policy, attemptTimeoutMs: 5 } },
        {
          ...f.deps,
          connect,
          setMCPConnectionState: async (...args) => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return original(...args);
          },
        },
      ),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(['connect', 'verification'] as const)(
    'bounds a stalled %s and fences late completion',
    async (stage) => {
      const f = fixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (stage === 'verification')
        f.connection.isConnected.mockImplementation(async () => {
          await held;
          return true;
        });
      const connect =
        stage === 'connect'
          ? async (capture: (connection: ObservedMCPConnection) => void) => {
              await held;
              capture(f.connection);
              return { success: true };
            }
          : f.deps.connect;
      expect(
        await runMCPConnectionAttempt(
          { ...f.params, policy: { ...f.params.policy, attemptTimeoutMs: 5 } },
          { ...f.deps, connect },
        ),
      ).toMatchObject({ success: false });
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect((await f.store.getMCPConnectionState(f.scope()))?.state).toBe('error');
      expect(f.connection.listenerCount('connectionChange')).toBe(0);
    },
  );

  it('cannot publish under revoked authorization or another operation identity', async () => {
    const f = fixture();
    await runMCPConnectionAttempt(f.params, f.deps);
    const old = f.observations[0];
    await f.store.setMCPConnectionState(f.scope(), { ...old, attemptId: 'peer' }, 10000, true);
    expect(
      await f.store.setMCPConnectionState(f.scope(), { ...old, state: 'connected' }, 10000),
    ).toBe(false);
    await f.store.invalidateCachedTools(f.params);
    expect(
      await f.store.setMCPConnectionState(
        f.scope(),
        { ...old, attemptId: 'peer', state: 'connected' },
        10000,
      ),
    ).toBe(false);
  });

  it('keeps successful history unchanged by later transport disposal', async () => {
    const f = fixture();
    await runMCPConnectionAttempt(f.params, f.deps);
    f.connection.emit('disposed');
    f.connection.emit('connectionChange', 'error');
    expect((await f.store.getMCPConnectionState(f.scope()))?.state).toBe('connected');
  });

  it('fails admission on a status-store outage before starting the connection', async () => {
    const f = fixture();
    const connect = jest.fn(f.deps.connect);
    await expect(
      runMCPConnectionAttempt(f.params, {
        ...f.deps,
        connect,
        setMCPConnectionState: async () => {
          throw new Error('store unavailable');
        },
      }),
    ).resolves.toMatchObject({ success: false, failureReason: 'status_unavailable' });
    expect(connect).not.toHaveBeenCalled();
  });
  it('reports unconfirmed publication without disposing a verified healthy transport', async () => {
    const f = fixture();
    const original = f.deps.setMCPConnectionState;
    const result = await runMCPConnectionAttempt(f.params, {
      ...f.deps,
      setMCPConnectionState: async (...args) => {
        if (args[1].state === 'connected') throw new Error('store write unavailable');
        return original(...args);
      },
    });
    expect(result).toMatchObject({
      success: false,
      statusUnavailable: true,
      failureReason: 'status_unavailable',
    });
    expect(f.connection.isConnected).toHaveBeenCalledTimes(1);
    expect(f.connection.dispose).not.toHaveBeenCalled();
    expect((await f.store.getMCPConnectionState(f.scope()))?.statusUnavailable).toBe(true);
    expect(f.connection.listenerCount('connectionChange')).toBe(0);
  });
  it('returns the caller operation and actual authorization generation for a first connection', async () => {
    const f = fixture();
    const attemptId = '189f2080-cdb7-4182-b9ac-ff53a724fe0a';
    const result = await runMCPConnectionAttempt({ ...f.params, attemptId }, f.deps);
    expect(result).toMatchObject({
      connectionAttempt: { attemptId, authorizationGeneration: f.scope().publicationGeneration },
    });
    const terminal = await f.store.getMCPConnectionState(f.scope());
    expect(
      await f.store.setMCPConnectionState(
        f.scope(),
        { ...terminal!, state: 'connecting' },
        10000,
        true,
      ),
    ).toBe(false);
  });
});
