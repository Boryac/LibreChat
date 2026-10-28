import type { MCPConnectionStateRecord } from './types';
import { getMCPServerConnectionStatus, finalizeMCPConnectionStatus } from '../connectionStatus';
import { readMCPConnectionObservation } from './read';

describe('shared MCP connection status', () => {
  const config = { type: 'streamable-http' as const, url: 'https://mcp.example/mcp' };
  const params = {
    userId: 'user',
    serverName: 'server',
    config,
    appConnections: new Map(),
    userConnections: new Map(),
    oauthServers: new Set<string>(),
    runtimeContext: {},
  };
  function dependencies(record: MCPConnectionStateRecord | null) {
    return {
      getSharedState: jest.fn(async () => ({ record, generation: 'current' })),
      getConnectionGeneration: jest.fn(() => 'old'),
      isReconnecting: jest.fn(() => false),
      checkOAuthFlowStatus: jest.fn(async () => ({ hasActiveFlow: false, hasFailedFlow: false })),
      hasDurableAuthorization: jest.fn(async () => true),
      getUserConfigurationState: jest.fn(async () => 'configured' as const),
    };
  }
  const observation = (state: MCPConnectionStateRecord['state']): MCPConnectionStateRecord => ({
    attemptId: 'attempt',
    state,
    deadline: Date.now() + 10000,
    verifiedUntil: Date.now() + 10000,
  });

  it.each(['connecting', 'connected', 'error', 'disconnected'] as const)(
    'reports the owner observation %s without a local transport',
    async (state) => {
      expect(
        await getMCPServerConnectionStatus(params, dependencies(observation(state))),
      ).toMatchObject({ connectionState: state });
    },
  );
  it('preserves runtime-detected OAuth actions on a replica without the connection', async () => {
    const deps = dependencies({ ...observation('connected'), requiresOAuth: true });
    expect(await getMCPServerConnectionStatus(params, deps)).toMatchObject({
      requiresOAuth: true,
      connectionState: 'connected',
      authorizationState: 'authorized',
    });
  });
  it('turns an abandoned pending attempt into Error', async () => {
    const record = { ...observation('connecting'), deadline: Date.now() - 1 };
    expect(await getMCPServerConnectionStatus(params, dependencies(record))).toMatchObject({
      connectionState: 'error',
    });
  });
  it('expires verified success instead of treating stored OAuth credentials as transport proof', async () => {
    const deps = dependencies({ ...observation('connected'), verifiedUntil: Date.now() - 1 });
    expect(
      await getMCPServerConnectionStatus({ ...params, oauthServers: new Set(['server']) }, deps),
    ).toMatchObject({
      connectionState: 'disconnected',
      authorizationState: 'authorized',
      statusUnavailable: true,
    });
    expect(deps.hasDurableAuthorization).toHaveBeenCalled();
  });
  it('does not resurrect process-local green when operation evidence is absent or expired', async () => {
    const connection = { isStale: () => false, connectionState: 'connected' as const };
    expect(
      await getMCPServerConnectionStatus(
        { ...params, userConnections: new Map([['server', connection]]) },
        dependencies(null),
      ),
    ).toMatchObject({ connectionState: 'disconnected' });
  });
  it('preserves the existing durable OAuth fallback when no explicit attempt was observed', async () => {
    const deps = dependencies(null);
    expect(
      await getMCPServerConnectionStatus({ ...params, oauthServers: new Set(['server']) }, deps),
    ).toMatchObject({ connectionState: 'connected', authorizationState: 'authorized' });
    expect(deps.hasDurableAuthorization).toHaveBeenCalled();
  });
  it('does not revive an unconfirmed OAuth handoff from its orphaned active flow', async () => {
    const deps = dependencies({
      ...observation('error'),
      requiresOAuth: true,
      statusUnavailable: true,
    });
    deps.checkOAuthFlowStatus.mockResolvedValue({ hasActiveFlow: true, hasFailedFlow: false });
    expect(await getMCPServerConnectionStatus(params, deps)).toMatchObject({
      connectionState: 'disconnected',
      statusUnavailable: true,
      authorizationState: 'authorized',
    });
    expect(deps.checkOAuthFlowStatus).not.toHaveBeenCalled();
  });
});

describe('bounded shared status reads', () => {
  it.each(['generation', 'state'])(
    'bounds a stalled %s read and cleans its deadline timer',
    async (stage) => {
      jest.useFakeTimers();
      try {
        const stalled = new Promise<never>(() => {});
        const read = readMCPConnectionObservation(
          {
            userId: 'user',
            serverName: 'server',
            serverConfig: { type: 'streamable-http', url: 'https://mcp.example/mcp' },
            timeoutMs: 25,
          },
          {
            getGeneration: () => (stage === 'generation' ? stalled : Promise.resolve('generation')),
            getMCPConnectionState: () => stalled,
          },
        );
        const rejection = read.catch((error: Error) => error);
        await jest.advanceTimersByTimeAsync(25);
        expect(await rejection).toEqual(new Error('MCP connection status read timed out'));
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    },
    1000,
  );
});

describe('authoritative observation fence', () => {
  const absent = {
    requiresOAuth: false,
    connectionState: 'disconnected' as const,
    connectionObservationAvailable: true,
    authorizationGeneration: 'inner',
  };
  it.each([undefined, 'changed'])(
    'rejects absence under a missing or changed outer fence: %s',
    (generation) => {
      expect(finalizeMCPConnectionStatus(absent, generation)).toMatchObject({
        connectionObservationAvailable: false,
        statusUnavailable: true,
      });
    },
  );
  it('accepts absence only under the same nonempty generation', () => {
    expect(finalizeMCPConnectionStatus(absent, 'inner')).toMatchObject({
      connectionObservationAvailable: true,
      authorizationGeneration: 'inner',
    });
  });
  it('does not mark an inner missing generation as an authoritative observation', async () => {
    const config = { type: 'streamable-http' as const, url: 'https://mcp.example/mcp' };
    const status = await getMCPServerConnectionStatus(
      {
        userId: 'u',
        serverName: 's',
        config,
        appConnections: new Map(),
        userConnections: new Map(),
        oauthServers: new Set(),
        runtimeContext: {},
      },
      {
        getSharedState: async () => ({ record: null, generation: undefined }),
        getConnectionGeneration: () => undefined,
        isReconnecting: () => false,
        checkOAuthFlowStatus: async () => ({ hasActiveFlow: false, hasFailedFlow: false }),
        hasDurableAuthorization: async () => false,
        getUserConfigurationState: async () => undefined,
      },
    );
    expect(finalizeMCPConnectionStatus(status, 'outer').connectionObservationAvailable).toBe(false);
  });
});
