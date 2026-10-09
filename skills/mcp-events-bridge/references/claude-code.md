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

## 3. Watch in the background

`wait_for_event` holds Claude's turn. To hear about events while Claude is idle or doing something else, ask it to run `mcp-events-bridge watch` with its Monitor tool, which wakes the session on each line a command prints:

> In the background, watch hookdeck/hookdeck-demos for new issues and comments with `npx mcp-events-bridge watch github.issues github.issue_comment --filter repository=hookdeck/hookdeck-demos`, and tell me about each one as it arrives.

`watch` prints one JSON line per event. It needs the bridge's MCP URL: set `BRIDGE_MCP_URL` in the shell that starts Claude Code, or run it where `.env` has `BRIDGE_MCP_SECRET` (and `BRIDGE_PUBLIC_URL` for a deployed bridge).

- **Up to 30 minutes at a time:** a Monitor watch expires after at most 30 minutes, and Claude re-arms it when told to keep watching. Events that arrive in between are missed, because each new `watch` starts from now.
- **Long events are shortened:** Monitor cuts a long line short (seen at around 500 characters), so long text fields, such as a comment, can arrive cut off. Each line starts with the `eventId`, so Claude can read the whole event with `get_event`.
- **Busy sources:** Monitor stops a command that prints too many lines. Filter by repository, actions or sender.
- **Permissions:** Claude Code asks before starting the command unless `Monitor` is allowed.

**Tested:** Claude Code 2.1.295 (interactive, Opus 5.5), with `watch` against a deployed bridge: Claude started the watch, went idle, and reported a GitHub comment within seconds of it being posted, without a prompt.

## Limits

- **`wait_for_event` waits only while Claude is working on your request.** Between turns nothing polls, and events wait in Event Gateway until the next call. Each call holds the turn for up to 45 seconds. Use `watch` (section 3) to hear about events between turns.
- **No plugin yet:** you name the command when asking Claude to watch. A Claude Code plugin that knows it is planned ([#26](https://github.com/hookdeck/mcp-events-bridge/issues/26)).
- **Latency:** an event reaches Claude about 2 seconds after Event Gateway receives it, sometimes up to 15 (see Polling in the README).
