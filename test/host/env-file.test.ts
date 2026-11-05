import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveGeneratedEnv } from '../../src/host/env-file.js';

describe('saveGeneratedEnv', () => {
  const dirs: string[] = [];
  const envFile = (content?: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-file-'));
    dirs.push(dir);
    const file = path.join(dir, '.env');
    if (content !== undefined) fs.writeFileSync(file, content);
    return file;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('appends the line when the file has none, keeping what was there', () => {
    const file = envFile('HOOKDECK_API_KEY=k\nHOOKDECK_SIGNING_SECRET=s');
    expect(saveGeneratedEnv(file, 'BRIDGE_MCP_SECRET', 'abc')).toBe('saved');
    expect(fs.readFileSync(file, 'utf8')).toBe('HOOKDECK_API_KEY=k\nHOOKDECK_SIGNING_SECRET=s\nBRIDGE_MCP_SECRET=abc\n');
  });

  it('fills in an empty line in place', () => {
    const file = envFile('HOOKDECK_API_KEY=k\nBRIDGE_MCP_SECRET=\nGITHUB_TOKEN=t\n');
    expect(saveGeneratedEnv(file, 'BRIDGE_MCP_SECRET', 'abc')).toBe('saved');
    expect(fs.readFileSync(file, 'utf8')).toBe('HOOKDECK_API_KEY=k\nBRIDGE_MCP_SECRET=abc\nGITHUB_TOKEN=t\n');
  });

  it('leaves a file that already sets the name alone', () => {
    const file = envFile('export BRIDGE_MCP_SECRET=existing\n');
    expect(saveGeneratedEnv(file, 'BRIDGE_MCP_SECRET', 'abc')).toBe('exists');
    expect(fs.readFileSync(file, 'utf8')).toBe('export BRIDGE_MCP_SECRET=existing\n');
  });

  it("writes nothing when there's no file", () => {
    const file = envFile();
    expect(saveGeneratedEnv(file, 'BRIDGE_MCP_SECRET', 'abc')).toBe('no-file');
    expect(fs.existsSync(file)).toBe(false);
  });
});
