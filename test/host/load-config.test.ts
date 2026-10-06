import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/core/config.js';
import { loadConfig } from '../../src/host/load-config.js';

const environment = { HOOKDECK_API_KEY: 'hk', HOOKDECK_SIGNING_SECRET: 'hs' };
const dirs: string[] = [];

function project(type: 'module' | 'commonjs' | undefined, config: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-config-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(type ? { type } : {}));
  fs.writeFileSync(path.join(dir, 'bridge.config.ts'), config);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it.each([['module'], ['commonjs'], [undefined]] as const)('loads a TypeScript config in a %s project', async (type) => {
    const dir = project(type, `const deployment: string = 'typed';\nexport default { deployment, providers: [] };\n`);
    await expect(loadConfig({ cwd: dir, environment })).resolves.toMatchObject({ deployment: 'typed', providers: [] });
  });

  it('says so when the default export is not a bridge config', async () => {
    const dir = project('module', `export default { hello: 'world' };\n`);
    await expect(loadConfig({ cwd: dir, environment })).rejects.toThrow(ConfigError);
  });
});
