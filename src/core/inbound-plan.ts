import type { ResolvedConfig } from './config.js';
import type { HookdeckClient } from './hookdeck.js';
import { notificationsConnectionName, providerConnectionName, providerSourceName } from './names.js';
import { NOTIFICATIONS_SOURCE } from './setup.js';

/*
 * What a deployment's inbound side looks like in Event Gateway, derived from
 * the config: one connection per provider instance, plus the notifications
 * connection. Used to check a CLI-inbound deployment before `hookdeck listen`
 * starts (so it never falls back to creating default connections) and to
 * build that listen command.
 */

export interface InboundConnection {
  source: string;
  connection: string;
  path: string;
}

export function inboundConnections(config: ResolvedConfig): InboundConnection[] {
  return [
    ...config.providers.map((p) => ({
      source: providerSourceName(p.id),
      connection: providerConnectionName(p.id, config.deployment),
      path: `/inbound/${p.id}`,
    })),
    { source: NOTIFICATIONS_SOURCE, connection: notificationsConnectionName(config.deployment), path: '/inbound/hookdeck' },
  ];
}

/** Problems that would make `hookdeck listen` misroute or create default connections. Empty when ready. */
export async function checkInbound(config: ResolvedConfig, hookdeck: HookdeckClient): Promise<string[]> {
  const problems: string[] = [];
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
