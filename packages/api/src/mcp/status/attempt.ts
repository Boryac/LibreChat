import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { MCPConnectionAttempt } from 'librechat-data-provider';
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
import { projectMCPConnectionAttempt } from './projection';
import { validateMCPConnectionAttemptId } from './request';
import { requiresEphemeralUserConnection } from '../utils';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface MCPConnectionStatusPolicy {
  attemptTimeoutMs: number;
  evidenceFreshnessMs: number;
  resultRetentionMs: number;
}

export const DEFAULT_MCP_CONNECTION_STATUS_POLICY: MCPConnectionStatusPolicy = {
  attemptTimeoutMs: 60_000,
  evidenceFreshnessMs: 90_000,
  resultRetentionMs: 600_000,
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

class MCPStatusUnavailableError extends Error {}

async function statusOperation<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    logger.warn('[MCP Connection Status] Shared outcome unavailable', getSafeErrorMetadata(error));
    throw new MCPStatusUnavailableError('MCP connection outcome could not be confirmed');
  }
}

function unavailableResult(
  serverName: string,
): MCPReinitializeStopResult & { statusUnavailable: true } {
  return {
    success: false,
    statusUnavailable: true,
    availableTools: null,
    tools: null,
    serverName,
    oauthRequired: false,
    oauthUrl: null,
    failureReason: 'status_unavailable',
    message: 'MCP connection outcome could not be confirmed; try again',
  };
}

