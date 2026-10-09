import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { addWatch, projectPaths, pruneState, readWatchList, removeWatches, statePathFor, updateWatchList, watchKey, watchList, type Watch } from './watch-list.js';
import { isBridgeError, isFatal, parseFilters, redactUrl, watch, watchUrl, type Poll } from './watch.js';

/*
 * The `watch` and `watches` commands. `watch` polls the bridge and prints one JSON line per event;
 * `watches` edits the watch list that `watch --list` (or --store/--project) follows.
 */

export const WATCH_USAGE = `Usage: mcp-events-bridge watch <event name...> [options]
       mcp-events-bridge watch --list <file> | --store <dir> --project <dir> [options]

Polls a running bridge for events and prints each one on its own line, as JSON
({ eventId, name, timestamp, data }), for an agent watching the command's output (such as Claude
Code's Monitor tool) or a script. Runs until stopped.

With event names, it watches those from now on, and exits if one is unknown or its filters don't
match. With a watch list (edited with \`mcp-events-bridge watches\`), it follows the list as it
changes, saves where each watch got to, and resumes there next time (events up to 24 hours old).
A watch that can't run, or a bridge that can't be reached for about 30 seconds, is reported on
stdout as { "problem": ... }. Other progress and retries go to stderr.

Options:
  --filter <key>=<value>  with event names: the events' arguments, repeatable, as events/list
                          describes them, e.g. --filter repository=hookdeck/hookdeck-demos. JSON
                          values are parsed: --filter 'actions=["opened"]'
  --list <file>           the watch list, { "watches": [{ "name", "arguments" }] }
  --state <file>          where to save the cursors (default: <list>.state.json beside the list)
  --store <dir> --project <dir>
                          the list and state for a project, kept under <store>/projects/
  --url <MCP URL>         the bridge's MCP URL. Default with event names or --list: BRIDGE_MCP_URL,
                          else built from BRIDGE_PUBLIC_URL (or the local port) and BRIDGE_MCP_SECRET,
                          read from the environment or .env
  --url-file <file>       a file holding the MCP URL, read when connecting, else BRIDGE_MCP_URL
                          (default with --store: <store>/mcp-url; .env isn't read)`;

export const WATCHES_USAGE = `Usage: mcp-events-bridge watches add <event name> [--filter key=value...] <list options>
       mcp-events-bridge watches remove <event name> [--filter key=value...] | --all  <list options>
       mcp-events-bridge watches list <list options>

Edits the watch list that \`watch --list\` follows; a running watch picks up changes within seconds.
\`add\` checks the event name and filters with the bridge first, when it can reach it. \`remove\`
without --filter removes every watch for that event name.

List options: --list <file>, or --store <dir> --project <dir>; and for \`add\`, --url or --url-file
as for \`watch\`.`;

const listOptions = {
  list: { type: 'string' },
  state: { type: 'string' },
  store: { type: 'string' },
  project: { type: 'string' },
  url: { type: 'string' },
  'url-file': { type: 'string' },
  filter: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

type ListValues = { list?: string; state?: string; store?: string; project?: string; url?: string; 'url-file'?: string };

function listPaths(values: ListValues): { list: string; state: string } | undefined {
  if (values.store || values.project) {
    if (!values.store || !values.project) throw new Error('--store and --project go together');
    const paths = projectPaths(values.store, values.project);
    return { list: paths.list, state: values.state ?? paths.state };
  }
  if (values.list) return { list: values.list, state: values.state ?? statePathFor(values.list) };
  return undefined;
}

/** The MCP URL, read when connecting: --url, else --url-file (or <store>/mcp-url), else the environment. */
function urlSource(values: ListValues): () => string {
  const file = values['url-file'] ?? (values.store ? path.join(values.store, 'mcp-url') : undefined);
  if (values.url || !file) {
    const url = watchUrl(values.url, process.env);
    return () => url;
  }
  return () => {
    try {
      const url = fs.readFileSync(file, 'utf8').trim();
      if (url) return url;
    } catch {
      // not written yet
    }
    if (process.env.BRIDGE_MCP_URL) return process.env.BRIDGE_MCP_URL;
    throw new Error(`no MCP URL yet: ${file} is missing or empty`);
  };
}

/** A polling client for the bridge. One MCP client for all the loops; a failed request drops it, and the next poll reconnects. */
async function bridgePoller(url: () => string, version: string): Promise<{ poll: Poll; connect: () => Promise<unknown>; close: () => Promise<void> }> {
  // Loaded here so the other commands don't need the MCP client.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { z } = await import('zod');
  const anyResult = z.record(z.string(), z.unknown());
  let client: Promise<InstanceType<typeof Client>> | undefined;
  const connect = () =>
    (client ??= (async () => {
      const c = new Client({ name: 'mcp-events-bridge-watch', version }, { versionNegotiation: { mode: 'auto' } });
      await c.connect(new StreamableHTTPClientTransport(new URL(url())));
      return c;
    })());
  const poll: Poll = async (request, signal) => {
    const current = connect();
    try {
      return (await (await current).request({ method: 'events/poll', params: request } as never, anyResult, { signal })) as never;
    } catch (error) {
      // An error from the bridge leaves the connection usable; a transport failure drops it.
      if (!isBridgeError(error) && client === current) {
        client = undefined;
        void current.then((c) => c.close()).catch(() => {});
      }
      throw error;
    }
  };
  return { poll, connect, close: async () => void (await client?.catch(() => undefined))?.close() };
}

const message = (error: unknown) => {
  const detail = (error as { data?: { detail?: unknown } }).data?.detail;
  return `${redactUrl(String((error as Error)?.message ?? error))}${typeof detail === 'string' ? `: ${detail}` : ''}`;
};

function stopOnSignals() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return controller;
}

