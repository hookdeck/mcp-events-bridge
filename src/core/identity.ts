import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The subscription key is (principal, delivery.url, name, arguments), with
 * arguments compared as canonical JSON. The id is a truncated SHA-256 of that
 * key, so it is deterministic, stable across refreshes and restarts, and
 * reveals nothing on its own. It is a routing handle, never an input.
 */
export function deriveSubscriptionId(principal: string, url: string, name: string, args: Record<string, unknown>): string {
  return `sub_${sha256(canonicalJson({ principal, url, name, arguments: args })).slice(0, 32)}`;
}

/** Verification is cached per (principal, url), independent of event name and arguments. */
export function verificationKey(principal: string, url: string): string {
  return canonicalJson([principal, url]);
}

export function hashSecret(secret: string): string {
  return sha256(secret);
}
