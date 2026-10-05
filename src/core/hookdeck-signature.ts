import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * Verifies the signature Event Gateway puts on deliveries to the bridge
 * (destination auth "Hookdeck Signature"): base64 HMAC-SHA256 of the raw body
 * with the project's signing secret, in x-hookdeck-signature, and in
 * x-hookdeck-signature-2 while the secret is being rotated.
 */
export function verifyHookdeckSignature(rawBody: string, headers: Record<string, string | undefined>, signingSecret: string): boolean {
  const expected = createHmac('sha256', signingSecret).update(rawBody, 'utf8').digest();
  return ['x-hookdeck-signature', 'x-hookdeck-signature-2'].some((name) => {
    const value = headers[name];
    if (!value) return false;
    const actual = Buffer.from(value, 'base64');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