/** Bounded explicit Connect operation. No listeners, heartbeat or manager checkout side effects. */
export async function runMCPConnectionAttempt<T extends AttemptResult>(
  params: {
    attemptId?: string;
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
): Promise<
  | ((T | MCPReinitializeStopResult) & {
      connectionAttempt?: MCPConnectionAttempt;
      statusUnavailable?: boolean;
    })
  | undefined
> {
  const policy = { ...DEFAULT_MCP_CONNECTION_STATUS_POLICY, ...params.policy };
  const attemptId = validateMCPConnectionAttemptId(params.attemptId);
  if (requiresEphemeralUserConnection(params.serverConfig)) {
    return deps.connect(
      () => {},
      AbortSignal.timeout(policy.attemptTimeoutMs),
      params.serverConfig,
    );
  }
  const deadline = Date.now() + policy.attemptTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('MCP connection deadline expired')),
    policy.attemptTimeoutMs,
  );
  timer.unref?.();
  const budget = controller.signal;
  try {
    const setState: MCPConnectionStateStore['setMCPConnectionState'] = (...args) =>
      statusOperation(deps.setMCPConnectionState(...args));
    const getState: MCPConnectionStateStore['getMCPConnectionState'] = (...args) =>
      statusOperation(deps.getMCPConnectionState(...args));
    const generation = await withDeadline(deps.getGeneration(), budget);
    if (!generation) throw new Error('MCP connection attempt has no authorization generation');
    const scope: MCPConnectionStateScope = {
      userId: params.userId,
      serverName: params.serverName,
      configGeneration: getMCPToolCatalogGeneration(params.serverConfig, params.capabilityProfile),
      publicationGeneration: generation,
    };
    const record: MCPConnectionStateRecord = {
      attemptId: attemptId ?? randomUUID(),
      state: 'connecting',
      startedAt: Date.now(),
      deadline,
    };
    const signal = budget;
    const retainedTtl =
      policy.attemptTimeoutMs + Math.max(policy.resultRetentionMs, policy.evidenceFreshnessMs);
    if (!(await withDeadline(setState(scope, record, retainedTtl, true), budget))) {
      throw new MCPStatusUnavailableError('MCP connection attempt was superseded');
    }
    // Read back the admission timestamp/deadline assigned atomically by the shared store.
    const admitted = await withDeadline(getState(scope), budget);
    if (!admitted || admitted.attemptId !== record.attemptId) {
      throw new MCPStatusUnavailableError('MCP connection attempt was superseded');
    }
    Object.assign(record, admitted);
    const complete = async (terminal: MCPConnectionStateRecord): Promise<MCPConnectionAttempt> => {
      if (!(await withDeadline(setState(scope, terminal, retainedTtl), signal))) {
        throw new MCPStatusUnavailableError('MCP connection attempt was superseded or expired');
      }
      const committed = await withDeadline(getState(scope), signal);
      if (
        !committed ||
        committed.attemptId !== record.attemptId ||
        committed.state !== terminal.state
      ) {
        throw new MCPStatusUnavailableError('MCP connection outcome could not be confirmed');
      }
      return projectMCPConnectionAttempt(committed, scope.publicationGeneration);
    };
    let connection: ObservedMCPConnection | undefined;
    let verified = false;
    try {
      signal.throwIfAborted();
      const resolution = await withDeadline<MCPReinitializeConfigResolution>(
        deps.resolveConfig?.() ?? Promise.resolve({ serverConfig: params.serverConfig }),
        signal,
      );
      if (resolution.result) {
        return {
          ...resolution.result,
          connectionAttempt: await complete({ ...record, state: 'error' }),
        };
      }
      const serverConfig = resolution.serverConfig ?? params.serverConfig;
      const configGeneration = getMCPToolCatalogGeneration(serverConfig, params.capabilityProfile);
      if (configGeneration !== scope.configGeneration) {
        scope.configGeneration = configGeneration;
        if (
          !(await withDeadline(setState(scope, { ...record, deadline }, retainedTtl, true), signal))
        )
          throw new MCPStatusUnavailableError('MCP connection attempt was superseded');
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
        return {
          ...result,
          connectionAttempt: await complete({ ...record, state: 'disconnected' }),
        };
      }
      if (!result?.success || !connection) {
        const connectionAttempt = await complete({ ...record, state: 'error' });
        if (result?.success) throw new Error('MCP connection verification failed');
        return result && { ...result, connectionAttempt };
      }

      record.requiresOAuth = connection.usesOAuth?.() === true;
      const connectionGeneration = deps.getConnectionGeneration?.(connection);
      if (connectionGeneration && connectionGeneration !== scope.publicationGeneration) {
        // OAuth may rotate this attempt's credentials during initialization. Only the
        // generation bound to this exact connection can be adopted, without replacing a peer.
        scope.publicationGeneration = connectionGeneration;
        if (
          !(await withDeadline(
            setState(scope, { ...record, deadline }, retainedTtl, 'ifAbsent'),
            signal,
          ))
        ) {
          throw new MCPStatusUnavailableError('MCP connection attempt was superseded');
        }
      }
      if (!(await withDeadline(connection.isConnected(signal, true), signal))) {
        throw new Error('MCP connection could not be verified');
      }
      verified = true;
      const completed: MCPConnectionStateRecord = {
        ...record,
        state: 'connected',
        verifiedUntil: Date.now() + policy.evidenceFreshnessMs,
      };
      return { ...result, connectionAttempt: await complete(completed) };
    } catch (error) {
      try {
        await withDeadline(
          setState(
            scope,
            {
              ...record,
              state: 'error',
              statusUnavailable:
                error instanceof MCPStatusUnavailableError || (signal.aborted && verified),
            },
            retainedTtl,
          ),
          signal,
        );
      } catch (publicationError) {
        logger.warn(
          '[MCP Connection Status] Could not publish attempt failure',
          getSafeErrorMetadata(publicationError),
        );
      }
      if (error instanceof MCPStatusUnavailableError || (signal.aborted && verified))
        return unavailableResult(params.serverName);
      if (signal.aborted) {
        return {
          connectionAttempt: projectMCPConnectionAttempt(
            { ...record, state: 'error' },
            scope.publicationGeneration,
          ),
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
  } catch (error) {
    if (error instanceof MCPStatusUnavailableError) return unavailableResult(params.serverName);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
