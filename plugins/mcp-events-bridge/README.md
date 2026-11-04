# MCP Events bridge plugin for Claude Code

Watch events from your [MCP Events bridge](https://github.com/hookdeck/mcp-events-bridge), such as GitHub issues, comments, pull requests and workflow runs, inbound email through Resend, or other webhooks, and Claude tells you as each one happens, between prompts too.

Claude Code doesn't support MCP Events yet, so the plugin polls the bridge instead. It needs no public URL, so it works with a deployed bridge or a local one.

## What you need

- **A bridge you run yourself,** locally or deployed (Fly.io is the reference deployment), with a [Hookdeck](https://hookdeck.com) account and a project for it. There is no hosted bridge, and the plugin connects only to the endpoint you give it. Set one up with the [quick start](https://github.com/hookdeck/mcp-events-bridge#quick-start).
- **An interactive Claude Code session.** Plugin monitors don't run with `claude -p`.

## Install

```text
/plugin install mcp-events-bridge --marketplace hookdeck/mcp-events-bridge
```

Before Claude Code 2.1.275, add the marketplace first: `/plugin marketplace add hookdeck/mcp-events-bridge`, then `/plugin install mcp-events-bridge@hookdeck`.

When asked, enter:

- **Bridge MCP endpoint:** `https://<bridge>/mcp`, or `http://127.0.0.1:8080/mcp` for a local bridge.
- **Bridge MCP secret:** `BRIDGE_MCP_SECRET` from the bridge's `.env` (or its Fly secrets). Leave it empty only if the endpoint has the secret in it (`/mcp/<BRIDGE_MCP_SECRET>`).

Claude Code keeps both in secure storage. If you skip them (Esc), the plugin still installs, but can't reach the bridge. Set or change them with `/plugin configure mcp-events-bridge@hookdeck`, then start a new session.

Installing from Claude's plugin directory shows a warning that `events-bridge` is an unregistered MCP server. That's expected: it's your own bridge, at the endpoint you enter, not a server Hookdeck runs, so there's nothing to register.

## Use

In any project, ask Claude to watch for events your bridge offers, for example "watch `<owner>/<repo>` for new issues and comments", or "tell me when an email arrives". "What events can the bridge give me?" lists them, "what am I watching?" lists the project's watches, and "stop watching" removes them.

- **Per project, and between sessions:** each project has its own watch list. When a session starts, events that happened since the last session in that project arrive first, up to 24 hours old.
- **More than one session in a project:** each one is told about every event.
- **Busy sources:** Claude Code stops a monitor that prints too many lines. Filter by repository, actions or sender.

## What the plugin runs and sends

- **MCP server:** `events-bridge`, at the endpoint you set, with the secret sent as an `Authorization: Bearer` header. Its tools list the bridge's sources (`list_sources`) and read events (`list_events`, `get_event`, `poll_events`, `wait_for_event`).
- **Session start hook:** `scripts/session-start.sh` copies the endpoint and secret you set into the plugin's data directory (`mcp-url` and `mcp-secret`, readable only by you), because the monitor can't read secure storage. If one isn't set, it removes its file. It also tells the monitor where the data directory is, by adding `MCP_EVENTS_BRIDGE_PLUGIN_DATA` to the session's environment (`CLAUDE_ENV_FILE`).
- **Monitor:** for the whole session, `scripts/monitor.sh` runs `bin/events-bridge watch` on the plugin's data directory, which polls your bridge for the events this project watches and prints each one for Claude. `bin/events-bridge` runs the bridge's CLI at the plugin's version from npm (`npx -y @hookdeck/mcp-events-bridge@<version>`), from a directory under your temporary directory, so the first run downloads the package from the npm registry.
- **Skill:** `watch`, which tells Claude how to find event names and filters, and to add, list and remove watches with `events-bridge watches`.

The data directory, `~/.claude/plugins/data/mcp-events-bridge-hookdeck/` when installed from the `hookdeck` marketplace, holds the watch lists, a cursor per project, and the copy of the endpoint and secret. Uninstalling the plugin deletes it.

## Privacy

This section is the plugin's privacy policy: what it reads, keeps and sends.

- **What it reads:** events from your own bridge, which can include personal data, such as an inbound email's sender and subject. Claude reads them in your session. The plugin doesn't store them.
- **What it keeps on your machine:** in the plugin's data directory, the watch lists (the event names and filters you chose), a cursor per project, and a copy of the bridge endpoint and secret, readable only by you. Uninstalling the plugin deletes the directory.
- **Where it sends data:** only to the bridge endpoint you configure, a server you run, with your secret as an `Authorization: Bearer` header. It also downloads the bridge's CLI from the npm registry. The plugin sends nothing to Hookdeck or anyone else.
- **Your bridge:** you run it, so you control it and what it keeps. It doesn't store what Claude sends it. It uses your own Hookdeck project: Hookdeck Event Gateway receives the webhooks from your services, verifies them and keeps a record of each event, under the [Hookdeck privacy policy](https://hookdeck.com/privacy).

## More

- [Claude Code guide](https://github.com/hookdeck/mcp-events-bridge/blob/main/skills/mcp-events-bridge/references/claude-code.md): the plugin, and the poll tools without it.
- [Troubleshooting](https://github.com/hookdeck/mcp-events-bridge#troubleshooting).

## License

MIT. Made by [Hookdeck](https://hookdeck.com). The [MIT license](https://github.com/hookdeck/mcp-events-bridge/blob/main/LICENSE) is the plugin's terms of use. Your bridge's use of Hookdeck Event Gateway is under Hookdeck's [Terms of Use](https://hookdeck.com/terms).
