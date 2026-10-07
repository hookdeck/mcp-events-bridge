import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from '../core/config.js';
import { inboundConnections } from '../core/inbound-plan.js';
import { InboundRecovery, type RecoveryState } from '../core/inbound-recovery.js';
import { ListenSupervisor } from './cli-listen.js';
import type { BridgeServer } from './server.js';

/*
 * What a bridge on a laptop runs besides its HTTP listener:
 *
 * - inbound: `hookdeck listen` for its provider and notification sources, and
 *   recovery of provider events that arrived while it was down (after every
 *   (re)connect, and on a timer);
 * - local agents: one `hookdeck listen` per agent port covering the agent's
 *   tunnel URLs, restarted when URLs are created or deleted, and a retry of
 *   deliveries the agent missed after every (re)connect and on a timer.
 *
 * The timer covers reconnects the CLI makes inside a running process without
 * the bridge noticing. A run that isn't up to date (something in flight, or
 * just retried) runs again shortly, a bounded number of times.
 */

export interface LocalRuntimeOptions {
  cliConfigPath: string;
  /** Run `listen` and recovery for the bridge's own inbound (CLI inbound). */
  inbound: boolean;
  /** Run `listen` and retries for local agents' tunnel URLs. */
  agents: boolean;
  /** The backstop timer. Default 5 minutes. */
  retryEveryMs?: number;
  /** How soon a run that wasn't up to date runs again. Default 20 seconds. */
  followUpMs?: number;
  /** Where the inbound recovery watermark is kept. Default: next to the CLI config. */
  recoveryStateFile?: string;
  supervisor?: ListenSupervisor;
  log?: (message: string) => void;
}

export interface LocalRuntime {
  supervisor: ListenSupervisor;
  /** The supervisor key of the inbound `listen`. */
  readonly inboundKey: string;
  /** Resolves once the inbound `listen` first connects (true), or not within the timeout (false). */
  inboundReady: Promise<boolean>;
  /** Supervisor keys of an agent's `listen` processes. */
  agentKeys(agent: string): string[];
  /** Brings the agent `listen` processes in line with the tunnel URLs now (normally debounced). */
  syncAgents(): Promise<void>;
  stop(): Promise<void>;
}

const MAX_FOLLOW_UPS = 10;

