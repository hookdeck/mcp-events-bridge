import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

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

// Claude's plugin directory wants hook commands that name a path from ${CLAUDE_PLUGIN_ROOT} and no other variable,
// so the session start hook is a script, which copies the plugin's user config for the monitor.
describe('Claude Code plugin session start hook', () => {
  const root = path.resolve('plugins/mcp-events-bridge');
  const script = path.join(root, 'scripts/session-start.sh');
  let data: string;

  beforeEach(() => {
    data = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hook-')), 'data');
  });

  const run = (options: { url?: string; secret?: string }) =>
    execFileSync('sh', ['-c', command()], {
      env: {
        PATH: process.env.PATH,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
        CLAUDE_PLUGIN_OPTION_MCP_URL: options.url ?? '',
        CLAUDE_PLUGIN_OPTION_MCP_SECRET: options.secret ?? '',
      },
    });

  function command(): string {
    const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks/hooks.json'), 'utf8')) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    return hooks.hooks.SessionStart[0].hooks[0].command;
  }

  it('runs a script from the plugin root, with no other variable', () => {
    expect(command()).toBe('"${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh"');
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
  });

  it('writes the endpoint and secret, readable only by the user', () => {
    run({ url: 'https://bridge.example/mcp', secret: 's3cr3t' });
    expect(fs.readFileSync(path.join(data, 'mcp-url'), 'utf8')).toBe('https://bridge.example/mcp');
    expect(fs.readFileSync(path.join(data, 'mcp-secret'), 'utf8')).toBe('s3cr3t');
    expect(fs.statSync(path.join(data, 'mcp-url')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(data, 'mcp-secret')).mode & 0o777).toBe(0o600);
  });

  it('removes the file of an option that is no longer set', () => {
    run({ url: 'https://bridge.example/mcp', secret: 's3cr3t' });
    run({ url: 'https://bridge.example/mcp/legacy' });
    expect(fs.readFileSync(path.join(data, 'mcp-url'), 'utf8')).toBe('https://bridge.example/mcp/legacy');
    expect(fs.existsSync(path.join(data, 'mcp-secret'))).toBe(false);
    run({});
    expect(fs.existsSync(path.join(data, 'mcp-url'))).toBe(false);
  });
});
