import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, renderHook } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MCPConnectionStatusResponse, MCPServerStatus } from 'librechat-data-provider';
import { canReconcileMCPResult, projectMCPStatus } from '../outcome';
import { useMCPConnectionStatus } from '../useMCPConnectionStatus';
import { mcpConnectionResultsAtom } from '~/store/mcp';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const success: MCPServerStatus = {
  requiresOAuth: true,
  authorizationState: 'authorized',
  connectionState: 'connected',
  connectionAttempt: { attemptId: 'old', state: 'connected', startedAt: 10, remainingMs: 1000 },
};

describe('Connect outcomes and evidence freshness', () => {
  it('expires connectivity evidence without revoking OAuth authorization', () => {
    expect(projectMCPStatus(success, 100, 1100)).toMatchObject({
      connectionState: 'disconnected',
      statusUnavailable: true,
      authorizationState: 'authorized',
      connectionAttempt: { state: 'connected' },
    });
  });
  it('keeps the latest action over a stale GET, and reconciles only its own or a newer operation', () => {
    const result = {
      status: {
        ...success,
        connectionState: 'error' as const,
        connectionAttempt: { ...success.connectionAttempt!, attemptId: 'new', startedAt: 20 },
      },
      receivedAt: 100,
      pending: false,
    };
    expect(canReconcileMCPResult(result, success, 101)).toBe(false);
    expect(canReconcileMCPResult(result, result.status, 101)).toBe(true);
    expect(
      canReconcileMCPResult(
        result,
        {
          ...result.status,
          connectionAttempt: { ...result.status.connectionAttempt, state: 'connecting' },
        },
        101,
      ),
    ).toBe(false);
    expect(canReconcileMCPResult({ ...result, pending: true }, result.status, 101)).toBe(false);
    expect(
      canReconcileMCPResult(
        result,
        { ...success, connectionAttempt: { ...success.connectionAttempt!, startedAt: 30 } },
        101,
      ),
    ).toBe(true);
  });

  it('requires a successful absent-history lookup initiated after the local action settled', () => {
    const result = {
      status: { requiresOAuth: false, connectionState: 'error' as const },
      receivedAt: 100,
      pending: false,
    };
    const absent = {
      requiresOAuth: false,
      connectionState: 'disconnected' as const,
      statusUnavailable: true,
      connectionObservationAvailable: true,
    };
    expect(canReconcileMCPResult(result, absent, 200, 90)).toBe(false);
    expect(canReconcileMCPResult(result, absent, 200)).toBe(false);
    expect(
      canReconcileMCPResult(result, { ...absent, connectionObservationAvailable: false }, 200, 110),
    ).toBe(false);
    expect(canReconcileMCPResult(result, absent, 200, 110)).toBe(true);
  });

  it('lets an authoritative revocation override first-connect green even without a previous cached generation', () => {
    const result = { status: success, receivedAt: 100, pending: false };
    expect(
      canReconcileMCPResult(
        result,
        {
          requiresOAuth: true,
          connectionState: 'disconnected',
          authorizationState: 'needs_authorization',
          authorizationGeneration: 'revoked',
        },
        101,
      ),
    ).toBe(true);
  });
  it('reconciles a lost response only with its correlated operation, not unrelated historical green', () => {
    const result = {
      status: {
        requiresOAuth: false,
        connectionState: 'disconnected' as const,
        statusUnavailable: true,
        connectionAttempt: { attemptId: 'lost', state: 'error' as const, remainingMs: 0 },
      },
      receivedAt: 100,
      pending: false,
    };
    expect(canReconcileMCPResult(result, success, 101)).toBe(false);
    expect(
      canReconcileMCPResult(
        result,
        { ...success, connectionAttempt: { ...success.connectionAttempt!, attemptId: 'lost' } },
        101,
      ),
    ).toBe(true);
  });

  describe('real query cache consumer', () => {
    let client: QueryClient;
    const store = createStore();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <Provider store={store}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </Provider>
    );
    beforeEach(() => {
      jest.useFakeTimers();
      client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });
      store.set(mcpConnectionResultsAtom, {});
      client.setQueryData<MCPConnectionStatusResponse>([QueryKeys.mcpConnectionStatus], {
        success: true,
        connectionStatus: { server: success },
      });
    });
    afterEach(() => {
      client.clear();
      jest.useRealTimers();
      jest.restoreAllMocks();
    });
    it('replaces retained failure only after a successful authoritative absent-history read', async () => {
      store.set(mcpConnectionResultsAtom, {
        server: {
          status: { requiresOAuth: false, connectionState: 'error' },
          receivedAt: Date.now(),
          pending: false,
        },
      });
      const get = jest.spyOn(dataService, 'getMCPConnectionStatus').mockResolvedValue({
        success: true,
        connectionStatus: {
          server: {
            requiresOAuth: false,
            connectionState: 'disconnected',
            statusUnavailable: true,
            connectionObservationAvailable: false,
          },
        },
      });
      const { result, unmount } = renderHook(() => useMCPConnectionStatus(), { wrapper });
      try {
        await act(async () => {
          jest.advanceTimersByTime(10);
          await client.invalidateQueries([QueryKeys.mcpConnectionStatus]);
        });
        await act(async () => {
          jest.advanceTimersByTime(10);
        });
        expect(result.current.connectionStatus?.server.connectionState).toBe('error');
        get.mockResolvedValue({
          success: true,
          connectionStatus: {
            server: {
              requiresOAuth: false,
              connectionState: 'disconnected',
              statusUnavailable: true,
              connectionObservationAvailable: true,
            },
          },
        });
        await act(async () => {
          jest.advanceTimersByTime(10);
          await client.invalidateQueries([QueryKeys.mcpConnectionStatus]);
        });
        await act(async () => {
          jest.advanceTimersByTime(10);
        });
        expect(result.current.connectionStatus?.server.connectionState).toBe('disconnected');
      } finally {
        unmount();
      }
    });
    it('preserves remaining freshness sampled after a slow status calculation', async () => {
      let resolve!: (value: MCPConnectionStatusResponse) => void;
      jest.spyOn(dataService, 'getMCPConnectionStatus').mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const { result, unmount } = renderHook(() => useMCPConnectionStatus(), { wrapper });
      act(() => {
        void client.invalidateQueries([QueryKeys.mcpConnectionStatus]);
      });
      await act(async () => {
        jest.advanceTimersByTime(2000);
        resolve({ success: true, connectionStatus: { server: success } });
      });
      await act(async () => {
        jest.advanceTimersByTime(10);
      });
      expect(result.current.connectionStatus?.server.connectionState).toBe('connected');
      await act(async () => {
        jest.advanceTimersByTime(500);
      });
      expect(result.current.connectionStatus?.server.connectionState).toBe('connected');
      unmount();
    });

    it('expires green in a focused browser without a refetch or transport heartbeat', async () => {
      const get = jest.spyOn(dataService, 'getMCPConnectionStatus');
      const { result, unmount } = renderHook(() => useMCPConnectionStatus(), { wrapper });
      expect(result.current.connectionStatus?.server.connectionState).toBe('connected');
      await act(async () => {
        jest.advanceTimersByTime(1001);
      });
      expect(result.current.connectionStatus?.server).toMatchObject({
        connectionState: 'disconnected',
        statusUnavailable: true,
        authorizationState: 'authorized',
      });
      expect(get).not.toHaveBeenCalled();
      unmount();
    });
    it('removes cached green when a status refresh fails', async () => {
      jest
        .spyOn(dataService, 'getMCPConnectionStatus')
        .mockRejectedValue(new Error('status unavailable'));
      const { result, unmount } = renderHook(() => useMCPConnectionStatus(), { wrapper });
      await act(async () => {
        await client.invalidateQueries([QueryKeys.mcpConnectionStatus]);
      });
      await act(async () => {
        jest.advanceTimersByTime(10);
      });
      expect(result.current.connectionStatus?.server).toMatchObject({
        connectionState: 'disconnected',
        statusUnavailable: true,
      });
      unmount();
    });
    it('keeps an explicit failure visible while the follow-up read fails or returns an older green result', async () => {
      jest
        .spyOn(dataService, 'getMCPConnectionStatus')
        .mockRejectedValue(new Error('status unavailable'));
      store.set(mcpConnectionResultsAtom, {
        server: {
          status: { requiresOAuth: false, connectionState: 'error' },
          receivedAt: Date.now(),
          previousAttemptId: 'old',
          pending: false,
        },
      });
      const { result, unmount } = renderHook(() => useMCPConnectionStatus(), { wrapper });
      await act(async () => {
        await client.invalidateQueries([QueryKeys.mcpConnectionStatus]);
      });
      await act(async () => {
        jest.advanceTimersByTime(10);
      });
      expect(result.current.connectionStatus?.server.connectionState).toBe('error');
      await act(async () => {
        client.setQueryData([QueryKeys.mcpConnectionStatus], {
          success: true,
          connectionStatus: { server: success },
        });
        jest.advanceTimersByTime(10);
      });
      expect(result.current.connectionStatus?.server.connectionState).toBe('error');
      unmount();
    });
  });
});
