# Codex and Cursor with the bridge

Codex and Cursor's CLI poll the bridge with its tools, as Claude Code does without the plugin: the agent calls `wait_for_event`, which returns as soon as there are events, and calls it again with the `cursor` it returned. Services send webhooks to the bridge's Event Gateway sources and the bridge reads them from Event Gateway, so neither the agent nor the bridge needs a public URL of its own, and a local bridge works as well as a deployed one.

Both send `BRIDGE_MCP_SECRET` as an `Authorization: Bearer` header to the bridge's `/mcp` endpoint, read from an environment variable, so the secret stays out of their config files. Run them where `BRIDGE_MCP_SECRET` is set:

```sh
export BRIDGE_MCP_SECRET=...   # the bridge's, from its .env
```

Run without a person to approve each call, both refuse the bridge's tools until you allow them. Each section below says how.

| Client | Tested | Run as | Allow the tools with |
| --- | --- | --- | --- |
| [Codex](#codex) | codex-cli 0.154.0 | `codex exec` | `default_tools_approval_mode = "approve"` on the server |
| [Cursor](#cursor) | `cursor-agent` 2026.11.05-86047df (Cursor's CLI) | `cursor-agent -p --trust --approve-mcps` | A tool allowlist in `.cursor/cli.json` |

**Tested:** each against a deployed bridge running 0.8.1 on 5 Nov 2026, with the poll tools (`wait_for_event`, called again with the `cursor` it returned) and the GitHub source's `github.issue_comment` events. Interactive Codex and the Cursor editor's agent weren't tested. Whether the tool annotations added in 0.9.0 (`readOnlyHint`) remove the need for Codex's approval mode or Cursor's allowlist hasn't been tested either.

## Codex

### 1. Add the bridge as an MCP server

```sh
codex mcp add events-bridge --url https://<bridge>/mcp --bearer-token-env-var BRIDGE_MCP_SECRET
```

For a local bridge, use the endpoint `serve` prints (`http://127.0.0.1:8080/mcp`). This writes the server to Codex's `config.toml` (`~/.codex/config.toml` by default), naming the environment variable, not the secret.

### 2. Allow the bridge's tools

`codex exec` refuses every call to the bridge ("MCP tool call requires approval, but approval policy is never") until the server's tools are approved. Add `default_tools_approval_mode` to the server's entry:

```toml
[mcp_servers.events-bridge]
url = "https://<bridge>/mcp"
bearer_token_env_var = "BRIDGE_MCP_SECRET"
default_tools_approval_mode = "approve"
```

This approves every tool the bridge offers. All are read-only except `create_callback_url`, which a local bridge offers and which creates a callback URL in Event Gateway; a deployed bridge doesn't offer it.

### 3. Ask for events

```sh
codex exec "Wait for new comments on issues in <owner>/<repo> (github.issue_comment, repository <owner>/<repo>) and summarize each one."
```

Codex calls `wait_for_event` and keeps calling it with the `cursor` it returned. Ask "what events can the bridge give me?" for the names and filters your bridge offers.

**Tested:** codex-cli 0.154.0, `codex exec`, against the deployed bridge running 0.8.1, on 5 Nov 2026. Codex called `wait_for_event` in a loop without being told how, and received 2 of 2 `github.issue_comment` events: about 3 s after each webhook when a call was waiting, and about 6 s when the webhook arrived between calls, with none lost. Calls with no events returned after about 44 s, well under Codex's default MCP tool timeout of 300 s. If you set a shorter one for the server (`tool_timeout_sec`), keep it above 50 s, the longest `wait_for_event` waits. Interactive Codex wasn't tested.

## Cursor

Tested with Cursor's CLI, `cursor-agent`, not the agent in the Cursor editor.

### 1. Add the bridge as an MCP server

In the project's `.cursor/mcp.json`:

```json
{ "mcpServers": { "events-bridge": { "url": "https://<bridge>/mcp", "headers": { "Authorization": "Bearer ${env:BRIDGE_MCP_SECRET}" } } } }
```

For a local bridge, use the endpoint `serve` prints (`http://127.0.0.1:8080/mcp`). Cursor reads `${env:BRIDGE_MCP_SECRET}` from the environment, so the file holds no secret and can be committed.

### 2. Allow the bridge's tools

Non-interactive `cursor-agent` needs three approvals:

- **`--trust`:** trusts the workspace.
- **`--approve-mcps`:** approves the project's MCP servers.
- **A tool allowlist** in the project's `.cursor/cli.json` (see Cursor's [permissions reference](https://cursor.com/docs/cli/reference/permissions)). Without it, every call to the bridge is rejected ("User rejected MCP").

```json
{
  "permissions": {
    "allow": [
      "Mcp(events-bridge:wait_for_event)",
      "Mcp(events-bridge:poll_events)",
      "Mcp(events-bridge:list_events)",
      "Mcp(events-bridge:get_event)",
      "Mcp(events-bridge:list_sources)"
    ],
    "deny": []
  }
}
```

The list leaves out `create_callback_url` and `list_callback_urls`, which polling doesn't use.

### 3. Ask for events

```sh
cursor-agent -p --trust --approve-mcps "Wait for new comments on issues in <owner>/<repo> (github.issue_comment, repository <owner>/<repo>) and summarize each one."
```

Cursor calls `wait_for_event` and calls it again with the `cursor` it returned.

**Tested:** `cursor-agent` 2026.11.05-86047df, with `-p --trust --approve-mcps` and the allowlist above, against the deployed bridge running 0.8.1, on 5 Nov 2026. It received 2 of 2 `github.issue_comment` events, about 4.5 s and 5.5 s after each webhook. Calls with no events returned after about 49 s, with no timeout. The Cursor editor's agent wasn't tested.

## Using the events

- **Start from now:** a first call without a cursor returns only events after it. For events that already happened, ask for them: the agent uses `list_events` and `get_event`.
- **Repeats:** delivery is at least once. If the same `eventId` comes back, it's the same event.
- **Only during a run:** `wait_for_event` waits only while the agent is working on your request. Between runs, events wait in Event Gateway; a new run without a cursor starts from now, so ask for missed ones with `list_events`.
- **Latency:** an event reaches the agent about 2 seconds after Event Gateway receives it, sometimes up to 15 (see Polling in the README), plus the time until the agent's next call if none is waiting.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Codex: "MCP tool call requires approval, but approval policy is never" | Add `default_tools_approval_mode = "approve"` to `[mcp_servers.events-bridge]` (Codex, step 2) |
| Cursor: "User rejected MCP" | Add the allowlist to `.cursor/cli.json`, and run with `--trust --approve-mcps` (Cursor, step 2) |
| The server doesn't connect, or the bridge answers 401 | `BRIDGE_MCP_SECRET` must be set in the shell that starts the agent, and match the bridge's |
