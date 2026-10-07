import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CallbackFailureReason } from './errors.js';
import { signStandardWebhook } from './sign.js';

/*
 * Callback URLs and endpoint verification.
 *
 * Event Gateway makes the deliveries; the bridge makes one kind of outbound
 * request itself: the verification challenge sent before a subscription is
 * activated. The network side (DNS resolution, blocking non-public addresses
 * at connect time, never following redirects) needs a long-lived Node host,
 * so it sits behind CallbackTransport, implemented in host/callback-transport.ts.
 */

/** A callback URL that is statically invalid or points at a blocked address. Maps to InvalidParams. */
export class CallbackUrlError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
  }
}

/** MCP Events requires https callbacks; anything else is rejected with InvalidParams. */
export function parseCallbackUrl(raw: unknown): URL {
  if (typeof raw !== 'string') throw new CallbackUrlError('delivery.url must be a string', 'invalid_url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CallbackUrlError('delivery.url is not a valid URL', 'invalid_url');
  }
  if (url.protocol !== 'https:') throw new CallbackUrlError('delivery.url must use https', 'https_required');
  if (url.username || url.password) {
    throw new CallbackUrlError('delivery.url must not contain credentials', 'invalid_url');
  }
  return url;
}

export interface PostResult {
  status: number;
  body: string;
}

export interface CallbackTransport {
  /** Subscribe-time check. Rejects with CallbackUrlError unless every address the host resolves to is public. */
  assertPublicHost(url: URL): Promise<void>;
  /**
   * POSTs a body with the SSRF rules applied at connect time, never following
   * redirects. Rejects with a network error that classifyNetworkError understands.
   */
  post(url: URL, body: string, headers: Record<string, string>, options: { timeoutMs: number }): Promise<PostResult>;
}

/** Maps a network error to one of the categories MCP Events allows. Never leaks endpoint details. */
export function classifyNetworkError(error: unknown): CallbackFailureReason {
  const code = String((error as { code?: string })?.code ?? '');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return 'tls_error';
  }
  return 'connection_refused';
}

export type VerificationResult = { ok: true } | { ok: false; reason: CallbackFailureReason };

export interface VerifyEndpointOptions {
  url: URL;
  secret: string;
  /** More secrets to sign the challenge with, e.g. a bridge callback source's own (see callbacks.ts). */
  extraSecrets?: string[];
  subscriptionId: string;
  timeoutMs: number;
}

/**
 * Endpoint verification (anti-flooding): POST a signed `verification` control
 * envelope with a single-use challenge. The endpoint proves it wants the
 * deliveries by answering 2xx with `{"challenge": "<same value>"}`.
 */
export async function verifyEndpoint(transport: CallbackTransport, options: VerifyEndpointOptions): Promise<VerificationResult> {
  const challenge = randomBytes(24).toString('base64url');
  const msgId = `msg_verification_${randomBytes(12).toString('hex')}`;
  const body = JSON.stringify({ type: 'verification', challenge });
  const headers = {
    'content-type': 'application/json',
    ...signStandardWebhook([options.secret, ...(options.extraSecrets ?? [])], msgId, body),
    'X-MCP-Subscription-Id': options.subscriptionId,
  };

  let result: PostResult;
  try {
    result = await transport.post(options.url, body, headers, { timeoutMs: options.timeoutMs });
  } catch (error) {
    return { ok: false, reason: classifyNetworkError(error) };
  }

  if (result.status >= 500) return { ok: false, reason: 'http_5xx' };
  if (result.status >= 400) return { ok: false, reason: 'http_4xx' };
  if (result.status < 200 || result.status >= 300) return { ok: false, reason: 'challenge_failed' };

  let echoed: unknown;
  try {
    echoed = (JSON.parse(result.body) as { challenge?: unknown })?.challenge;
  } catch {
    return { ok: false, reason: 'challenge_failed' };
  }
  if (typeof echoed !== 'string') return { ok: false, reason: 'challenge_failed' };
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(echoed);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'challenge_failed' };
  }
  return { ok: true };
}
