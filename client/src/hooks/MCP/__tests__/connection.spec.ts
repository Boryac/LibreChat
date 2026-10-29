import { getMCPConnectKey, applyMCPConnectResults } from '../connection';

const server = {
  serverName: 'example',
  type: 'streamable-http' as const,
  url: 'https://example.test',
};

it('retains a Connect outcome when only discovered metadata changes', () => {
  const initial = { ...server, initDuration: 25, inspectionFailed: true };
  const discovered = {
    ...server,
    initDuration: 100,
    inspectionFailed: false,
    requiresOAuth: false,
  };
  const statuses = {
    example: {
      requiresOAuth: false,
      connectionState: 'disconnected' as const,
      connectionStateSource: 'unobserved' as const,
    },
  };
  expect(
    applyMCPConnectResults(
      statuses,
      {
        example: {
          id: 'attempt',
          configKey: getMCPConnectKey(initial, 'owner'),
          state: 'connected',
        },
      },
      { example: discovered },
      'owner',
    )?.example.connectionState,
  ).toBe('connected');
});

it('invalidates a result when configuration or its owner changes', () => {
  const key = getMCPConnectKey(server, 'owner');
  expect(getMCPConnectKey({ ...server, url: 'https://changed.test' }, 'owner')).not.toBe(key);
  expect(getMCPConnectKey(server, 'other-owner')).not.toBe(key);
});

it('binds recovered Connect to the used revision and rejects later configuration edits', () => {
  const initial = { ...server, updatedAt: 100 };
  const recovered = { ...server, updatedAt: 200 };
  const statuses = {
    example: {
      requiresOAuth: false,
      connectionState: 'disconnected' as const,
      connectionStateSource: 'unobserved' as const,
    },
  };
  const results = {
    example: {
      id: 'attempt',
      configKey: getMCPConnectKey(initial, 'owner'),
      configurationUpdatedAt: 200,
      state: 'connected' as const,
    },
  };
  expect(
    applyMCPConnectResults(statuses, results, { example: recovered }, 'owner')?.example
      .connectionState,
  ).toBe('connected');
  const edited = { ...recovered, updatedAt: 300 };
  expect(
    applyMCPConnectResults(statuses, results, { example: edited }, 'owner')?.example
      .connectionState,
  ).toBe('disconnected');
});

it('never masks an authorization requirement with retained Connect success', () => {
  const statuses = {
    example: {
      requiresOAuth: true,
      authorizationState: 'needs_authorization' as const,
      connectionState: 'disconnected' as const,
    },
  };
  const results = {
    example: {
      id: 'attempt',
      configKey: getMCPConnectKey(server, 'owner'),
      state: 'connected' as const,
    },
  };
  expect(
    applyMCPConnectResults(
      statuses,
      results,
      { example: { ...server, requiresOAuth: true } },
      'owner',
    )?.example.connectionState,
  ).toBe('disconnected');
});
