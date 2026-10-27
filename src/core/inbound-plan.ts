import type { ResolvedConfig } from './config.js';
import type { HookdeckClient } from './hookdeck.js';
import { notificationsConnectionName, providerSourceName } from './names.js';
import { NOTIFICATIONS_SOURCE } from './setup.js';

/*
 * What a deployment's inbound side looks like in Event Gateway: the notifications connection, the only thing Event
 * Gateway sends the bridge itself (events go from each source straight to subscribers). Used to check a deployment
 * before it serves (and, with CLI inbound, before `hookdeck listen` starts, so it never falls back to creating default
 * connections), and to build that listen command.
 */

export interface InboundConnection {
  source: string;
  connection: string;
  path: string;
}

export function inboundConnections(config: ResolvedConfig): InboundConnection[] {
  return [
    { source: NOTIFICATIONS_SOURCE, connection: notificationsConnectionName(config.deployment), path: '/inbound/hookdeck' },
  ];
}

/** Problems that would make `hookdeck listen` misroute or create default connections. Empty when ready. */
export async function checkInbound(config: ResolvedConfig, hookdeck: HookdeckClient): Promise<string[]> {
  const problems: string[] = [];
  // Each source must exist: subscriptions are connections on it.
  for (const source of config.sources) {
    const name = providerSourceName(source.id);
    if (!(await hookdeck.listSources({ name })).models.some((s) => s.name === name)) problems.push(`source ${name} not found`);
  }
  const connections = await hookdeck.listAllConnections();
  for (const expected of inboundConnections(config)) {
    const found = connections.find((c) => c.name === expected.connection);
    if (!found) {
      problems.push(`connection ${expected.connection} not found`);
      continue;
    }
    if (found.source.name !== expected.source) problems.push(`${expected.connection} is on source ${found.source.name}, expected ${expected.source}`);
    if (config.inbound === 'cli') {
      if (found.destination.type !== 'CLI') problems.push(`${expected.connection} has a ${found.destination.type} destination, expected CLI`);
      else if (found.destination.config?.path !== expected.path) {
        problems.push(`${expected.connection} forwards to ${found.destination.config?.path}, expected ${expected.path}`);
      }
    }
  }
  return problems;
}

/** The single `hookdeck listen` invocation for every CLI-inbound source in the config. */
export function listenArgs(config: ResolvedConfig, port: number, cliConfigPath: string): string[] {
  const sources = [...new Set(inboundConnections(config).map((c) => c.source))];
  return ['listen', String(port), sources.join(','), '--output', 'compact', '--device-name', `bridge-${config.deployment}`, '--hookdeck-config', cliConfigPath];
}
