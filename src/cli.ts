#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Catalog, descriptionWarnings } from './core/catalog.js';
import { assertCredentials, ConfigError, defineConfig, env, resolveConfig, type ResolvedConfig, type ResolvedSource } from './core/config.js';
import { HookdeckClient } from './core/hookdeck.js';
import { checkInbound, listenArgs } from './core/inbound-plan.js';
import { describeMigration, migrate, migrationNeeded, planMigration, UPGRADING_URL } from './core/migrate.js';
import { providerSourceName } from './core/names.js';
import { source, type SourceOptions, type WebhookVerification } from './core/sources/source.js';
import { SOURCE_TYPES, type SourceTypeName } from './core/sources/source-types.generated.js';
import { ensureSource, mcpEndpoint, mcpUrl, missingCredentialsError, runSetup, SECRET_PROPAGATION_NOTE } from './core/setup.js';
import { callbackUrlCommand } from './host/callback-url-cli.js';
import { CliListenError, DEFAULT_CLI_CONFIG, loginCli } from './host/cli-listen.js';
import { startLocalRuntime, type LocalRuntime } from './host/local-runtime.js';
import { CONFIG_FILES, loadConfig } from './host/load-config.js';
import { EMPTY_CONFIG, insertSource, missingEnvLines, referencedEnv, sourceSnippet, writeAtomically } from './host/sources-add.js';
import { createBridgeServer } from './host/server.js';
import { watchCommand, watchesCommand } from './host/watch-cli.js';

/*
 * mcp-events-bridge setup | serve | sources add <id> | watch | watches | callback-url | doctor
 *
 * `doctor` comes in stage 7.
 */

const USAGE = `Usage: mcp-events-bridge <command> [--config <file>] [--no-listen] [--migrate]

Commands:
  setup   Create or update the Event Gateway resources, and the webhooks of the sources in bridge.config.ts.
          Offers to migrate data from an earlier version (--migrate to do it without asking)
  serve   Run the bridge: MCP endpoint, subscriptions (Event Gateway delivers each event from its source)
          and expiry sweeper. With CLI inbound it checks the Event Gateway setup, runs \`hookdeck listen\`
          for Event Gateway's issue notifications (--no-listen to run it yourself) and for local agents'
          callback URLs, and retries what they missed while \`listen\` was down. Data from an earlier
          version must be migrated first: it asks in a terminal, and --migrate does it without asking
  sources add <id> [--type <type>] [options]
          Add a source you register with the sender yourself (a service's source type, such as
          stripe, or webhook for any HTTP sender): create its Event Gateway source and print the
          URL to register, add its variables to .env, and print (or with --write-config, add)
          its bridge.config.ts entry. \`sources add --help\` for the options
  watch <event...> [--filter key=value] | --list <file>
          Print one JSON line per event as it happens, polling the bridge (events/poll). With a
          watch list, follow it as it changes and resume where it left off. \`watch --help\`
  watches add|remove|list
          Edit a watch list. \`watches --help\`
  callback-url create|list --agent <name> [options]
          Ask the bridge on this machine for a callback URL that forwards to a local agent's port, with
          the agent's secret read from an environment variable. \`callback-url --help\`
  doctor  Check the deployment (not built yet)`;

const SOURCES_ADD_USAGE = `Usage: mcp-events-bridge sources add <id> [--type <type>] [options]

Creates the Event Gateway source bridge-<id> (or reuses it) and prints its URL, so you can register it
with the sender before you have its secret. Serve refuses to start until the secret is set and setup runs.

Options:
  --type <type>              an Event Gateway source type, such as stripe, slack or shopify, verified with that
                             service's signatures; or webhook (default), for any HTTP sender, verified as below.
                             Its credentials go in .env as <ID>_WEBHOOK_SECRET (or <ID>_<NAME> for other fields)
  --event <name>[=<value>]   event name, repeatable, offered over MCP as <id>.<name> (default: received). With several events,
                             <value> is the sender's value for each, read from --event-type-*
  --verification <type>      webhook: hmac (default), standard-webhooks, basic-auth or api-key
  --algorithm <name>         webhook, hmac: sha256 (default), sha1 or sha512
  --encoding <name>          webhook, hmac: hex (default), base64 or base64url
  --header <name>            webhook, hmac: the signature header (default x-signature); api-key: the key header
                             (default x-api-key)
  --event-type-header <name> | --event-type-field <path>   where the sender names the event
  --event-id-header <name>   | --event-id-field <path>     the sender's stable delivery id
  --occurred-at-field <path> when it happened (ISO 8601 or Unix time)
  --filter <field>           top-level body field subscribers can filter on, repeatable
  --field <field>            pass only these top-level body fields, repeatable (default: the whole body)
  --env-file <file>          where to add the variables (default .env)
  --write-config             add the entry to bridge.config.ts, creating it if needed (default: print it to paste)
  --config <file>            the config file (default bridge.config.ts)`;

