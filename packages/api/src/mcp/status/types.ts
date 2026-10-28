import type { MCPServerStatus } from 'librechat-data-provider';

export interface MCPConnectionStateScope {
  userId: string;
  serverName: string;
  configGeneration: string;
  publicationGeneration: string;
}

/** A bounded explicit operation. Only Pending may transition, once, to a terminal result. */
export interface MCPConnectionStateRecord {
  attemptId: string;
  state: MCPServerStatus['connectionState'];
  startedAt?: number;
  /** Read-time clock from the store; never used as proof of authorization. */
  serverNow?: number;
  deadline: number;
  verifiedUntil?: number;
  requiresOAuth?: boolean;
  statusUnavailable?: boolean;
}

export interface MCPConnectionStateStore {
  getMCPConnectionState: (
    scope: MCPConnectionStateScope,
  ) => Promise<MCPConnectionStateRecord | null>;
  /** claim starts a new operation; updates can only finish the current, unexpired Pending operation. */
  setMCPConnectionState: (
    scope: MCPConnectionStateScope,
    record: MCPConnectionStateRecord,
    ttl: number,
    claim?: boolean | 'ifAbsent',
  ) => Promise<boolean>;
}

export interface ObservedMCPConnection {
  isConnected: (signal?: AbortSignal, force?: boolean) => Promise<boolean>;
  usesOAuth?: () => boolean;
}
