# Glama introspection entry

[Glama](https://glama.ai/mcp/servers/hookdeck/mcp-events-bridge) scores an MCP server from its tool definitions, which it reads by running the server in a sandbox and calling `tools/list`. Glama runs servers over stdio, through [`mcp-proxy`](https://www.npmjs.com/package/mcp-proxy), with no credentials. The bridge serves MCP over HTTP and needs a Hookdeck project, so `stdio.ts` serves the bridge's own MCP server (the `createBridgeServer` wiring that `serve` uses) over stdio, from a placeholder config and a stub Event Gateway client that makes no network calls.

- **Tool definitions are the real ones:** `test/scripts/glama-stdio.test.ts` checks that `tools/list` over stdio equals what the bridge serves over HTTP, with outbound sockets, DNS and `fetch` blocked in the child process.
- **Tool calls don't work:** a tool that needs Event Gateway returns an error that says this is the introspection build. To use the bridge, run `mcp-events-bridge serve`.
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