const MIGRATION_INTRO = "The bridge's data model in Event Gateway changed in 0.8.";

/** Asks a yes/no question in a terminal; Enter means yes. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)?$/i.test((await rl.question(`${question} [Y/n] `)).trim());
  } finally {
    rl.close();
  }
}

const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * Migrates data from an earlier version, if there is any: with `auto` (--migrate) at once, in a terminal after asking,
 * and otherwise not. Returns false if there's data left to migrate.
 */
async function offerMigration(config: ResolvedConfig, hookdeck: HookdeckClient, { auto, log }: { auto: boolean; log: (message: string) => void }): Promise<boolean> {
  const plan = await planMigration(hookdeck, config);
  if (!migrationNeeded(plan)) return true;
  const found = `${MIGRATION_INTRO} This project has ${describeMigration(plan)}.`;
  if (!auto) {
    if (!interactive()) return false;
    console.log(`\n${found}\nSubscribers keep their subscriptions and callback URLs. More: ${UPGRADING_URL}`);
    if (!(await confirm('Migrate now?'))) return false;
  } else {
    log(`${found} Migrating (--migrate). More: ${UPGRADING_URL}`);
  }
  await migrate({ hookdeck, config, plan, log });
  return true;
}

async function setup(configFile: string | undefined, { migrate: auto }: { migrate: boolean }) {
  const config = await loadConfig({ file: configFile });
  for (const warning of config.warnings) console.warn(`warning: ${warning}`);
  const hookdeck = new HookdeckClient({ apiKey: config.hookdeck.apiKey });
  const report = await runSetup({ config, hookdeck, fetch, log: (m) => console.log(`  ${m}`) });
  const migrated = await offerMigration(config, hookdeck, { auto, log: (m) => console.log(`  ${m}`) });

  console.log(`\nDeployment "${config.deployment}", ${config.inbound} inbound`);
  for (const p of report.sources) {
    const state = p.waitingFor ? `waiting for ${p.waitingFor.join(', ')}` : `transformation ${p.transformation}`;
    console.log(`  source ${p.id}: ${p.sourceUrl}, ${state}, webhook ${p.webhook}`);
    if (p.hint) console.log(p.hint.split('\n').map((line) => `    ${line}`).join('\n'));
  }
  for (const warning of descriptionWarnings(new Catalog(config.sources))) console.warn(`  warning: ${warning}`);
  console.log(`  notifications: ${report.notifications.source} -> ${report.notifications.connection}`);
  console.log(`  issue triggers: ${report.triggers.join(', ')}`);
  if (config.inbound === 'cli') {
    // `listen` only carries Event Gateway's issue notifications: events go from each source straight to subscribers.
    console.log(`\n\`serve\` runs the Hookdeck CLI for you:\n  hookdeck ${listenArgs(config, config.port, DEFAULT_CLI_CONFIG).slice(0, 3).join(' ')}`);
    // Log the CLI in now rather than at the first `serve`, so `hookdeck` commands run here use the bridge's project from the start.
    const cliConfigPath = process.env.BRIDGE_HOOKDECK_CLI_CONFIG ?? DEFAULT_CLI_CONFIG;
    try {
      loginCli(config.hookdeck.apiKey, cliConfigPath);
      console.log(`  logged in to this project in ${cliConfigPath}: \`hookdeck\` commands run in this directory use it`);
    } catch (error) {
      console.warn(`  ${error instanceof CliListenError ? error.message : error}`);
    }
  }
  if (report.mcp.generated) {
    const where = config.inbound === 'http' ? 'as a secret where the bridge runs (on Fly.io: fly secrets set)' : 'in .env';
    console.log(`\nGenerated an MCP secret. Set this line ${where} before running serve, and keep it private (the URL is a credential):`);
    console.log(`BRIDGE_MCP_SECRET=${report.mcp.secret}`);
  }
  console.log(`\nMCP endpoint, with the header Authorization: Bearer <BRIDGE_MCP_SECRET>:\n  ${report.mcp.endpoint}`);
  if (config.auth.secretUrl) console.log(`MCP URL, with the secret in it, for clients that can't send a header (ChatGPT):\n  ${report.mcp.url}`);

  const incomplete = missingCredentialsError(report);
  if (incomplete) {
    console.error(`\n${incomplete}`);
    process.exitCode = 1;
  }
  if (!migrated) {
    console.error(`\n${MIGRATION_INTRO} Data from an earlier version isn't migrated, and serve won't start until it is: run setup again, or setup --migrate. More: ${UPGRADING_URL}`);
    process.exitCode = 1;
  }
}

