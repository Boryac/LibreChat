import { EventEmitter } from 'node:events';
import { STANDARD_MCP_CAPABILITY_PROFILE } from '../capabilities';
import { createMCPConnectionStatusObserver } from './observer';
import { getMCPToolCatalogGeneration } from '../toolsChanged';
import { createMCPCatalogStore } from '../catalog/store';
import { runMCPConnectionAttempt } from './attempt';

async function fixture() {
  const values = new Map<string, unknown>();
  const store = createMCPCatalogStore({
    cacheConfig: {},
    getCache: () => ({
      get: async (key: string) => values.get(key),
      set: async (key: string, value: unknown) => {
        values.set(key, value);
        return true;
      },
      delete: async (key: string) => values.delete(key),
    }),
  });
  const params = {
    userId: 'user',
    serverName: 'server',
    capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
    serverConfig: { type: 'streamable-http' as const, url: 'https://mcp.example/mcp' },
  };
  const scope = {
    userId: params.userId,
    serverName: params.serverName,
    configGeneration: getMCPToolCatalogGeneration(params.serverConfig, params.capabilityProfile),
    publicationGeneration: (await store.getMCPToolsCacheGeneration(params))!,
  };
  const connection = () =>
    Object.assign(new EventEmitter(), { isConnected: jest.fn(async () => true) });
  const notify = createMCPConnectionStatusObserver(store);
  const read = () => store.getMCPConnectionState(scope);
  const ready = { ...params, publicationGeneration: scope.publicationGeneration, created: true };
  return { params, store, scope, connection, notify, read, ready };
}

describe('managed connection observation', () => {
  it.each(['connected', 'connecting'] as const)(
    'lets a verified replacement win over old %s state and disposal',
    async (state) => {
      const f = await fixture();
      const old = f.connection();
      const next = f.connection();
      let releaseDisposal!: () => void;
      const disposal = new Promise<void>((resolve) => {
        releaseDisposal = resolve;
      });
      const original = f.store.setMCPConnectionState;
      f.store.setMCPConnectionState = async (...args) => {
        if (args[1].state === 'disconnected' && args[1].attemptId === oldAttempt) await disposal;
        return original(...args);
      };
      await runMCPConnectionAttempt(f.params, {
        ...f.store,
        getGeneration: async () => f.scope.publicationGeneration,
        connect: async (capture) => {
          capture(old);
          return { success: true };
        },
      });
      const oldAttempt = (await f.read())!.attemptId;
      if (state === 'connecting') {
        old.emit('connectionChange', 'connecting');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await f.read()).toMatchObject({ state: 'connecting', explicitAttempt: false });
      }
      old.emit('disposed');
      await f.notify({ ...f.ready, connection: next });
      releaseDisposal();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await f.read()).toMatchObject({ state: 'connected' });
      expect((await f.read())!.attemptId).not.toBe(oldAttempt);
      expect(
        await f.store.setMCPConnectionState(
          f.scope,
          { attemptId: oldAttempt, state: 'disconnected', deadline: Date.now() },
          10000,
        ),
      ).toBe(false);
      next.emit('disposed');
    },
  );
  it('leaves an active explicit Connect attempt in charge', async () => {
    const f = await fixture();
    const connection = f.connection();
    const pending = {
      attemptId: 'explicit',
      state: 'connecting' as const,
      explicitAttempt: true,
      deadline: Date.now() + 10000,
    };
    await f.store.setMCPConnectionState(f.scope, pending, 20000, true);
    await f.notify({ ...f.ready, connection });
    expect(await f.read()).toEqual(pending);
    expect(connection.isConnected).not.toHaveBeenCalled();
  });
  it('recovers an abandoned attempt through a new verified checkout', async () => {
    const f = await fixture();
    const connection = f.connection();
    await f.store.setMCPConnectionState(
      f.scope,
      { attemptId: 'abandoned', state: 'connecting', deadline: Date.now() - 1 },
      20000,
      true,
    );
    await f.notify({ ...f.ready, connection });
    expect(await f.read()).toMatchObject({ state: 'connected' });
    connection.emit('disposed');
  });
  it('cannot claim over a newer peer attempt after reading old failure state', async () => {
    const f = await fixture();
    const connection = f.connection();
    const old = { attemptId: 'old', state: 'error' as const, deadline: Date.now() };
    const peer = {
      ...old,
      attemptId: 'peer',
      state: 'connecting' as const,
      deadline: Date.now() + 10000,
    };
    await f.store.setMCPConnectionState(f.scope, old, 20000, true);
    const notify = createMCPConnectionStatusObserver({
      ...f.store,
      getMCPConnectionState: async (scope) => {
        const captured = await f.store.getMCPConnectionState(scope);
        await f.store.setMCPConnectionState(scope, peer, 20000, true);
        return captured;
      },
    });
    await notify({ ...f.ready, connection });
    expect(await f.read()).toEqual(peer);
    expect(connection.isConnected).not.toHaveBeenCalled();
  });
  it('observes a shared app checkout once per user and keeps both users isolated', async () => {
    const f = await fixture();
    const connection = f.connection();
    const notify = createMCPConnectionStatusObserver({
      ...f.store,
      getGeneration: (scope) => f.store.getMCPToolsCacheGeneration(scope),
    });
    await notify({ ...f.ready, publicationGeneration: undefined, connection });
    const first = await f.read();
    await notify({ ...f.ready, publicationGeneration: undefined, connection });
    expect((await f.read())?.attemptId).toBe(first?.attemptId);
    expect(connection.isConnected).toHaveBeenCalledTimes(1);
    await notify({
      ...f.ready,
      userId: 'other-user',
      publicationGeneration: undefined,
      connection,
    });
    const otherGeneration = await f.store.getMCPToolsCacheGeneration({
      userId: 'other-user',
      serverName: f.params.serverName,
    });
    const other = await f.store.getMCPConnectionState({
      ...f.scope,
      userId: 'other-user',
      publicationGeneration: otherGeneration!,
    });
    expect(other?.state).toBe('connected');
    expect(other?.attemptId).not.toBe(first?.attemptId);
    expect((await f.read())?.attemptId).toBe(first?.attemptId);
    connection.emit('disposed');
  });
});
