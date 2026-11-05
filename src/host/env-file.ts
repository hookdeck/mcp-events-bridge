import fs from 'node:fs';
import { writeAtomically } from './sources-add.js';

/**
 * Saves a value `setup` generated (the MCP secret) in the `.env` it read, so nobody has to copy it from the output:
 * an agent running setup would otherwise see the secret and have to write it out itself.
 *
 * - `saved`: the file had no line for the name, or an empty one (`NAME=`), and now has `NAME=value`.
 * - `exists`: the file already sets the name to something; it's left alone.
 * - `no-file`: there's no such file (the environment came from elsewhere); nothing is written.
 */
export function saveGeneratedEnv(file: string, name: string, value: string): 'saved' | 'exists' | 'no-file' {
  if (!fs.existsSync(file)) return 'no-file';
  const existing = fs.readFileSync(file, 'utf8');
  const line = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=)(.*)$`, 'm');
  const match = existing.match(line);
  if (match) {
    if (match[2]!.trim() !== '') return 'exists';
    writeAtomically(file, existing.replace(line, `$1${value}`));
    return 'saved';
  }
  const lead = existing.length && !existing.endsWith('\n') ? '\n' : '';
  writeAtomically(file, `${existing}${lead}${name}=${value}\n`);
  return 'saved';
}
