import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// The Claude Code plugin runs the published CLI at a pinned version, so a release bumps all three together.
describe('Claude Code plugin', () => {
  const version = (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }).version;

  it('has the package version in its manifest', () => {
    const manifest = JSON.parse(fs.readFileSync('plugins/mcp-events-bridge/.claude-plugin/plugin.json', 'utf8')) as { version: string };
    expect(manifest.version).toBe(version);
  });

  it('runs the package version of the CLI', () => {
    expect(fs.readFileSync('plugins/mcp-events-bridge/bin/events-bridge', 'utf8')).toContain(`@hookdeck/mcp-events-bridge@${version}}`);
  });
});
