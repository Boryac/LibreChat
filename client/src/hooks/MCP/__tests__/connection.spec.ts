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

describe('observed recovery after failed Connect', () => {
  const statuses = {
    example: {
      requiresOAuth: false,
      connectionState: 'connected' as const,
      connectionStateSource: 'transport' as const,
    },
  };
  const results = {
    example: {
      id: 'attempt',
      configKey: getMCPConnectKey(server, 'owner'),
      settledAt: 100,
      state: 'error' as const,
    },
  };
  it('lets a later observed connected transport supersede the failure', () => {
    expect(
      applyMCPConnectResults(statuses, results, { example: server }, 'owner', 101)?.example
        .connectionState,
    ).toBe('connected');
  });
  it.each([undefined, 99, 100])(
    'retains failure against an older or unordered read (%s)',
    (readStartedAt) => {
      expect(
        applyMCPConnectResults(statuses, results, { example: server }, 'owner', readStartedAt)
          ?.example.connectionState,
      ).toBe('error');
    },
  );
  it('does not treat durable OAuth readiness as a new live transport', () => {
    expect(
      applyMCPConnectResults(
        { example: { ...statuses.example, connectionStateSource: 'authorization' } },
        results,
        { example: server },
        'owner',
        101,
      )?.example.connectionState,
    ).toBe('error');
  });
});

it.each(['error', 'connecting', 'disconnected'] as const)(
  'only newer observed %s can supersede a successful Connect',
  (state) => {
    const results = {
      example: {
        id: 'attempt',
        configKey: getMCPConnectKey(server, 'owner'),
        settledAt: 100,
        state: 'connected' as const,
      },
    };
    const statuses = {
      example: {
        requiresOAuth: false,
        connectionState: state,
        connectionStateSource: 'transport' as const,
      },
    };
    expect(
      applyMCPConnectResults(statuses, results, { example: server }, 'owner', 99)?.example
        .connectionState,
    ).toBe('connected');
    expect(
      applyMCPConnectResults(statuses, results, { example: server }, 'owner', 101)?.example
        .connectionState,
    ).toBe(state);
  },
);
