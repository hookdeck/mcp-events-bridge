import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/*
 * A throwaway whsec_ secret shared by the stage 3 and 4 publisher and
 * receiver, kept in .hookdeck/ (gitignored). Created on first use.
 */
const file = path.join(import.meta.dirname, '..', '.hookdeck', 'spike-subscriber.secret');

export function readSpikeSecret(): string {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `whsec_${crypto.randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}
