import type { MCPServerStatus } from 'librechat-data-provider';
import type { MCPClientCapabilityProfile } from '../capabilities';
import type { ParsedServerConfig } from '../types';

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
    expectedAttemptId?: string,
  ) => Promise<boolean>;
}

export type MCPManagedConnectionObserver = (params: {
  connection: ObservedMCPConnection;
  userId: string;
  serverName: string;
  serverConfig: ParsedServerConfig;
  capabilityProfile: MCPClientCapabilityProfile;
  publicationGeneration?: string;
  created: boolean;
  signal?: AbortSignal;
}) => Promise<void>;

export interface ObservedMCPConnection {
  isConnected: (signal?: AbortSignal, force?: boolean) => Promise<boolean>;
  usesOAuth?: () => boolean;
  on: (
    event: 'connectionChange',
    listener: (state: MCPConnectionStateRecord['state']) => void,
  ) => unknown;
  once: (event: 'disposed', listener: () => void) => unknown;
  removeListener(
    event: 'connectionChange',
    listener: (state: MCPConnectionStateRecord['state']) => void,
  ): unknown;
  removeListener(event: 'disposed', listener: () => void): unknown;
}
