import { ProtocolError } from '@modelcontextprotocol/server';

/** JSON-RPC error codes from SEP-3415's error table (provisional until the SEP is accepted). */
export const EventsErrorCode = {
  InvalidParams: -32602,
  NotFound: -32023,
  Forbidden: -32024,
  ResourceExhausted: -32025,
  Unsupported: -32026,
  CallbackEndpointError: -32027,
  InternalError: -32603,
} as const;

/** The design sketch's `NotFound`, which bridges before 0.5.0 return. */
export const LEGACY_NOT_FOUND = -32011;

/** Categories the SEP allows in `data.reason` and `deliveryStatus.lastError`. */
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