async function serve(configFile: string | undefined, { manageListen, migrate: auto }: { manageListen: boolean; migrate: boolean }) {
  const config = await loadConfig({ file: configFile });
  for (const warning of config.warnings) console.warn(`[bridge] warning: ${warning}`);
  // Fail closed: a source waiting for its secret can't verify what it receives, so nothing is served until it's set.
  assertCredentials(config);

  // Data from an earlier version: subscriptions there aren't served, and its inbound connections would send events here.
  if (!(await offerMigration(config, new HookdeckClient({ apiKey: config.hookdeck.apiKey }), { auto, log: (m) => console.log(`[bridge] ${m}`) }))) {
    console.error(
      `[bridge] ${MIGRATION_INTRO} This project has data from an earlier version, which must be migrated before serve starts.\n` +
        `Run \`mcp-events-bridge setup\` to migrate it, or start serve with --migrate to migrate it automatically. More: ${UPGRADING_URL}`,
    );
    process.exitCode = 1;
    return;
  }

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

  const bridge = await createBridgeServer(config, { version: packageVersion() });
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
      console.log('[bridge] hookdeck listen connected: forwarding Event Gateway issue notifications, and recovering any missed while it was down');
    } else {
      console.log(`[bridge] --no-listen: forward events yourself with: hookdeck ${listenArgs(config, port, DEFAULT_CLI_CONFIG).slice(0, 3).join(' ')}`);
    }
  }
  console.log(
    `[bridge] MCP endpoint: ${mcpEndpoint(config)} with Authorization: Bearer <BRIDGE_MCP_SECRET>` +
      (config.auth.secretUrl ? `, or ${mcpUrl(config, '<BRIDGE_MCP_SECRET>')}` : ''),
  );
}

function loadDotEnv() {
  try {
    process.loadEnvFile();
  } catch {
    // no .env: rely on the environment
  }
}

