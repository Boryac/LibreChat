import type { MCPConnectionStateRecord } from './types';
import { getMCPServerConnectionStatus } from '../connectionStatus';

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
    ).toMatchObject({ connectionState: 'disconnected', authorizationState: 'needs_authorization' });
    expect(deps.hasDurableAuthorization).not.toHaveBeenCalled();
  });
  it('rejects a local transport from an invalidated authorization generation', async () => {
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
});
