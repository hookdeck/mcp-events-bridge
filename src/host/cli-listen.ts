import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Runs and supervises `hookdeck listen` processes for a bridge on a laptop:
 * one for the bridge's own inbound sources, and one per local agent port (see
 * local-agents.ts). The CLI is logged in non-interactively (`hookdeck ci`)
 * into a private config file, so it never acts on whatever project you're
 * logged into interactively.
 *
 * A process that exits is started again with backoff. Each "Connected" the
 * CLI prints (at startup and after every websocket reconnect) calls the
 * process's onConnected, which is where missed deliveries are recovered.
 * Changing a process's sources restarts it, since a running `listen` only
 * covers the connections it resolved at startup (hookdeck-cli#467); the old
 * process exits before the new one starts, so no two sessions overlap.
 */

export const DEFAULT_CLI_CONFIG = '.hookdeck/config.toml';

export class CliListenError extends Error {}

export function hookdeckCliVersion(): string | undefined {
  const result = spawnSync('hookdeck', ['version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return undefined;
  return /hookdeck version (\S+)/.exec(result.stdout)?.[1] ?? result.stdout.trim();
}

/** Logs the CLI into a private config with the project API key. Throws CliListenError if the CLI is missing or login fails. */
export function loginCli(apiKey: string, cliConfigPath: string): string {
  const version = hookdeckCliVersion();
  if (!version) throw new CliListenError('The Hookdeck CLI is not installed (https://hookdeck.com/docs/cli); it forwards events to a local bridge');
  fs.mkdirSync(path.dirname(cliConfigPath), { recursive: true });
  const login = spawnSync('hookdeck', ['ci', '--api-key', apiKey, '--hookdeck-config', cliConfigPath], { encoding: 'utf8' });
  if (login.status !== 0) throw new CliListenError(`hookdeck ci failed: ${(login.stderr || login.stdout).trim().slice(0, 300)}`);
  return version;
}

export interface ListenSpec {
  port: number;
  sources: string[];
  deviceName: string;
}

export type SpawnListen = (args: string[]) => ChildProcess;

interface Managed {
  spec: ListenSpec;
  onConnected: () => void;
  child?: ChildProcess;
  exited?: Promise<void>;
  connected: boolean;
  suspended: boolean;
  attempt: number;
  startedAt?: number;
  restartTimer?: NodeJS.Timeout;
  waiters: Array<() => void>;
}

const sameSpec = (a: ListenSpec, b: ListenSpec) => a.port === b.port && a.deviceName === b.deviceName && a.sources.join(',') === b.sources.join(',');

export class ListenSupervisor {
  private readonly managed = new Map<string, Managed>();
  private stopped = false;
  private readonly spawnListen: SpawnListen;
  private readonly log: (message: string) => void;

  constructor(
    private readonly options: {
      cliConfigPath: string;
      log?: (message: string) => void;
      spawn?: SpawnListen;
      readyTimeoutMs?: number;
      backoffMs?: { initial: number; max: number };
    },
  ) {
    this.spawnListen = options.spawn ?? ((args) => spawn('hookdeck', args, { stdio: ['ignore', 'pipe', 'pipe'] }));
    this.log = options.log ?? ((message) => console.log(`[listen] ${message}`));
  }

  /**
   * Runs a process for `key` with this spec: starts it, restarts it if the spec changed, or leaves it running.
   * Resolves true once it's connected, false if it isn't within the ready timeout (it keeps retrying either way).
   */
  async ensure(key: string, spec: ListenSpec, onConnected: () => void): Promise<boolean> {
    const existing = this.managed.get(key);
    if (existing) {
      existing.onConnected = onConnected;
      if (sameSpec(existing.spec, spec)) return existing.connected || this.waitConnected(existing);
      existing.spec = spec;
      await this.stopChild(existing);
      if (!existing.suspended) this.start(key, existing);
      return this.waitConnected(existing);
    }
    const entry: Managed = { spec, onConnected, connected: false, suspended: false, attempt: 0, waiters: [] };
    this.managed.set(key, entry);
    this.start(key, entry);
    return this.waitConnected(entry);
  }

  /** Stops and forgets a process. */
  async remove(key: string): Promise<void> {
    const entry = this.managed.get(key);
    if (!entry) return;
    this.managed.delete(key);
    await this.stopChild(entry);
  }

  /** Stops a process until resume(), as if the CLI were offline. */
  async suspend(key: string): Promise<void> {
    const entry = this.managed.get(key);
    if (!entry) return;
    entry.suspended = true;
    await this.stopChild(entry);
  }

  async resume(key: string): Promise<boolean> {
    const entry = this.managed.get(key);
    if (!entry) return false;
    entry.suspended = false;
    if (!entry.child) this.start(key, entry);
    return this.waitConnected(entry);
  }

  keys(): string[] {
    return [...this.managed.keys()];
  }

  isConnected(key: string): boolean {
    return this.managed.get(key)?.connected ?? false;
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    const entries = [...this.managed.values()];
    this.managed.clear();
    await Promise.all(entries.map((e) => this.stopChild(e)));
  }

  private start(key: string, entry: Managed) {
    if (this.stopped) return;
    clearTimeout(entry.restartTimer);
    const { port, sources, deviceName } = entry.spec;
    const args = ['listen', String(port), sources.join(','), '--output', 'compact', '--device-name', deviceName, '--hookdeck-config', this.options.cliConfigPath];
    this.log(`${key}: hookdeck listen ${port} ${sources.join(',')}`);
    const child = this.spawnListen(args);
    entry.child = child;
    entry.startedAt = Date.now();
    entry.connected = false;
    entry.exited = new Promise((resolve) => {
      let done = false;
      const finish = (reason: string) => {
        if (done) return;
        done = true;
        if (entry.child === child) {
          entry.child = undefined;
          entry.connected = false;
          if (this.managed.get(key) === entry && !entry.suspended && !this.stopped) this.scheduleRestart(key, entry, reason);
        }
        resolve();
      };
      child.once('exit', (code) => finish(`exited (${code})`));
      child.once('error', (error) => finish(`failed to start: ${error.message}`));
    });

    let pending = '';
    const onData = (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.includes('Connected')) {
          entry.connected = true;
          entry.attempt = 0;
          this.log(`${key}: connected${entry.startedAt ? ` (${((Date.now() - entry.startedAt) / 1000).toFixed(1)}s after starting)` : ''}`);
          entry.startedAt = undefined;
          for (const resolve of entry.waiters.splice(0)) resolve();
          try {
            entry.onConnected();
          } catch (error) {
            this.log(`${key}: ${(error as Error).message}`);
          }
        } else if (line.includes('Connection lost')) {
          entry.connected = false;
          this.log(`${key}: connection lost, the CLI is reconnecting`);
        } else if (/^(\d{4}-|\[|→|←|✓|✗|✖|POST|GET|ERROR)/.test(line)) {
          this.log(`${key}: ${line}`);
        }
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  }

  private scheduleRestart(key: string, entry: Managed, reason: string) {
    const { initial, max } = this.options.backoffMs ?? { initial: 2000, max: 60_000 };
    const delay = Math.min(initial * 2 ** entry.attempt, max);
    entry.attempt++;
    this.log(`${key}: hookdeck listen ${reason}; restarting in ${Math.round(delay / 1000)}s`);
    entry.restartTimer = setTimeout(() => {
      if (this.managed.get(key) === entry && !entry.suspended && !entry.child) this.start(key, entry);
    }, delay);
    entry.restartTimer.unref?.();
  }

  private async stopChild(entry: Managed) {
    clearTimeout(entry.restartTimer);
    const child = entry.child;
    if (!child) return;
    entry.child = undefined;
    entry.connected = false;
    const stopping = Date.now();
    child.kill('SIGINT');
    const killed = setTimeout(() => {
      this.log(`hookdeck listen didn't exit within 5s of SIGINT; killing it`);
      child.kill('SIGKILL');
    }, 5000);
    await entry.exited;
    clearTimeout(killed);
    if (Date.now() - stopping > 1000) this.log(`hookdeck listen took ${((Date.now() - stopping) / 1000).toFixed(1)}s to exit`);
  }

  private waitConnected(entry: Managed): Promise<boolean> {
    if (entry.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.waiters.splice(entry.waiters.indexOf(onConnect) >>> 0, 1);
        resolve(false);
      }, this.options.readyTimeoutMs ?? 30_000);
      timer.unref?.();
      const onConnect = () => {
        clearTimeout(timer);
        resolve(true);
      };
      entry.waiters.push(onConnect);
    });
  }
}
