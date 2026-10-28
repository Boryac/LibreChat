import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type {
  MCPConnectionStateScope,
  MCPConnectionStateRecord,
  MCPConnectionStateStore,
  ObservedMCPConnection,
} from './types';
import type { MCPReinitializeConfigResolution, MCPReinitializeStopResult } from '../reinitialize';
import type { MCPClientCapabilityProfile } from '../capabilities';
import type { ParsedServerConfig } from '../types';
import { getMCPToolCatalogGeneration } from '../toolsChanged';
import { requiresEphemeralUserConnection } from '../utils';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface MCPConnectionStatusPolicy {
  attemptTimeoutMs: number;
  leaseDurationMs: number;
  failureRetentionMs: number;
}

export const DEFAULT_MCP_CONNECTION_STATUS_POLICY: MCPConnectionStatusPolicy = {
  attemptTimeoutMs: 60_000,
  leaseDurationMs: 90_000,
  failureRetentionMs: 600_000,
};

interface AttemptResult {
  success: boolean;
  oauthRequired?: boolean;
  connectionDeferred?: boolean;
}

export function captureMCPConnection<T extends ObservedMCPConnection>(
  connect: () => Promise<T>,
  capture?: (connection: ObservedMCPConnection) => void,
): Promise<T> {
  return connect().then((connection) => {
    capture?.(connection);
    return connection;
  });
}

