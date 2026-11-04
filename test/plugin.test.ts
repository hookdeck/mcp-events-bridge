import { execFileSync, spawnSync } from 'node:child_process';
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
    expect(fs.readFileSync('plugins/mcp-events-bridge/bin/events-bridge', 'utf8')).toContain(`exec npx -y @hookdeck/mcp-events-bridge@${version} "$@"`);
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

  const run = (options: { url?: string; secret?: string; envFile?: string }) =>
    execFileSync('sh', ['-c', command()], {
      env: {
        PATH: process.env.PATH,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: data,
        CLAUDE_PLUGIN_OPTION_MCP_URL: options.url ?? '',
        CLAUDE_PLUGIN_OPTION_MCP_SECRET: options.secret ?? '',
        ...(options.envFile ? { CLAUDE_ENV_FILE: options.envFile } : {}),
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

  it('tells the monitor where the data directory is, through CLAUDE_ENV_FILE', () => {
    data = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-hook-')), "it's data");
    const envFile = path.join(path.dirname(data), 'env.sh');
    run({ envFile });
    const value = execFileSync('sh', ['-c', `. "$1" && printf '%s' "$MCP_EVENTS_BRIDGE_PLUGIN_DATA"`, 'sh', envFile], { encoding: 'utf8' });
    expect(value).toBe(data);
  });
});

// The directory refuses a monitor command with any variable but ${CLAUDE_PLUGIN_ROOT}, and Claude Code doesn't give a
// monitor CLAUDE_PLUGIN_DATA in its environment, so the monitor's script finds the data directory itself.
describe('Claude Code plugin monitor', () => {
  const source = path.resolve('plugins/mcp-events-bridge');
  let plugins: string;

  beforeEach(() => {
    plugins = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-monitor-'));
  });

  // Installs the plugin's scripts at <plugins>/<at>, with a bin/events-bridge that prints its arguments.
  function install(at: string): string {
    const root = path.join(plugins, at);
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.cpSync(path.join(source, 'scripts'), path.join(root, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin/events-bridge'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    return root;
  }

  const run = (root: string, env: Record<string, string> = {}) => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-project-'));
    const result = spawnSync(path.join(root, 'scripts/monitor.sh'), [], { cwd: project, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
    return { ...result, project: fs.realpathSync(project) };
  };

  it('runs a script from the plugin root, with no other variable', () => {
    const monitors = JSON.parse(fs.readFileSync(path.join(source, 'monitors/monitors.json'), 'utf8')) as { command: string }[];
    expect(monitors.map((m) => m.command)).toEqual(['"${CLAUDE_PLUGIN_ROOT}/scripts/monitor.sh"']);
    expect(fs.statSync(path.join(source, 'scripts/monitor.sh')).mode & 0o111).not.toBe(0);
  });

  it('uses the data directory the session start hook passed on', () => {
    const { stdout, status, project } = run(install('cache/hookdeck/mcp-events-bridge/0.8.1'), { MCP_EVENTS_BRIDGE_PLUGIN_DATA: '/from/the hook' });
    expect(status).toBe(0);
    expect(stdout.split('\n')).toEqual(['watch', '--store', '/from/the hook', '--project', project, '']);
  });

  it('otherwise works the data directory out from where the plugin is installed', () => {
    const { stdout, project } = run(install('cache/claude-plugins-official/mcp-events-bridge/0.8.1'));
    const real = fs.realpathSync(plugins);
    expect(stdout.split('\n')).toEqual(['watch', '--store', `${real}/data/mcp-events-bridge-claude-plugins-official`, '--project', project, '']);
  });

  it('reports a problem when it can find neither', () => {
    const { stdout, status } = run(install('somewhere/else'));
    expect(status).toBe(1);
    expect(JSON.parse(stdout)).toHaveProperty('problem');
  });
});
