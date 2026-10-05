import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateWebhookSecret, isValidWebhookSecret } from '../../src/core/secret.js';

const secretOf = (bytes: number) => `whsec_${randomBytes(bytes).toString('base64')}`;

describe('webhook secret validation', () => {
  it.each([24, 32, 64])('accepts whsec_ + base64 of %i bytes', (bytes) => {
    expect(isValidWebhookSecret(secretOf(bytes))).toBe(true);
  });

  it.each([
    ['too short (23 bytes)', secretOf(23)],
    ['too long (65 bytes)', secretOf(65)],
    ['missing prefix', randomBytes(32).toString('base64')],
    ['wrong prefix', `whsk_${randomBytes(32).toString('base64')}`],
    ['empty after prefix', 'whsec_'],
    ['not base64', `whsec_${'!'.repeat(44)}`],
    ['base64url alphabet', `whsec_${randomBytes(32).toString('base64url')}-_`],
    ['missing padding', `whsec_${randomBytes(32).toString('base64').replace(/=+$/, '')}`],
    ['not a string', 42],
  ])('rejects %s', (_label, value) => {
    expect(isValidWebhookSecret(value)).toBe(false);
  });

  it('generates valid secrets', () => {
    expect(isValidWebhookSecret(generateWebhookSecret())).toBe(true);
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});
