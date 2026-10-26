import { randomBytes } from 'node:crypto';
import { Webhook } from 'standardwebhooks';

export interface SignedHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

/**
 * A new `webhook-id` for one delivered message: one event on one subscription.
 * SEP-3415 has the server generate it (high-entropy, letters, digits, `_` and
 * `-` only) and not derive it from `eventId`, which is the upstream's and is
 * shared by every subscription the event matches. Retries of the message keep it.
 */
export const newMessageId = () => `msg_${randomBytes(16).toString('base64url')}`;

/**
 * Builds Standard Webhooks headers for a body. With more than one secret the
 * signature header carries one `v1,<sig>` entry per secret, space-separated,
 * which is how secret rotation works (receivers accept any matching entry).
 */
export function signStandardWebhook(
  secrets: string[],
  msgId: string,
  body: string,
  timestamp: Date = new Date(),
): SignedHeaders {
  if (secrets.length === 0) throw new Error('At least one secret is required');
  const signatures = secrets.map((secret) => new Webhook(secret).sign(msgId, timestamp, body));
  return {
    'webhook-id': msgId,
    'webhook-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
    'webhook-signature': signatures.join(' '),
  };
}

/**
 * For debugging rotation: splits `webhook-signature` into its entries and
 * reports which of `secrets` produced each one (its index, or -1 for none).
 * Unlike a verifier, this shows every entry, so a dual-signed delivery can be
 * told apart from one signed with only the new secret. No timestamp check.
 */
export function matchSignatures(
  secrets: string[],
  headers: SignedHeaders,
  body: string,
): Array<{ entry: string; secretIndex: number }> {
  const timestamp = new Date(Number(headers['webhook-timestamp']) * 1000);
  const expected = secrets.map((secret) => new Webhook(secret).sign(headers['webhook-id'], timestamp, body));
  return headers['webhook-signature']
    .split(' ')
    .filter(Boolean)
    .map((entry) => ({ entry, secretIndex: expected.indexOf(entry) }));
}
