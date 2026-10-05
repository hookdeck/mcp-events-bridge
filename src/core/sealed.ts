import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/*
 * Sealed values: AES-256-GCM with BRIDGE_ENCRYPTION_KEY, used to keep
 * subscription state (including secrets) in Event Gateway resource
 * descriptions. The associated data binds a value to where it's stored, so a
 * description copied onto another connection fails to open.
 *
 * Format: "v1." + base64url(iv[12] || ciphertext || tag[16]).
 */

const PREFIX = 'v1.';

export class SealedValueError extends Error {}

/** Decodes BRIDGE_ENCRYPTION_KEY: base64url (or base64) of exactly 32 bytes. */
export function parseEncryptionKey(value: string | undefined): Buffer {
  if (!value) throw new SealedValueError('BRIDGE_ENCRYPTION_KEY is not set');
  const key = Buffer.from(value, 'base64url');
  if (key.length !== 32) throw new SealedValueError('BRIDGE_ENCRYPTION_KEY must be 32 random bytes, base64url-encoded');
  return key;
}

export function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64url');
}

export function seal(key: Buffer, plaintext: string, associatedData: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
}

export function open(key: Buffer, sealed: string, associatedData: string): string {
  if (!sealed.startsWith(PREFIX)) throw new SealedValueError('Not a sealed value');
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
  if (raw.length < 12 + 16) throw new SealedValueError('Sealed value is too short');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    throw new SealedValueError('Sealed value failed to open (wrong key, or edited or moved)');
  }
}