/** `sources add <id> [--type <type>]`. */
async function sourcesCommand(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      type: { type: 'string', default: 'webhook' },
      event: { type: 'string', multiple: true },
      verification: { type: 'string', default: 'hmac' },
      algorithm: { type: 'string', default: 'sha256' },
      encoding: { type: 'string', default: 'hex' },
      header: { type: 'string' },
      'event-type-header': { type: 'string' },
      'event-type-field': { type: 'string' },
      'event-id-header': { type: 'string' },
      'event-id-field': { type: 'string' },
      'occurred-at-field': { type: 'string' },
      filter: { type: 'string', multiple: true },
      field: { type: 'string', multiple: true },
      'env-file': { type: 'string', default: '.env' },
      'write-config': { type: 'boolean', default: false },
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [subcommand, id] = positionals;
  const type = values.type.toLowerCase();
  if (subcommand !== 'add') throw new ConfigError(`unknown command \`sources ${subcommand ?? ''}\`. Supported: sources add <id> [--type <type>]`);
  if (values.help || !id) return console.log(SOURCES_ADD_USAGE);
  if (type !== 'webhook' && !Object.hasOwn(SOURCE_TYPES, type)) {
    throw new ConfigError(
      `--type must be webhook or an Event Gateway source type, such as stripe or slack (got ${type}). resend and github have their own helpers in bridge.config.ts; see the README`,
    );
  }
  const one = <T>(a: T | undefined, b: T | undefined, what: string) => {
    if (a !== undefined && b !== undefined) throw new ConfigError(`set --${what}-header or --${what}-field, not both`);
    return a;
  };
  one(values['event-type-header'], values['event-type-field'], 'event-type');
  one(values['event-id-header'], values['event-id-field'], 'event-id');

  // The entry, as it will appear in bridge.config.ts. Credentials are env() references, named after the id.
  const prefix = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const envFor = (option: string) => env(option === 'secret' ? `${prefix}_WEBHOOK_SECRET` : `${prefix}_${option.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`);
  const events = (values.event?.length ? values.event : ['received']).map((e) => e.split('=') as [string, string?]);
  const withValues = events.some(([, value]) => value !== undefined);
  const where = (header?: string, field?: string) => (header ? { header } : field ? { field } : undefined);
  const common = {
    id,
    events: withValues ? Object.fromEntries(events.map(([name, value]) => [name, value ? { value } : {}])) : events.map(([name]) => name),
    eventType: where(values['event-type-header'], values['event-type-field']),
    eventId: where(values['event-id-header'], values['event-id-field']),
    occurredAt: values['occurred-at-field'] ? { field: values['occurred-at-field'] } : undefined,
    fields: values.field,
    filters: values.filter,
  };
  let options: SourceOptions;
  if (type === 'webhook') {
    const kind = values.verification;
    const verification: WebhookVerification =
      kind === 'hmac'
        ? { type: 'hmac', algorithm: values.algorithm as 'sha256', encoding: values.encoding as 'hex', header: values.header ?? 'x-signature', secret: envFor('secret') }
        : kind === 'standard-webhooks'
          ? { type: 'standard-webhooks', secret: envFor('secret') }
          : kind === 'basic-auth'
            ? { type: 'basic-auth', username: env(`${prefix}_WEBHOOK_USERNAME`), password: env(`${prefix}_WEBHOOK_PASSWORD`) }
            : kind === 'api-key'
              ? { type: 'api-key', header: values.header ?? 'x-api-key', key: env(`${prefix}_WEBHOOK_API_KEY`) }
              : (() => {
                  throw new ConfigError(`--verification must be hmac, standard-webhooks, basic-auth or api-key`);
                })();
    options = { ...common, type: 'webhook', verification };
  } else {
    const credentials = Object.fromEntries(Object.keys(SOURCE_TYPES[type as SourceTypeName].auth).map((option) => [option, envFor(option)]));
    options = { ...common, type, ...credentials } as SourceOptions;
  }
  const instance = source(options); // validates the options
  const snippet = sourceSnippet(options);

  // 1. The source, from the config's entry if there's one already (so its options win), else from the flags.
  let configured: ResolvedSource | undefined;
  let fromConfig = false;
  try {
    configured = (await loadConfig({ file: values.config })).sources.find((p) => p.id === id);
    fromConfig = Boolean(configured);
  } catch {
    // no loadable config yet: use the flags
  }
  if (configured && configured.definition.type !== type) throw new ConfigError(`bridge.config.ts already has a ${configured.definition.type} source with the id "${id}"`);
  configured ??= resolveConfig(
    defineConfig({ deployment: 'cli', hookdeck: { apiKey: env('HOOKDECK_API_KEY'), signingSecret: 'unused' }, sources: [instance] }),
    process.env,
  ).sources[0]!;
  const hookdeck = new HookdeckClient({ apiKey: process.env.HOOKDECK_API_KEY ?? '' });
  if (!process.env.HOOKDECK_API_KEY) throw new ConfigError('HOOKDECK_API_KEY is not set');
  const existingSource = (await hookdeck.listSources({ name: providerSourceName(id) })).models[0];
  if (existingSource) {
    const owner = (() => {
      try {
        return (JSON.parse(existingSource.description ?? '') as { provider?: string }).provider;
      } catch {
        return undefined;
      }
    })();
    if (owner !== type) throw new ConfigError(`the Event Gateway source ${existingSource.name} exists and isn't a bridge ${type} source; choose another id`);
  }
  const { source: created, missing } = await ensureSource(hookdeck, configured, (m) => console.log(`  ${m}`));
  console.log(`\nSource ${created.name} ${existingSource ? 'already existed' : 'created'}${fromConfig ? ' (from the entry in bridge.config.ts)' : ''}.`);
  console.log(`Register this URL with the sender:\n  ${created.url}`);
  console.log(
    missing.length
      ? `serve refuses to start until ${missing.join(', ')} is set: Event Gateway keeps requests that arrive meanwhile. Then run setup.`
      : `Its credentials are set; run setup to apply them.`,
  );

  // 2. .env: append the variables the entry references, empty, if the file doesn't mention them.
  const envFile = path.resolve(values['env-file']);
  const before = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const { text, added } = missingEnvLines(before, id, referencedEnv(options));
  if (added.length) fs.appendFileSync(envFile, text);
  console.log(added.length ? `\nAdded to ${path.relative(process.cwd(), envFile)} (empty): ${added.join(', ')}` : `\n${path.basename(envFile)} already has ${referencedEnv(options).map((v) => v.name).join(', ')}`);

  // 3. bridge.config.ts: print the entry, or insert it with --write-config.
  const configFile = values.config ? path.resolve(values.config) : CONFIG_FILES.map((name) => path.resolve(name)).find((f) => fs.existsSync(f));
  const printSnippet = (why: string) => {
    console.log(`\n${why} Add this to \`sources\` in ${configFile ? path.basename(configFile) : 'bridge.config.ts'}, importing source from '@hookdeck/mcp-events-bridge/sources' and env from '@hookdeck/mcp-events-bridge':\n`);
    console.log(snippet.split('\n').map((line) => `    ${line}`).join('\n') + ',');
  };
  if (fromConfig) console.log(`\n${configFile ? path.basename(configFile) : 'The config'} already has the "${id}" entry.`);
  else if (!values['write-config']) printSnippet('Next:');
  else {
    // No config file yet: start one, so a first source needs no hand-written file.
    const target = configFile ?? path.resolve(CONFIG_FILES[0]!);
    const exists = fs.existsSync(target);
    const result = await insertSource(exists ? fs.readFileSync(target, 'utf8') : EMPTY_CONFIG, id, snippet);
    if (result.status === 'inserted') {
      writeAtomically(target, result.code);
      console.log(`\n${exists ? 'Added' : `Created ${path.basename(target)} with`} the "${id}" entry${exists ? ` to ${path.basename(target)}` : ''}.`);
    } else if (result.status === 'exists') console.log(`\n${path.basename(target)} already has the "${id}" entry.`);
    else printSnippet(`Didn't edit ${path.basename(target)}: ${result.reason}.`);
  }

  console.log(
    `\nThen: put the ${missing.length ? 'value(s) the sender gives you' : 'credentials'} in ${path.basename(envFile)} and run \`mcp-events-bridge setup\`. ` +
      `Setup applies them to the source and connects it (${SECRET_PROPAGATION_NOTE}).`,
  );
}

