import { getMCPConnectKey, applyMCPConnectResults } from '../connection';

const server = {
  serverName: 'example',
  type: 'streamable-http' as const,
  url: 'https://example.test',
};

it('retains a Connect outcome when only discovered metadata changes', () => {
  const initial = { ...server, initDuration: 25, inspectionFailed: true };
  const discovered = { ...server, initDuration: 100, inspectionFailed: false };
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
  const updatedServer = { ...server, updatedAt: 123 };
  expect(getMCPConnectKey(updatedServer, 'owner')).not.toBe(key);
  expect(getMCPConnectKey(server, 'other-owner')).not.toBe(key);
});