export async function watchCommand(argv: string[], version: string, loadDotEnv: () => void) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: listOptions });
  const paths = listPaths(values);
  // A plugin monitor runs in the user's project: its .env is theirs, not the bridge's.
  if (!values.store && !values['url-file']) loadDotEnv();
  if (values.help || (positionals.length === 0 && !paths)) return console.log(WATCH_USAGE);
  if (paths && positionals.length) throw new Error('give event names or a watch list, not both');
  const url = urlSource(values);
  const bridge = await bridgePoller(url, version);
  const onError = (name: string, error: unknown, retryMs: number) => console.error(`[watch] ${name}: ${message(error)}; retrying in ${retryMs / 1000}s`);

  if (paths) {
    // Long-running (a plugin monitor): connect lazily, report problems on stdout, never exit on its own.
    const controller = stopOnSignals();
    if (process.stderr.isTTY) console.error(`[watch] following ${paths.list}`);
    await watchList({
      ...paths,
      poll: bridge.poll,
      onEvent: (event) => console.log(JSON.stringify(event)),
      onProblem: (problem) => console.log(JSON.stringify(problem)),
      onError,
      describe: message,
      signal: controller.signal,
    });
    return bridge.close();
  }

  const args = parseFilters(values.filter ?? []);
  try {
    await bridge.connect();
  } catch (error) {
    console.error(`[watch] can't connect to ${redactUrl(safeUrl(url))}: ${message(error)}`);
    process.exitCode = 1;
    return;
  }
  const controller = stopOnSignals();
  const filters = Object.keys(args).length ? ` (${Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')})` : '';
  // Only for a person at a terminal: an agent watching the output (stderr included) would be woken by it.
  if (process.stderr.isTTY) console.error(`[watch] ${positionals.join(', ')}${filters} from ${redactUrl(safeUrl(url))}, from now on`);
  try {
    await watch({ names: positionals, arguments: args, signal: controller.signal, poll: bridge.poll, onEvent: (event) => console.log(JSON.stringify(event)), onError });
  } catch (error) {
    // Fatal: an unknown event name, or arguments that don't match its inputSchema (data.detail says how).
    console.error(`[watch] ${message(error)}`);
    process.exitCode = 1;
  } finally {
    await bridge.close();
  }
}

const safeUrl = (url: () => string) => {
  try {
    return url();
  } catch {
    return '<no URL>';
  }
};

const describe = (w: Watch) =>
  `${w.name}${Object.keys(w.arguments).length ? ` ${Object.entries(w.arguments).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')}` : ''}`;

export async function watchesCommand(argv: string[], version: string, loadDotEnv: () => void) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { ...listOptions, all: { type: 'boolean', default: false } } });
  const [action, name] = positionals;
  const paths = listPaths(values);
  if (!values.store && !values['url-file']) loadDotEnv();
  if (values.help || !action) return console.log(WATCHES_USAGE);
  if (!paths) throw new Error('give the watch list: --list <file>, or --store <dir> --project <dir>');
  const watches = readWatchList(paths.list);

  switch (action) {
    case 'list':
      if (!watches.length) return console.log('No watches.');
      for (const w of watches) console.log(describe(w));
      return;
    case 'add': {
      if (!name) throw new Error('watches add <event name> [--filter key=value...]');
      const watch: Watch = { name, arguments: parseFilters(values.filter ?? []) };
      if (watches.some((w) => watchKey(w) === watchKey(watch))) return console.log(`Already watching ${describe(watch)}.`);
      // A poll with no cursor checks the name and filters and returns no events.
      let unchecked: string | undefined;
      const bridge = await bridgePoller(urlSource(values), version);
      try {
        await bridge.poll({ ...watch, cursor: null });
      } catch (error) {
        if (isFatal(error)) {
          console.error(`Not added: ${message(error)}`);
          process.exitCode = 1;
          return;
        }
        unchecked = message(error);
      } finally {
        await bridge.close();
      }
      // Under the lock, from the list as it is now: another add may have written it meanwhile.
      await updateWatchList(paths.list, (latest) => addWatch(latest, watch));
      console.log(`Watching ${describe(watch)}.${unchecked ? ` (Not checked with the bridge, which couldn't be reached: ${unchecked})` : ''}`);
      return;
    }
    case 'remove': {
      if (!values.all && !name) throw new Error('watches remove <event name> [--filter key=value...] | --all');
      const args = values.filter?.length ? parseFilters(values.filter) : undefined;
      const { removed, left } = await updateWatchList(paths.list, (latest) => {
        const removed = values.all ? latest.splice(0).length : removeWatches(latest, name!, args);
        return { removed, left: [...latest] };
      });
      // Their saved cursors too, so adding one again starts from now.
      pruneState(paths.state, left);
      if (values.all) return console.log(`Removed ${removed} watch${removed === 1 ? '' : 'es'}.`);
      return console.log(removed ? `Removed ${removed} watch${removed === 1 ? '' : 'es'} for ${name}.` : `No watch for ${name} matched.`);
    }
    default:
      throw new Error(`unknown action "${action}": add, remove or list`);
  }
}
