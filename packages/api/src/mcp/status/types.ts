import type { MCPServerStatus } from 'librechat-data-provider';

export interface MCPConnectionStateScope {
  userId: string;
  serverName: string;
  configGeneration: string;
  publicationGeneration: string;
}

/** Actual explicit connection-attempt evidence, never inferred from configuration or a catalog. */
export interface MCPConnectionStateRecord {
  attemptId: string;
  state: MCPServerStatus['connectionState'];
  deadline: number;
  verifiedUntil?: number;
  requiresOAuth?: boolean;
}

export interface MCPConnectionStateStore {
  getMCPConnectionState: (
    scope: MCPConnectionStateScope,
  ) => Promise<MCPConnectionStateRecord | null>;
  setMCPConnectionState: (
    scope: MCPConnectionStateScope,
    record: MCPConnectionStateRecord,
    ttl: number,
    claim?: boolean | 'ifAbsent',
  ) => Promise<boolean>;
}
