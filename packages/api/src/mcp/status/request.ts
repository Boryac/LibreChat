import { logger } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '~/utils/errors';

export class MCPConnectionRequestError extends Error {}

export function validateMCPConnectionAttemptId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new MCPConnectionRequestError('Invalid MCP operation identifier');
  }
  return value;
}

export function getMCPConnectionAttemptErrorResponse(error: unknown): {
  status: 400 | 500;
  body: { error: string };
} {
  if (error instanceof MCPConnectionRequestError) {
    return { status: 400, body: { error: 'Invalid MCP operation identifier' } };
  }
  logger.error('[MCP Reinitialize] Unexpected error', getSafeErrorMetadata(error));
  return { status: 500, body: { error: 'Internal server error' } };
}
