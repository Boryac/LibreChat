import express from 'express';
import request from 'supertest';
import type { MCPReinitializeDependencies } from './connect';
import { createMCPReinitializeHandler } from './connect';

function setup() {
  const reinitialize = jest.fn().mockResolvedValue({
    success: true,
    message: 'Connected',
    serverName: 'server',
    oauthRequired: false,
  });
  const invalidate = jest.fn().mockResolvedValue('connect-generation');
  const disconnect = jest.fn().mockResolvedValue(undefined);
  const dependencies: MCPReinitializeDependencies = {
    getMCPManager: () => ({ disconnectUserConnection: disconnect }),
    getMCPServersRegistry: () => ({
      getServerConfig: jest.fn().mockResolvedValue({
        type: 'streamable-http',
        url: 'https://mcp.example.test',
        requiresOAuth: false,
      }),
    }),
    resolveConfigServers: async () => undefined,
    invalidateCachedTools: invalidate,
    db: { findPluginAuthsByKeys: jest.fn().mockResolvedValue([]) },
    getTenantId: () => 'tenant',
    createOpenIDSessionTokenProvider: () => async () => null,
    reinitMCPServer: reinitialize,
  };
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: { id: 'user', role: 'USER' } });
    next();
  });
  app.post('/:serverName/reinitialize', createMCPReinitializeHandler(dependencies));
  return { app, dependencies, reinitialize, invalidate, disconnect };
}

describe('Connect response ownership', () => {
  const originalSecret = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = 'synthetic-test-secret';
  });
  afterAll(() => {
    if (originalSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  });
  it('returns the operation outcome and invalidated generation without another shared write', async () => {
    const fixture = setup();
    const response = await request(fixture.app).post('/server/reinitialize').expect(200);
    expect(response.body).toMatchObject({
      success: true,
      authorizationGeneration: 'connect-generation',
    });
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
    expect(fixture.disconnect).toHaveBeenCalledWith('user', 'server');
    expect(fixture.reinitialize).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.any(AbortSignal), forceNew: true }),
    );
  });
  it('returns confirmed failure without treating the HTTP 200 as successful Connect', async () => {
    const fixture = setup();
    fixture.reinitialize.mockResolvedValueOnce({
      success: false,
      message: 'Failed',
      serverName: 'server',
      oauthRequired: false,
      failureReason: 'initialization_failed',
    });
    const response = await request(fixture.app).post('/server/reinitialize').expect(200);
    expect(response.body).toMatchObject({ success: false, failureReason: 'initialization_failed' });
  });
  it('preserves OAuth URL, flow identifier, cookie and timeout', async () => {
    const fixture = setup();
    fixture.reinitialize.mockResolvedValueOnce({
      success: true,
      message: 'OAuth',
      serverName: 'server',
      oauthRequired: true,
      oauthUrl: 'https://auth.example.test',
      oauthExpiresAt: Date.now() + 60000,
    });
    const response = await request(fixture.app).post('/server/reinitialize').expect(200);
    expect(response.body).toMatchObject({
      oauthRequired: true,
      oauthUrl: 'https://auth.example.test',
    });
    expect(response.body.flowId).toContain('server');
    expect(response.body.oauthTimeout).toBeGreaterThan(0);
    expect(response.headers['set-cookie']).toBeDefined();
  });
  it('sanitizes unexpected failures at the HTTP boundary', async () => {
    const fixture = setup();
    fixture.reinitialize.mockRejectedValueOnce(new Error('secret-token'));
    const response = await request(fixture.app).post('/server/reinitialize').expect(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
  });
});