export function startLocalRuntime(bridge: BridgeServer, config: ResolvedConfig, port: number, options: LocalRuntimeOptions): LocalRuntime {
  const log = options.log ?? ((message: string) => console.log(`[bridge] ${message}`));
  const supervisor = options.supervisor ?? new ListenSupervisor({ cliConfigPath: options.cliConfigPath, log: (m) => console.log(`[listen] ${m}`) });
  const followUpMs = options.followUpMs ?? 20_000;
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  /** Runs a job now (or after the running one), then again shortly while it reports not up to date. */
  const jobs = new Map<string, { running: boolean; again: boolean; followUps: number }>();
  const schedule = (key: string, job: () => Promise<boolean>) => {
    const state = jobs.get(key) ?? { running: false, again: false, followUps: 0 };
    jobs.set(key, state);
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    void job()
      .then(
        (upToDate) => {
          if (upToDate) state.followUps = 0;
          else if (state.followUps < MAX_FOLLOW_UPS) {
            state.followUps++;
            later(() => schedule(key, job), followUpMs);
          }
        },
        (error: Error) => log(`${key}: ${error.message}`),
      )
      .finally(() => {
        state.running = false;
        if (state.again && !stopped) {
          state.again = false;
          schedule(key, job);
        }
      });
  };
  const later = (fn: () => void, ms: number) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) fn();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  };

  // --- inbound ---
  const inboundKey = 'inbound';
  let inboundReady: Promise<boolean> = Promise.resolve(true);
  let recover: (() => void) | undefined;
  if (options.inbound) {
    const targets = inboundConnections(config).map((c) => ({ source: c.source, connection: c.connection }));
    const recovery = new InboundRecovery({
      hookdeck: bridge.hookdeck,
      targets,
      state: fileState(options.recoveryStateFile ?? path.join(path.dirname(options.cliConfigPath), 'inbound-recovery.json')),
      onRetried: (id) => bridge.recoveredRequests.add(id),
      log,
    });
    // Only while connected: a retry while `listen` is down is only ignored again. The next "Connected" runs it.
    recover = () => {
      if (supervisor.isConnected(inboundKey)) schedule('inbound recovery', async () => !supervisor.isConnected(inboundKey) || (await recovery.run()).upToDate);
    };
    const sources = [...new Set(targets.map((t) => t.source))];
    inboundReady = supervisor.ensure(inboundKey, { port, sources, deviceName: `bridge-${config.deployment}` }, recover);
  }

  // --- local agents ---
  const agentConnected = (agent: string) => {
    const keys = agentKeysNow.get(agent) ?? [];
    return keys.length > 0 && keys.every((k) => supervisor.isConnected(k));
  };
  // Only while the agent's `listen` is connected: a re-send while it's down is only ignored again. The next "Connected"
  // (after a restart for a new URL, or a reconnect) runs it.
  const retry = (agent: string) => {
    if (!agentConnected(agent)) return;
    schedule(`retry ${agent}`, async () => {
      if (!agentConnected(agent)) return true;
      const report = await bridge.callbacks.retryMissed(agent);
      if (report.resent) log(`re-sent ${report.resent} delivery(ies) agent ${agent} missed`);
      return report.upToDate;
    });
  };
  const agentKey = (agent: string, i: number) => `agent ${agent}${i ? ` ${i + 1}` : ''}`;
  let agentKeysNow = new Map<string, string[]>();
  const syncAgents = async () => {
    if (!options.agents || stopped) return;
    const next = new Map<string, string[]>();
    const counts = new Map<string, number>();
    const work: Array<Promise<boolean>> = [];
    for (const entry of bridge.callbacks.listenPlan()) {
      const i = counts.get(entry.agent) ?? 0;
      counts.set(entry.agent, i + 1);
      const key = agentKey(entry.agent, i);
      next.set(entry.agent, [...(next.get(entry.agent) ?? []), key]);
      const deviceName = `bridge-${config.deployment}-agent-${entry.agent}${i ? `-${i + 1}` : ''}`;
      work.push(supervisor.ensure(key, { port: entry.port, sources: entry.sources, deviceName }, () => retry(entry.agent)));
    }
    // Recorded before anything is awaited, so a "Connected" from a new process finds its key.
    const previous = [...agentKeysNow.values()].flat();
    agentKeysNow = next;
    const keep = new Set([...next.values()].flat());
    for (const key of previous) if (!keep.has(key)) await supervisor.remove(key);
    await Promise.all(work);
  };
  let syncTimer: NodeJS.Timeout | undefined;
  const unsubscribe = options.agents
    ? bridge.callbacks.onChange(() => {
        // Debounced: an agent creating several URLs in a row restarts `listen` once.
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => void syncAgents().catch((error: Error) => log(`local agents: ${error.message}`)), 1000);
        syncTimer.unref?.();
      })
    : () => {};
  if (options.agents) void syncAgents().catch((error: Error) => log(`local agents: ${error.message}`));

  // --- the backstop timer ---
  const every = setInterval(() => {
    recover?.();
    if (options.agents) for (const agent of bridge.callbacks.agents()) retry(agent);
  }, options.retryEveryMs ?? 5 * 60 * 1000);
  every.unref?.();

  return {
    supervisor,
    inboundKey,
    inboundReady,
    agentKeys: (agent) => agentKeysNow.get(agent) ?? [],
    syncAgents,
    stop: async () => {
      stopped = true;
      clearInterval(every);
      clearTimeout(syncTimer);
      for (const timer of timers) clearTimeout(timer);
      unsubscribe();
      await supervisor.stopAll();
    },
  };
}

function fileState(file: string): RecoveryState {
  return {
    load: () => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { watermarks?: Record<string, string> }).watermarks ?? {} : {}),
    save: (watermarks) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ watermarks }, null, 2)}\n`);
    },
  };
}
