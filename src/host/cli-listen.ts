import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../core/config.js';
import { listenArgs } from '../core/inbound-plan.js';

/*
 * Runs `hookdeck listen` for a CLI-inbound deployment: one process for every
 * source in the config. The CLI is logged in non-interactively (`hookdeck ci`)
 * into a private config file, so it never acts on whatever project you're
 * logged into interactively.
 *
 * Restart on exit and missed-event recovery come in stage 6.
 */

export const DEFAULT_CLI_CONFIG = '.hookdeck/config.toml';

export class CliListenError extends Error {}

export interface RunningListen {
  child: ChildProcess;
  stop(): void;
}

export function hookdeckCliVersion(): string | undefined {
  const result = spawnSync('hookdeck', ['version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return undefined;
  return /hookdeck version (\S+)/.exec(result.stdout)?.[1] ?? result.stdout.trim();
}

export async function startListen(
  config: ResolvedConfig,
  {
    port,
    cliConfigPath = process.env.BRIDGE_HOOKDECK_CLI_CONFIG ?? DEFAULT_CLI_CONFIG,
    readyTimeoutMs = 30_000,
    log = (message: string) => console.log(`[listen] ${message}`),
    onExit,
  }: { port: number; cliConfigPath?: string; readyTimeoutMs?: number; log?: (message: string) => void; onExit?: (code: number | null) => void },
): Promise<RunningListen> {
  const version = hookdeckCliVersion();
  if (!version) throw new CliListenError('The Hookdeck CLI is not installed (https://hookdeck.com/docs/cli); it forwards events to a local bridge');

  fs.mkdirSync(path.dirname(cliConfigPath), { recursive: true });
  const login = spawnSync('hookdeck', ['ci', '--api-key', config.hookdeck.apiKey, '--hookdeck-config', cliConfigPath], { encoding: 'utf8' });
  if (login.status !== 0) throw new CliListenError(`hookdeck ci failed: ${(login.stderr || login.stdout).trim().slice(0, 300)}`);

  const args = listenArgs(config, port, cliConfigPath);
  const shown = args.filter((arg, i) => arg !== '--hookdeck-config' && args[i - 1] !== '--hookdeck-config');
  log(`hookdeck ${shown.join(' ')} (CLI ${version})`);
  const child = spawn('hookdeck', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  let stopping = false;
  const onData = (chunk: Buffer) => {
    // Only the tail is kept: enough to spot "Connected" and report a failure, without growing for the life of `serve`.
    output = (output + chunk.toString()).slice(-8192);
    for (const line of chunk.toString().split('\n')) {
      // Event lines in compact output, for visibility; the banner is skipped.
      if (/^\s*(\d{4}-|\[|→|←|✓|✗|✖|POST|GET)/.test(line)) log(line.trim());
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CliListenError(`hookdeck listen did not connect within ${readyTimeoutMs / 1000}s:\n${output.slice(-500)}`)), readyTimeoutMs);
    const check = setInterval(() => {
      if (output.includes('Connected')) {
        clearTimeout(timer);
        clearInterval(check);
        resolve();
      }
    }, 200);
    child.once('exit', (code) => {
      clearTimeout(timer);
      clearInterval(check);
      reject(new CliListenError(`hookdeck listen exited (${code}) before connecting:\n${output.slice(-500)}`));
    });
  });

  child.on('exit', (code) => {
    if (!stopping) onExit?.(code);
  });
  return {
    child,
    stop: () => {
      stopping = true;
      child.kill('SIGINT');
    },
  };
}
