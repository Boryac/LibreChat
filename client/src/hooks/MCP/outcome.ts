import type { MCPServerStatus } from 'librechat-data-provider';

export interface MCPConnectResult {
  status: MCPServerStatus;
  receivedAt: number;
  previousAttemptId?: string;
  pending: boolean;
  requestId?: string;
}

/** Operation outcomes and evidence freshness are independent of OAuth authorization. */
export function projectMCPStatus(
  status: MCPServerStatus,
  receivedAt: number,
  now: number,
  unavailable = false,
): MCPServerStatus {
  const attempt = status.connectionAttempt;
  const expired = attempt && now - receivedAt >= attempt.remainingMs;
  if (expired && status.connectionState === 'connecting') {
    return { ...status, connectionState: 'error' };
  }
  if ((expired && status.connectionState === 'connected') || unavailable) {
    return {
      ...status,
      connectionState: status.connectionState === 'error' ? 'error' : 'disconnected',
      statusUnavailable: status.connectionState !== 'error',
    };
  }
  return status;
}

export function canReconcileMCPResult(
  result: MCPConnectResult,
  remote: MCPServerStatus | undefined,
  updatedAt: number,
): boolean {
  if (result.pending || updatedAt < result.receivedAt || !remote) return false;
  if (
    result.status.authorizationGeneration &&
    remote.authorizationGeneration &&
    result.status.authorizationGeneration !== remote.authorizationGeneration
  )
    return true;
  if (
    remote.requiresOAuth &&
    (remote.authorizationState === 'needs_authorization' || remote.authorizationState === 'error')
  )
    return true;
  if (remote.statusUnavailable && result.status.connectionState !== 'error') return true;
  if (!remote.connectionAttempt) return false;
  const local = result.status.connectionAttempt;
  const next = remote.connectionAttempt;
  if (!local) return next.attemptId !== result.previousAttemptId;
  if (next.attemptId === local.attemptId) {
    return (
      result.status.statusUnavailable === true ||
      local.state === 'connecting' ||
      next.state === local.state
    );
  }
  return local.startedAt != null && next.startedAt != null && next.startedAt > local.startedAt;
}