async function withDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([cancelled, operation]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Publish only connection-attempt results and observations from their owning live connection.
 * The shared authorization generation and attempt identity fence every late completion/update. */
export async function runMCPConnectionAttempt<T extends AttemptResult>(
  params: {
    userId: string;
    serverName: string;
    serverConfig: ParsedServerConfig;
    capabilityProfile: MCPClientCapabilityProfile;
    policy?: Partial<MCPConnectionStatusPolicy>;
  },
  deps: MCPConnectionStateStore & {
    getGeneration: () => Promise<string | undefined>;
    getConnectionGeneration?: (connection: ObservedMCPConnection) => string | undefined;
    resolveConfig?: () => Promise<MCPReinitializeConfigResolution>;
    connect: (
      capture: (connection: ObservedMCPConnection) => void,
      signal: AbortSignal,
      serverConfig: ParsedServerConfig,
    ) => Promise<T | undefined>;
  },
): Promise<T | MCPReinitializeStopResult | undefined> {
  const policy = { ...DEFAULT_MCP_CONNECTION_STATUS_POLICY, ...params.policy };
  if (requiresEphemeralUserConnection(params.serverConfig)) {
    return deps.connect(
      () => {},
      AbortSignal.timeout(policy.attemptTimeoutMs),
      params.serverConfig,
    );
  }
  const generation = await deps.getGeneration();
  if (!generation) throw new Error('MCP connection attempt has no authorization generation');
  const scope: MCPConnectionStateScope = {
    userId: params.userId,
    serverName: params.serverName,
    configGeneration: getMCPToolCatalogGeneration(params.serverConfig, params.capabilityProfile),
    publicationGeneration: generation,
  };
  const record: MCPConnectionStateRecord = {
    attemptId: randomUUID(),
    state: 'connecting',
    explicitAttempt: true,
    deadline: Date.now() + policy.attemptTimeoutMs,
  };
  const signal = AbortSignal.timeout(Math.max(1, record.deadline - Date.now()));
  const retainedTtl = policy.attemptTimeoutMs + policy.failureRetentionMs;
  if (!(await deps.setMCPConnectionState(scope, record, retainedTtl, true))) {
    throw new Error('MCP connection attempt was superseded');
  }
  let connection: ObservedMCPConnection | undefined;
  try {
    signal.throwIfAborted();
    const resolution = await withDeadline<MCPReinitializeConfigResolution>(
      deps.resolveConfig?.() ?? Promise.resolve({ serverConfig: params.serverConfig }),
      signal,
    );
    if (resolution.result) {
      await deps.setMCPConnectionState(scope, { ...record, state: 'error' }, retainedTtl);
      return resolution.result;
    }
    const serverConfig = resolution.serverConfig ?? params.serverConfig;
    const configGeneration = getMCPToolCatalogGeneration(serverConfig, params.capabilityProfile);
    if (configGeneration !== scope.configGeneration) {
      scope.configGeneration = configGeneration;
      if (!(await deps.setMCPConnectionState(scope, record, retainedTtl, true)))
        throw new Error('MCP connection attempt was superseded');
    }
    const result = await withDeadline(
      deps.connect(
        (value) => {
          connection = value;
        },
        signal,
        serverConfig,
      ),
      signal,
    );
    if (result?.oauthRequired || result?.connectionDeferred) {
      record.requiresOAuth = result.oauthRequired === true;
      // OAuth has its own guarded flow and readiness reinitialization. A deferred
      // chat-scoped connection likewise cannot be advertised as a verified transport.
      await deps.setMCPConnectionState(scope, { ...record, state: 'disconnected' }, retainedTtl);
      return result;
    }
    if (!result?.success || !connection) {
      await deps.setMCPConnectionState(scope, { ...record, state: 'error' }, retainedTtl);
      if (result?.success) throw new Error('MCP connection verification failed');
      return result;
    }
    record.requiresOAuth = connection.usesOAuth?.() === true;
    const connectionGeneration = deps.getConnectionGeneration?.(connection);
    if (connectionGeneration && connectionGeneration !== scope.publicationGeneration) {
      // OAuth may rotate this attempt's credentials during initialization. Only the
      // generation bound to this exact connection can be adopted, without replacing a peer.
      scope.publicationGeneration = connectionGeneration;
      if (!(await deps.setMCPConnectionState(scope, record, retainedTtl, 'ifAbsent'))) {
        throw new Error('MCP connection attempt was superseded');
      }
    }
    const observer = observeMCPConnection(connection, scope, record, policy, deps);
    if (
      !(await withDeadline(observer.ready, signal).catch((error) => {
        observer.stop();
        throw error;
      }))
    ) {
      observer.stop();
      throw new Error('MCP connection could not be verified or its attempt was superseded');
    }
    return result;
  } catch (error) {
    try {
      await deps.setMCPConnectionState(scope, { ...record, state: 'error' }, retainedTtl);
    } catch (publicationError) {
      logger.warn(
        '[MCP Connection Status] Could not publish attempt failure',
        getSafeErrorMetadata(publicationError),
      );
    }
    if (signal.aborted) {
      return {
        availableTools: null,
        success: false,
        message: `MCP server '${params.serverName}' connection timed out; try connecting again`,
        failureReason: 'initialization_failed',
        oauthRequired: false,
        serverName: params.serverName,
        oauthUrl: null,
        tools: null,
      };
    }
    throw error;
  }
}

export function observeMCPConnection(
  connection: ObservedMCPConnection,
  scope: MCPConnectionStateScope,
  initial: MCPConnectionStateRecord,
  policy: MCPConnectionStatusPolicy,
  store: MCPConnectionStateStore,
  onStop?: () => void,
): { ready: Promise<boolean>; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let epoch = 0;
  let stopped = false;
  let activeProbe: AbortController | undefined;
  let publication: Promise<boolean> = Promise.resolve(true);
  const interval = Math.floor(policy.leaseDurationMs / 3);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    activeProbe?.abort();
    clearTimeout(timer);
    connection.removeListener('connectionChange', change);
    connection.removeListener('disposed', disposed);
    onStop?.();
  };
  const publish = (state: MCPConnectionStateRecord['state'], disposed = false) => {
    const observedEpoch = ++epoch;
    activeProbe?.abort();
    clearTimeout(timer);
    publication = publication
      .then(async () => {
        if (observedEpoch !== epoch || (stopped && !disposed)) return false;
        let verified = state;
        if (state === 'connected') {
          const controller = new AbortController();
          activeProbe = controller;
          const signal = AbortSignal.any([AbortSignal.timeout(interval), controller.signal]);
          try {
            if (!(await withDeadline(connection.isConnected(signal, true), signal))) {
              verified = 'error';
            }
          } catch {
            verified = 'error';
          } finally {
            if (activeProbe === controller) activeProbe = undefined;
          }
          if (observedEpoch !== epoch || stopped) return false;
        }
        const current = await store.setMCPConnectionState(
          scope,
          {
            ...initial,
            state: verified,
            explicitAttempt: false,
            deadline:
              state === 'connecting' ? Date.now() + policy.attemptTimeoutMs : initial.deadline,
            ...(verified === 'connected' && { verifiedUntil: Date.now() + policy.leaseDurationMs }),
          },
          (state === 'connecting' ? policy.attemptTimeoutMs : policy.leaseDurationMs) +
            policy.failureRetentionMs,
        );
        if (!current) stop();
        return current && observedEpoch === epoch && (disposed || !stopped) && verified === state;
      })
      .catch((error) => {
        logger.warn(
          '[MCP Connection Status] Could not publish connection observation',
          getSafeErrorMetadata(error),
        );
        return false;
      })
      .finally(() => {
        if (!stopped && observedEpoch === epoch && state === 'connected') {
          timer = setTimeout(() => publish('connected'), interval);
          timer.unref?.();
        }
      });
    return publication;
  };
  const change = (state: MCPConnectionStateRecord['state']) => publish(state);
  const disposed = () => {
    stop();
    publish('disconnected', true);
  };
  connection.on('connectionChange', change);
  connection.once('disposed', disposed);
  return { ready: publish('connected'), stop };
}
