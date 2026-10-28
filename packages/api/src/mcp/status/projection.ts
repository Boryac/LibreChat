import type { MCPConnectionAttempt } from 'librechat-data-provider';
import type { MCPConnectionStateRecord } from './types';

export function projectMCPConnectionAttempt(
  record: MCPConnectionStateRecord,
  authorizationGeneration?: string,
): MCPConnectionAttempt {
  const now = record.serverNow ?? Date.now();
  const remainingMs = Math.max(
    0,
    (record.state === 'connecting' ? record.deadline : (record.verifiedUntil ?? now)) - now,
  );
  return {
    attemptId: record.attemptId,
    authorizationGeneration,
    startedAt: record.startedAt,
    state: record.state === 'connecting' && remainingMs === 0 ? 'error' : record.state,
    remainingMs,
  };
}
