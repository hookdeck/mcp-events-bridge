import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentListen, RetryReport } from '../../src/core/callbacks.js';
import { defineConfig, resolveConfig } from '../../src/core/config.js';
import { ListenSupervisor } from '../../src/host/cli-listen.js';
import { startLocalRuntime, type LocalRuntime } from '../../src/host/local-runtime.js';
import type { BridgeServer } from '../../src/host/server.js';
import { resend } from '../../src/providers.js';

class FakeListen extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  constructor(readonly args: string[]) {
    super();
  }
  connect() {
    this.stdout.write('Connected. Waiting for events...\n');
  }
  kill() {
    setImmediate(() => this.emit('exit', null));
    return true;
  }
}

const config = resolveConfig(defineConfig({ deployment: 'dev', providers: [resend({ apiKey: 'x' })] }), { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 'hs' });
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const running: LocalRuntime[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});

function setup({ reports = [] as Array<Partial<RetryReport>> } = {}) {
  const spawned: FakeListen[] = [];
  const supervisor = new ListenSupervisor({
    cliConfigPath: '/tmp/cli.toml',
    spawn: (args) => {
      const child = new FakeListen(args);
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
    readyTimeoutMs: 500,
    log: () => {},
  });
  let plan: AgentListen[] = [];
  const listeners: Array<() => void> = [];
  const retries: string[] = [];
  const hookdeckCalls: string[] = [];
  const bridge = {
    callbacks: {
      listenPlan: () => plan,
      agents: () => [...new Set(plan.map((p) => p.agent))],
      onChange: (listener: () => void) => (listeners.push(listener), () => {}),
      retryMissed: async (agent: string) => {
        retries.push(agent);
        return { upToDate: true, resent: 0, ...reports.shift() } as RetryReport;
      },
    },
    hookdeck: { listAllConnections: async () => (hookdeckCalls.push('listAllConnections'), []) },
  } as unknown as BridgeServer;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-'));
  const start = (options: { inbound: boolean; agents: boolean; retryEveryMs?: number }) => {
    const runtime = startLocalRuntime(bridge, config, 8080, {
      cliConfigPath: path.join(stateDir, 'config.toml'),
      supervisor,
      followUpMs: 10,
      log: () => {},
      ...options,
    });
    running.push(runtime);
    return runtime;
  };
  return { start, spawned, retries, hookdeckCalls, setPlan: (p: AgentListen[]) => ((plan = p), listeners.forEach((l) => l())) };
}

describe('startLocalRuntime', () => {
  it("runs listen for the bridge's inbound sources, and recovers missed provider events when it connects", async () => {
    const { start, spawned, hookdeckCalls } = setup();
    const runtime = start({ inbound: true, agents: false });
    expect(spawned[0]!.args.slice(0, 3)).toEqual(['listen', '8080', 'bridge-resend,bridge-hookdeck-notifications']);
    expect(spawned[0]!.args).toContain('bridge-dev');
    spawned[0]!.connect();
    expect(await runtime.inboundReady).toBe(true);
    await tick(5);
    expect(hookdeckCalls).toContain('listAllConnections'); // the recovery run
  });

  it("runs listen for each agent's tunnel URLs, and retries the agent's missed deliveries when it connects, until up to date", async () => {
    const { start, spawned, retries, setPlan } = setup({ reports: [{ upToDate: false, resent: 1 }] });
    const runtime = start({ inbound: false, agents: true });
    setPlan([{ agent: 'laptop', port: 4500, sources: ['agent-laptop-a'] }]);
    await runtime.syncAgents();
    expect(runtime.agentKeys('laptop')).toEqual(['agent laptop']);
    const child = spawned.find((c) => c.args[2] === 'agent-laptop-a')!;
    expect(child.args.slice(0, 2)).toEqual(['listen', '4500']);
    expect(child.args).toContain('bridge-dev-agent-laptop');
    child.connect();
    await tick(40);
    expect(retries).toEqual(['laptop', 'laptop']); // once on connect, once more because it re-sent something
  });

  it("doesn't retry while the agent's listen isn't connected (a re-send would only be ignored again)", async () => {
    const { start, spawned, retries, setPlan } = setup();
    const runtime = start({ inbound: false, agents: true, retryEveryMs: 10 });
    setPlan([{ agent: 'laptop', port: 4500, sources: ['agent-laptop-a'] }]);
    const synced = runtime.syncAgents();
    await tick(50); // the timer fires, but listen hasn't connected
    expect(retries).toEqual([]);
    spawned.at(-1)!.connect();
    await synced;
    await tick(5);
    expect(retries.length).toBeGreaterThanOrEqual(1);
  });

  it('restarts the agent listen to cover a new URL, and stops it when the URLs are gone', async () => {
    const { start, spawned, setPlan } = setup();
    const runtime = start({ inbound: false, agents: true });
    setPlan([{ agent: 'laptop', port: 4500, sources: ['agent-laptop-a'] }]);
    const first = runtime.syncAgents();
    spawned.at(-1)!.connect();
    await first;
    setPlan([{ agent: 'laptop', port: 4500, sources: ['agent-laptop-a', 'agent-laptop-b'] }]);
    const second = runtime.syncAgents();
    await tick(5);
    spawned.at(-1)!.connect();
    await second;
    expect(spawned.map((c) => c.args[2])).toEqual(['agent-laptop-a', 'agent-laptop-a,agent-laptop-b']);
    setPlan([]);
    await runtime.syncAgents();
    expect(runtime.agentKeys('laptop')).toEqual([]);
  });
});
