#!/usr/bin/env -S npx tsx
import { parseArgs } from 'node:util';
import { ConfigError } from './core/config.js';
import { HookdeckClient } from './core/hookdeck.js';
import { mcpUrl, runSetup } from './core/setup.js';
import { loadConfig } from './host/load-config.js';
import { createBridgeServer } from './host/server.js';

/*
 * mcp-events-bridge setup | serve | doctor
 *
 * `doctor` comes in stage 7.
 */

const USAGE = `Usage: mcp-events-bridge <command> [--config <file>]

Commands:
  setup   Create or update the Event Gateway resources and provider webhooks in bridge.config.ts
  serve   Run the bridge: inbound relay, MCP endpoint and expiry sweeper
  doctor  Check the deployment (not built yet)`;

async function setup(configFile: string | undefined) {
  const config = await loadConfig({ file: configFile });
  const hookdeck = new HookdeckClient({ apiKey: config.hookdeck.apiKey });
  const report = await runSetup({ config, hookdeck, fetch, log: (m) => console.log(`  ${m}`) });

  console.log(`\nDeployment "${config.deployment}", ${config.inbound} inbound`);
  for (const p of report.providers) {
    console.log(`  provider ${p.id}: source ${p.sourceUrl}, connection ${p.connection}, webhook ${p.webhook}`);
  }
  console.log(`  notifications: ${report.notifications.source} -> ${report.notifications.connection}`);
  console.log(`  issue triggers: ${report.triggers.join(', ')}`);
  if (config.inbound === 'cli') {
    for (const p of report.providers) {
      console.log(`\nForward provider events to the bridge with:\n  hookdeck listen ${config.port} bridge-${p.id} ${p.connection}`);
    }
  }
  if (report.mcp.generated) {
    console.log(`\nGenerated an MCP secret. Set it before running serve, and keep it private (the URL is a credential):`);
    console.log(`  BRIDGE_MCP_SECRET=${report.mcp.secret}   (in .env, or: fly secrets set BRIDGE_MCP_SECRET=...)`);
  }
  console.log(`\nMCP URL for ChatGPT (Developer mode, "No Authentication"):\n  ${report.mcp.url}`);
}

async function serve(configFile: string | undefined) {
  const config = await loadConfig({ file: configFile });
  const bridge = await createBridgeServer(config);
  const { host, port } = await bridge.listen();
  console.log(`[bridge] listening on ${host}:${port} (${config.inbound} inbound, deployment "${config.deployment}")`);
  if (config.inbound === 'cli') {
    for (const p of config.providers) console.log(`[bridge] forward events with: hookdeck listen ${port} bridge-${p.id} bridge-${p.id}-${config.deployment}`);
  }
  console.log(`[bridge] MCP endpoint: ${mcpUrl(config, '<BRIDGE_MCP_SECRET>')}`);
  const stop = async () => {
    await bridge.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { config: { type: 'string' } } });
  try {
    process.loadEnvFile();
  } catch {
    // no .env: rely on the environment
  }
  switch (positionals[0]) {
    case 'setup':
      return setup(values.config);
    case 'serve':
      return serve(values.config);
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `Config: ${error.message}` : error);
  process.exitCode = 1;
});
