# Glama introspection entry

[Glama](https://glama.ai/mcp/servers/hookdeck/mcp-events-bridge) scores an MCP server from its tool definitions, which it reads by running the server in a sandbox and calling `tools/list`. Glama runs servers over stdio, through [`mcp-proxy`](https://www.npmjs.com/package/mcp-proxy), with no credentials. The bridge serves MCP over HTTP and needs a Hookdeck project, so `stdio.ts` serves the bridge's own MCP server (the `createBridgeServer` wiring that `serve` uses) over stdio, from a placeholder config and a stub Event Gateway client that makes no network calls.

- **Tool definitions are the real ones:** `test/scripts/glama-stdio.test.ts` checks that `tools/list` over stdio equals what the bridge serves over HTTP. It runs the entry with `fetch`, outbound sockets (`net`, so `http`, `https` and `tls` too) and DNS (`lookup` and the `resolve` family) blocked, and checks the preload reports each of them.
- **The local tool set:** it lists all seven tools, as a bridge with CLI inbound (the default on your own machine) does. A deployed bridge (HTTP inbound) has five: it doesn't offer `create_callback_url` and `list_callback_urls`.
- **Requests that need Event Gateway don't work:** a tool call returns an error that says this is the introspection build, and `events/subscribe` fails without checking or challenging the callback URL. To use the bridge, run `mcp-events-bridge serve`.
- **No environment variables:** the process environment is never read for config, so no real key reaches it.

Run it locally:

```sh
npx tsx scripts/glama/stdio.ts
```

## Glama build settings

Glama builds from its admin page (Admin, then Dockerfile), not from the repo's `Dockerfile`. It clones the default branch, runs the build steps, and starts `mcp-proxy` with the CMD arguments.

| Field | Value |
| --- | --- |
| Node.js version (or base image) | `24` (the bridge needs Node 22.12 or later) |
| Python version | Leave the default; the bridge doesn't use Python |
| Build steps | `["npm ci --omit=dev --no-audit --no-fund"]` |
| CMD arguments | `["npx", "tsx", "scripts/glama/stdio.ts"]` |
| Environment variables JSON schema | `{"type": "object", "properties": {}, "required": []}` |
| Placeholder parameters | `{}` |
| Pinned commit SHA | Leave empty |

There's no TypeScript build step: `tsx` (a runtime dependency) runs the source.
