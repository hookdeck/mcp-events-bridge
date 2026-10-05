import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * core/ stays runtime-agnostic (see "Module layout" in docs/ARCHITECTURE.md):
 * no node: imports except node:crypto.
 */
const coreDir = path.join(import.meta.dirname, '..', '..', 'src', 'core');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('core/ boundary', () => {
  it.each(files(coreDir).map((file) => [path.relative(coreDir, file), file]))('%s imports no node: modules except node:crypto', (_name, file) => {
    const source = fs.readFileSync(file, 'utf8');
    const nodeImports = [...source.matchAll(/from\s+['"](node:[^'"]+)['"]/g)].map((m) => m[1]);
    expect(nodeImports.filter((m) => m !== 'node:crypto')).toEqual([]);
  });
});
