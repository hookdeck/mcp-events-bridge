---
name: watch
description: Watch for events from the MCP Events bridge in the background, such as GitHub issues, comments, pull requests, reviews, pushes, releases and workflow runs, inbound email, or other webhooks, and tell the user as each one happens. Use when the user asks to watch, follow or monitor events, to be told when something happens in a repository or inbox, to stop watching, or what is being watched.
allowed-tools: Bash(events-bridge watches *)
---

# Watch MCP Events bridge events

This plugin runs a monitor for the whole session that follows this project's watch list. Each watch is an event name and its filters. When an event happens, you get a monitor notification, and you should tell the user about it, briefly, without being asked.

## Find event names and filters

Call the `events-bridge` MCP server's `list_providers` tool. Event names look like `github.issue_comment` or `resend.email.received`, and each event's filters are in its input schema (for GitHub: `repository` as owner/name, `actions` as a list, `sender`).

## Add, remove and list watches

Run these exactly as shown, one watch per event name:

```sh
events-bridge watches add <event name> --filter <key>=<value> --store "${CLAUDE_PLUGIN_DATA}" --project "${CLAUDE_PROJECT_DIR}"
events-bridge watches remove <event name> --store "${CLAUDE_PLUGIN_DATA}" --project "${CLAUDE_PROJECT_DIR}"
events-bridge watches remove --all --store "${CLAUDE_PLUGIN_DATA}" --project "${CLAUDE_PROJECT_DIR}"
events-bridge watches list --store "${CLAUDE_PLUGIN_DATA}" --project "${CLAUDE_PROJECT_DIR}"
```

- `--filter` is repeatable. A list value is JSON: `--filter 'actions=["opened","closed"]'`.
- `add` checks the name and filters with the bridge, and says why if they're wrong. `remove` without `--filter` removes every watch for that event name.
- The monitor picks up a change within a few seconds. A new watch starts from now. Don't start a watch with the Monitor tool yourself: the plugin's monitor already runs.
- Watches belong to this project and last between sessions. When a session starts, events from the last 24 hours that weren't reported yet arrive first.

To show past events instead, use the MCP server's `list_events` and `get_event` tools.

## When an event arrives

Each notification line is one event as JSON: `{"eventId", "name", "timestamp", "data"}`. Tell the user what happened in a sentence or two, with its link (`data.url`) when there is one.

Long lines are cut short in notifications. If a field looks cut off, read the whole event with the MCP server's `get_event` tool (its `name` and `eventId`, which are at the start of the line), and don't mention that you did.

A line like `{"problem": "..."}` means something is wrong. Tell the user:

- `stopped watching: ...` with a `watch`: that watch can't run (for example, the event no longer exists). Suggest removing it.
- `can't reach the bridge, still retrying: ...`: events will arrive once the bridge is reachable again. If it says `no MCP URL yet`, the plugin's MCP URL isn't set: the user sets it in `/plugin` (configure the MCP Events bridge plugin).
