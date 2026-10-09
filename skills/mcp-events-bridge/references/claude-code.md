# Claude Code with the bridge

Claude Code doesn't support MCP Events yet: it can't subscribe or receive webhook deliveries. It can use the bridge's **poll tools**, which need no public URL, so they work with a deployed bridge or a local one.

**Tested:** Claude Code 2.1.294 and 2.1.295 (`claude -p`, Haiku 4.5) calling `wait_for_event` against a local bridge, for generic webhook fills and GitHub comments (see `docs/SPIKES.md`).

## 1. Add the bridge as an MCP server

```sh
claude mcp add --transport http events-bridge 'https://<bridge>/mcp/<BRIDGE_MCP_SECRET>'
```

For a local bridge, use the URL `serve` prints (`http://127.0.0.1:8080/mcp/<BRIDGE_MCP_SECRET>`).

The URL contains `BRIDGE_MCP_SECRET`, so mind where Claude Code stores it:

- **`--scope local`** (the default) and **`--scope user`** keep it in your Claude Code config, outside the repository.
- **`--scope project`** writes `.mcp.json` in the repository, which is usually committed. Don't put the secret there: reference an environment variable instead, which Claude Code expands in `.mcp.json`:

  ```json
  { "mcpServers": { "events-bridge": { "type": "http", "url": "${BRIDGE_MCP_URL}" } } }
  ```

  Set `BRIDGE_MCP_URL` in the shell that starts Claude Code. The first time, Claude Code asks you to approve the project's MCP servers (`claude mcp list` shows "Pending approval" until then).

**Check:** `claude mcp list` shows `events-bridge` as connected, and `/mcp` in a session lists its tools.

## 2. Ask for events

Name the event and its filter, and ask Claude to keep waiting:

> Wait for new comments on issues in hookdeck/hookdeck-demos (github.issue_comment, repository hookdeck/hookdeck-demos) and summarize each one.

Claude calls `wait_for_event`, which returns as soon as there are events, or with none after up to 45 seconds, and calls it again with the `cursor` it returned. `events/list` (or asking "what events can the bridge give me?") lists the names and their filters.

- **Start from now:** the first call has no cursor, so it returns only events after it. For events that already happened, ask for them: Claude uses `list_events` and `get_event`.
- **Repeats:** delivery is at least once. If the same `eventId` comes back, it's the same event.
- **Permissions:** Claude Code asks before each MCP tool call unless allowed. Allow the read-only tools for the session, or in settings: `mcp__events-bridge__wait_for_event`, `mcp__events-bridge__poll_events`, `mcp__events-bridge__list_events` and `mcp__events-bridge__get_event`.

## Limits

- **Claude only waits while it's working on your request.** Between turns nothing polls, and events wait in Event Gateway until the next call. Each `wait_for_event` call holds the turn for up to 45 seconds.
- **Waking a session on an event**, without a prompt, is planned as a Claude Code plugin ([#26](https://github.com/hookdeck/mcp-events-bridge/issues/26)).
- **Latency:** an event reaches Claude about 2 seconds after Event Gateway receives it, sometimes up to 15 (see Polling in the README).
