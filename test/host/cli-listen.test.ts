import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ListenSupervisor } from '../../src/host/cli-listen.js';

/** A stand-in for a `hookdeck listen` process: tests print lines to it and end it. */
class FakeListen extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  constructor(readonly args: string[]) {
    super();
  }
  print(line: string) {
    this.stdout.write(`${line}\n`);
  }
  kill(signal: string) {
    this.signals.push(signal);
    setImmediate(() => this.emit('exit', null));
    return true;
  }
  crash(code = 1) {
    this.emit('exit', code);
  }
}

function setup() {
  const spawned: FakeListen[] = [];
  const logs: string[] = [];
  const supervisor = new ListenSupervisor({
    cliConfigPath: '/tmp/cli.toml',
    spawn: (args) => {
      const child = new FakeListen(args);
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
    readyTimeoutMs: 200,
    backoffMs: { initial: 10, max: 40 },
    log: (m) => logs.push(m),
  });
  return { supervisor, spawned, logs };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const spec = (sources: string[]) => ({ port: 4500, sources, deviceName: 'bridge-dev-agent-laptop' });

describe('ListenSupervisor', () => {
  it('starts listen with the sources, and calls onConnected on every "Connected" (startup and each reconnect)', async () => {
    const { supervisor, spawned } = setup();
    let connected = 0;
    const ready = supervisor.ensure('agent laptop', spec(['agent-laptop-a', 'agent-laptop-b']), () => connected++);
    expect(spawned[0]!.args).toEqual(['listen', '4500', 'agent-laptop-a,agent-laptop-b', '--output', 'compact', '--device-name', 'bridge-dev-agent-laptop', '--hookdeck-config', '/tmp/cli.toml']);
    spawned[0]!.print('Connected. Waiting for events...');
    expect(await ready).toBe(true);
    spawned[0]!.print('Connection lost, reconnecting...');
    await tick();
    expect(supervisor.isConnected('agent laptop')).toBe(false);
    spawned[0]!.print('Connected. Waiting for events...');
    await tick();
    expect(connected).toBe(2);
    expect(supervisor.isConnected('agent laptop')).toBe(true);
  });

  it('starts listen again with backoff when it exits', async () => {
    const { supervisor, spawned, logs } = setup();
    void supervisor.ensure('inbound', spec(['bridge-resend']), () => {});
    spawned[0]!.crash(1);
    await tick(30);
    expect(spawned).toHaveLength(2);
    expect(logs.some((l) => /exited \(1\); restarting/.test(l))).toBe(true);
    await supervisor.stopAll();
  });

  it('restarts listen when its sources change, stopping the old process before starting the new one', async () => {
    const { supervisor, spawned } = setup();
    void supervisor.ensure('agent laptop', spec(['agent-laptop-a']), () => {});
    spawned[0]!.print('Connected');
    await tick();
    const ready = supervisor.ensure('agent laptop', spec(['agent-laptop-a', 'agent-laptop-b']), () => {});
    await tick(5);
    expect(spawned[0]!.signals).toEqual(['SIGINT']);
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.args[2]).toBe('agent-laptop-a,agent-laptop-b');
    spawned[1]!.print('Connected');
    expect(await ready).toBe(true);
    // The same sources again: left running.
    expect(await supervisor.ensure('agent laptop', spec(['agent-laptop-a', 'agent-laptop-b']), () => {})).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it('keeps a suspended process stopped until it is resumed, and stops a removed one for good', async () => {
    const { supervisor, spawned } = setup();
    void supervisor.ensure('agent laptop', spec(['agent-laptop-a']), () => {});
    await supervisor.suspend('agent laptop');
    await tick(60);
    expect(spawned).toHaveLength(1);
    const resumed = supervisor.resume('agent laptop');
    spawned[1]!.print('Connected');
    expect(await resumed).toBe(true);
    await supervisor.remove('agent laptop');
    await tick(60);
    expect(spawned).toHaveLength(2);
    expect(supervisor.keys()).toEqual([]);
  });

  it('reports not ready when listen never connects, and keeps trying', async () => {
    const { supervisor, spawned } = setup();
    expect(await supervisor.ensure('inbound', spec(['bridge-resend']), () => {})).toBe(false);
    spawned[0]!.crash(1);
    await tick(30);
    expect(spawned.length).toBeGreaterThan(1);
    await supervisor.stopAll();
  });
});
