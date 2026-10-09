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

## 3. Watch in the background: the plugin

`wait_for_event` holds Claude's turn. To hear about events while Claude is idle or doing something else, install the MCP Events bridge plugin:

```text
/plugin install mcp-events-bridge --marketplace hookdeck/mcp-events-bridge
```

(Before Claude Code 2.1.275: `/plugin marketplace add hookdeck/mcp-events-bridge`, then `/plugin install mcp-events-bridge@hookdeck`.) Claude Code asks for the bridge's MCP URL and keeps it in secure storage. To set it from a script without it showing on screen, pipe it in: `printf '{"mcp_url":"%s"}' "$BRIDGE_MCP_URL" | claude plugin configure mcp-events-bridge@hookdeck --values-stdin`, then start a new session. The plugin adds the bridge as an MCP server, so you don't need step 1 as well.

Then ask, in any project:

> Watch hookdeck/hookdeck-demos for new issues and comments.

Claude adds the watches to the project's watch list, and the plugin's monitor, which runs `mcp-events-bridge watch` for the whole session, wakes Claude for each event. "Stop watching…" and "what am I watching?" work too.

- **Per project, and between sessions:** each project has its own watch list. When you start a session, events that happened since your last session in that project arrive first, up to 24 hours old.
- **Interactive sessions only:** plugin monitors don't run with `claude -p`.
- **More than one session in a project:** each one is told about every event.
- **Long events are shortened:** monitor notifications cut long lines short (seen at around 500 characters), so the plugin's skill has Claude read the whole event with `get_event`.
- **Busy sources:** Claude Code stops a monitor that prints too many lines. Filter by repository, actions or sender.
- **Where things are kept:** the watch lists and cursors, and a copy of the MCP URL for the monitor (readable only by you; plugin monitors can't read secure storage), are in the plugin's data directory, `~/.claude/plugins/data/mcp-events-bridge-hookdeck/`.

**Without the plugin**, ask Claude to run `watch` with its Monitor tool, which wakes the session on each line a command prints:

> In the background, watch hookdeck/hookdeck-demos for new issues and comments with `npx @hookdeck/mcp-events-bridge watch github.issues github.issue_comment --filter repository=hookdeck/hookdeck-demos`, and tell me about each one as it arrives.

`watch` needs the bridge's MCP URL: set `BRIDGE_MCP_URL` in the shell that starts Claude Code, or run it where `.env` has `BRIDGE_MCP_SECRET` (and `BRIDGE_PUBLIC_URL` for a deployed bridge). A Monitor watch expires after at most 30 minutes, and events between one watch and the next are missed. Claude Code asks before starting the command unless `Monitor` is allowed.

**Tested:** Claude Code 2.1.295 (interactive, Opus 5.5) against a deployed bridge. With the Monitor tool, Claude started the watch, went idle, and reported GitHub comments within seconds, without a prompt. With the plugin, installed from the marketplace (`claude plugin install`, the URL set with `--values-stdin`): the session-start hook wrote the URL file, the plugin's MCP server answered, the monitor started with the session, Claude added watches with filters from "watch… for new issues and comments", a comment woke the session (a reopen, filtered out, didn't), and a comment posted while no session was open arrived when the next one started.

## Limits

- **`wait_for_event` waits only while Claude is working on your request.** Between turns nothing polls, and events wait in Event Gateway until the next call. Each call holds the turn for up to 45 seconds. Use the plugin (section 3) to hear about events between turns.
- **Latency:** an event reaches Claude about 2 seconds after Event Gateway receives it, sometimes up to 15 (see Polling in the README).
