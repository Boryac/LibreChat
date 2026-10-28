import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { MCPServerStatus } from 'librechat-data-provider';
import { useMCPConnectionStatusQuery } from '~/data-provider/Tools/queries';
import { canReconcileMCPResult, projectMCPStatus } from './outcome';
import { mcpConnectionResultsAtom } from '~/store/mcp';

export function useMCPConnectionStatus({ enabled }: { enabled?: boolean } = {}) {
  const { data, dataUpdatedAt, isError } = useMCPConnectionStatusQuery({ enabled });
  const results = useAtomValue(mcpConnectionResultsAtom);
  const [, refresh] = useState(0);
  const now = Date.now();
  const connectionStatus: Record<string, MCPServerStatus> = {};
  let nextExpiry = Infinity;
  const names = new Set([...Object.keys(data?.connectionStatus ?? {}), ...Object.keys(results)]);
  for (const name of names) {
    const remote = data?.connectionStatus[name];
    const result = results[name];
    const useResult = result && !canReconcileMCPResult(result, remote, dataUpdatedAt);
    const status = useResult ? result.status : remote;
    if (!status) continue;
    const receivedAt = useResult ? result.receivedAt : dataUpdatedAt;
    connectionStatus[name] = projectMCPStatus(status, receivedAt, now, !useResult && isError);
    if (
      status.connectionAttempt &&
      (status.connectionState === 'connected' || status.connectionState === 'connecting')
    ) {
      const expiry = receivedAt + status.connectionAttempt.remainingMs;
      if (expiry > now) nextExpiry = Math.min(nextExpiry, expiry);
    }
  }
  useEffect(() => {
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(
      () => refresh((value) => value + 1),
      Math.max(1, nextExpiry - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [nextExpiry]);
  return { connectionStatus: names.size > 0 ? connectionStatus : undefined };
}
