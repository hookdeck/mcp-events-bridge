#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { ConfigError } from './core/config.js';
import { HookdeckClient } from './core/hookdeck.js';
import { checkInbound, listenArgs } from './core/inbound-plan.js';
import { mcpUrl, runSetup } from './core/setup.js';
import { CliListenError, DEFAULT_CLI_CONFIG, loginCli } from './host/cli-listen.js';
import { startLocalRuntime, type LocalRuntime } from './host/local-runtime.js';
import { loadConfig } from './host/load-config.js';
import { createBridgeServer } from './host/server.js';

/*
 * mcp-events-bridge setup | serve | doctor
 *
 * `doctor` comes in stage 7.
 */

const USAGE = `Usage: mcp-events-bridge <command> [--config <file>] [--no-listen]

Commands:
  setup   Create or update the Event Gateway resources and provider webhooks in bridge.config.ts
  serve   Run the bridge: inbound relay, MCP endpoint and expiry sweeper. With CLI inbound it checks
          the Event Gateway setup, runs \`hookdeck listen\` for every configured source (--no-listen
          to run it yourself) and for local agents' tunnel URLs, and recovers events missed while
          \`listen\` was down
  doctor  Check the deployment (not built yet)`;

async function setup(configFile: string | undefined) {
  const config = await loadConfig({ file: configFile });
  const hookdeck = new HookdeckClient({ apiKey: config.hookdeck.apiKey });
  const report = await runSetup({ config, hookdeck, fetch, log: (m) => console.log(`  ${m}`) });

  console.log(`\nDeployment "${config.deployment}", ${config.inbound} inbound`);
  for (const p of report.providers) {
    console.log(`  provider ${p.id}: source ${p.sourceUrl}, connection ${p.connection}, webhook ${p.webhook}`);
    if (p.hint) console.log(p.hint.split('\n').map((line) => `    ${line}`).join('\n'));
  }
  console.log(`  notifications: ${report.notifications.source} -> ${report.notifications.connection}`);
  console.log(`  issue triggers: ${report.triggers.join(', ')}`);
  if (config.inbound === 'cli') {
    console.log(`\n\`serve\` runs the Hookdeck CLI for you:\n  hookdeck ${listenArgs(config, config.port, DEFAULT_CLI_CONFIG).slice(0, 3).join(' ')}`);
  }
  if (report.mcp.generated) {
    console.log(`\nGenerated an MCP secret. Set it before running serve, and keep it private (the URL is a credential):`);
    console.log(`  BRIDGE_MCP_SECRET=${report.mcp.secret}   (in .env, or: fly secrets set BRIDGE_MCP_SECRET=...)`);
  }
  console.log(`\nMCP URL for ChatGPT (Developer mode, "No Authentication"):\n  ${report.mcp.url}`);
}

async function serve(configFile: string | undefined, { manageListen }: { manageListen: boolean }) {
  const config = await loadConfig({ file: configFile });

  // Check Event Gateway first: a CLI-inbound deployment must not start `hookdeck listen` against missing
  // connections, or the CLI creates default ones and events go astray.
  const problems = await checkInbound(config, new HookdeckClient({ apiKey: config.hookdeck.apiKey }));
  if (problems.length) {
    const message = `Event Gateway isn't set up for deployment "${config.deployment}" (${config.inbound} inbound):\n${problems.map((p) => `  - ${p}`).join('\n')}\nRun \`mcp-events-bridge setup\` (with the same BRIDGE_DEPLOYMENT and BRIDGE_INBOUND).`;
    if (config.inbound === 'cli') {
      console.error(message);
      process.exitCode = 1;
      return;
    }
    console.warn(`[bridge] warning: ${message}`);
  }

  const bridge = await createBridgeServer(config);
  const { host, port } = await bridge.listen();
  console.log(`[bridge] listening on ${host}:${port} (${config.inbound} inbound, deployment "${config.deployment}")`);

  let runtime: LocalRuntime | undefined;
  const stop = async (code = 0) => {
    await runtime?.stop();
    await bridge.close();
    process.exit(code);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  if (config.inbound === 'cli') {
    // A bridge on a laptop runs `hookdeck listen` for its own inbound (unless --no-listen) and for local agents.
    const cliConfigPath = process.env.BRIDGE_HOOKDECK_CLI_CONFIG ?? DEFAULT_CLI_CONFIG;
    try {
      const version = loginCli(config.hookdeck.apiKey, cliConfigPath);
      console.log(`[bridge] Hookdeck CLI ${version}`);
    } catch (error) {
      console.error(`[bridge] ${error instanceof CliListenError ? error.message : error}`);
      return stop(1);
    }
    runtime = startLocalRuntime(bridge, config, port, { cliConfigPath, inbound: manageListen, agents: true });
    if (manageListen) {
      if (!(await runtime.inboundReady)) {
        console.error('[bridge] hookdeck listen did not connect within 30s');
        return stop(1);
      }
      console.log('[bridge] hookdeck listen connected: forwarding provider events and issue notifications, and recovering any missed while it was down');
    } else {
      console.log(`[bridge] --no-listen: forward events yourself with: hookdeck ${listenArgs(config, port, DEFAULT_CLI_CONFIG).slice(0, 3).join(' ')}`);
    }
  }
  console.log(`[bridge] MCP endpoint: ${mcpUrl(config, '<BRIDGE_MCP_SECRET>')}`);
}

/** This package's version; package.json is one level up from both src/cli.ts and dist/cli.js. */
function packageVersion(): string {
  return (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'no-listen': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help) return console.log(USAGE);
  if (values.version) return console.log(packageVersion());
  try {
    process.loadEnvFile();
  } catch {
    // no .env: rely on the environment
  }
  switch (positionals[0]) {
    case 'setup':
      return setup(values.config);
    case 'serve':
      return serve(values.config, { manageListen: !values['no-listen'] });
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `Config: ${error.message}` : error);
  process.exitCode = 1;
});
