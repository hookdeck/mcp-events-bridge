import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// The official MCP Registry checks mcpName in the npm version that server.json names, so a release bumps them together.
describe('MCP Registry server.json', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { name: string; version: string; mcpName: string };
  const server = JSON.parse(fs.readFileSync('server.json', 'utf8')) as {
    name: string;
    version: string;
    packages: { identifier: string; version: string }[];
  };

  it('has the package name in mcpName', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages[0].identifier).toBe(pkg.name);
  });

  it('has the package version', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });
});
