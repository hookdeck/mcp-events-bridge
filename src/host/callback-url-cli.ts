import { parseArgs } from 'node:util';
import { redactUrl, watchHeaders, watchUrl } from './watch.js';

/*
 * The `callback-url` command: asks the running bridge for a callback URL (the create_callback_url tool) for a client
 * set up outside a model, such as Hermes Agent. The secret is read from an environment variable, so it never appears
 * in a command line or a tool call a model writes.
 */

export const CALLBACK_URL_USAGE = `Usage: mcp-events-bridge callback-url create --agent <name> --name <name> [options]
       mcp-events-bridge callback-url list --agent <name> [--url <MCP URL>]

Asks the bridge running on this machine (with CLI inbound) for a public callback URL that forwards to a local
port, and prints it. Subscribe with that URL, or a path under it, as the callback URL.

Options:
  --agent <name>       your agent or machine name (letters, digits, _)
  --name <name>        a name for the URL (letters, digits, _)
  --port <port>        the local port your agent receives on (default 3000; set by the agent's first URL)
  --path <path>        the local path deliveries go to (default /events; set by the agent's first URL)
  --secret-env <var>   the environment variable (or .env entry) holding the whsec_ secret you subscribe with.
                       Event Gateway then answers the subscribe challenge and only accepts deliveries signed
                       with it. Without it, the URL is pass-through: Event Gateway verifies nothing, so your
                       receiver must check every signature (for a client with a secret per subscription)
  --url <MCP URL>      the bridge's MCP URL (default: BRIDGE_MCP_URL, else the local port plus /mcp, with
                       BRIDGE_MCP_SECRET sent as a bearer token)
  --json               print the result as JSON`;

export async function callbackUrlCommand(argv: string[], version: string, loadDotEnv: () => void): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      name: { type: 'string' },
      port: { type: 'string' },
      path: { type: 'string' },
      'secret-env': { type: 'string' },
      url: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const action = positionals[0];
  if (values.help || (action !== 'create' && action !== 'list')) {
    console.log(CALLBACK_URL_USAGE);
    if (!values.help) process.exitCode = 1;
    return;
  }
  loadDotEnv();
  if (!values.agent) throw new Error('--agent is required');
  if (action === 'create' && !values.name) throw new Error('--name is required');
  let secret: string | undefined;
  if (values['secret-env']) {
    secret = process.env[values['secret-env']];
    if (!secret) throw new Error(`${values['secret-env']} is not set`);
  }
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && !Number.isInteger(port)) throw new Error('--port must be a number');

  const url = watchUrl(values.url, process.env);
  // Loaded here so the other commands don't need the MCP client.
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const client = new Client({ name: 'mcp-events-bridge-callback-url', version }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: watchHeaders(url, process.env.BRIDGE_MCP_SECRET) } }));
  } catch (error) {
    throw new Error(`can't connect to the bridge at ${redactUrl(url)}: ${redactUrl((error as Error).message)}`);
  }
  try {
    const tool = action === 'create' ? 'create_callback_url' : 'list_callback_urls';
    if (!(await client.listTools()).tools.some((t) => t.name === tool)) {
      throw new Error(`the bridge at ${redactUrl(url)} doesn't offer callback URLs: they come from a bridge running on this machine with CLI inbound`);
    }
    const args = action === 'create' ? { agent: values.agent, name: values.name, port, path: values.path, secret } : { agent: values.agent };
    const result = (await client.callTool({ name: tool, arguments: args })) as { content?: Array<{ type: string; text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    if (result.isError) throw new Error(text);
    if (values.json) {
      console.log(JSON.stringify(result.structuredContent ?? JSON.parse(text)));
      return;
    }
    const records = (action === 'create' ? [result.structuredContent] : (result.structuredContent?.callbackUrls as unknown[])) as Array<{ name: string; url: string; port: number; path: string; passThrough: boolean }>;
    for (const record of records) {
      console.log(`${record.name}: ${record.url} -> http://localhost:${record.port}${record.path}${record.passThrough ? ' (pass-through: your receiver verifies every delivery)' : ''}`);
    }
    if (action === 'list' && !records.length) console.log(`no callback URLs for agent ${values.agent}`);
  } finally {
    await client.close();
  }
}