/** This package's version; package.json is one level up from both src/cli.ts and dist/cli.js. */
function packageVersion(): string {
  return (JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'providers') throw new ConfigError('`providers` is now `sources` (renamed in 0.6.0, and the old name removed in 0.8.0): use `sources add <id> --type webhook`');
  if (argv[0] === 'sources') {
    loadDotEnv();
    return sourcesCommand(argv.slice(1));
  }
  if (argv[0] === 'watch' || argv[0] === 'watches' || argv[0] === 'callback-url') {
    const command = argv[0] === 'watch' ? watchCommand : argv[0] === 'watches' ? watchesCommand : callbackUrlCommand;
    try {
      return await command(argv.slice(1), packageVersion(), loadDotEnv);
    } catch (error) {
      console.error(`[${argv[0]}] ${(error as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'no-listen': { type: 'boolean', default: false },
      migrate: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help) return console.log(USAGE);
  if (values.version) return console.log(packageVersion());
  loadDotEnv();
  switch (positionals[0]) {
    case 'setup':
      return setup(values.config, { migrate: values.migrate });
    case 'serve':
      return serve(values.config, { manageListen: !values['no-listen'], migrate: values.migrate });
    default:
      console.error(USAGE);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `Config: ${error.message}` : error);
  process.exitCode = 1;
});
