import { ProtocolError } from '@modelcontextprotocol/server';

/** JSON-RPC error codes from the MCP Events design sketch. */
export const EventsErrorCode = {
  InvalidParams: -32602,
  NotFound: -32011,
  Forbidden: -32012,
  ResourceExhausted: -32013,
  Unsupported: -32014,
  CallbackEndpointError: -32015,
  InternalError: -32603,
} as const;

/** Categories the sketch allows in `data.reason` and `deliveryStatus.lastError`. */
export type CallbackFailureReason =
  | 'connection_refused'
  | 'timeout'
  | 'tls_error'
  | 'http_4xx'
  | 'http_5xx'
  | 'challenge_failed';

export const invalidParams = (message: string, data?: Record<string, unknown>) =>
  new ProtocolError(EventsErrorCode.InvalidParams, message, data);

export const notFound = (kind: 'event' | 'subscription', message: string) =>
  new ProtocolError(EventsErrorCode.NotFound, message, { kind });

export const forbidden = (message = 'An authenticated principal is required') =>
  new ProtocolError(EventsErrorCode.Forbidden, message);

export const resourceExhausted = (limit: string, message: string) =>
  new ProtocolError(EventsErrorCode.ResourceExhausted, message, { limit });

export const unsupported = (feature: string, value: unknown) =>
  new ProtocolError(EventsErrorCode.Unsupported, `Unsupported ${feature}`, { feature, value });

export const callbackEndpointError = (reason: CallbackFailureReason) =>
  new ProtocolError(EventsErrorCode.CallbackEndpointError, 'CallbackEndpointError', { reason });

export const internalError = (message: string) => new ProtocolError(EventsErrorCode.InternalError, message);
