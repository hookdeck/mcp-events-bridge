# MCP Events bridge lite plugin for Claude Code

Wait for events from your [MCP Events bridge](https://github.com/hookdeck/mcp-events-bridge), such as GitHub issues, comments, pull requests and workflow runs, inbound email through Resend, or other webhooks, and Claude tells you as each one happens while it works on your request.

Claude Code doesn't support MCP Events yet, so Claude polls the bridge with its tools instead. It needs no public URL, so it works with a deployed bridge or a local one.

## Lite and full

This plugin is the version for Claude's plugin directory. It adds the bridge as an MCP server and a skill, and runs nothing in the background, so Claude hears about events only while it's working on a request.

To hear about events between prompts too, use the full plugin, `mcp-events-bridge`, instead. It runs a monitor for the whole session, which Claude's plugin directory doesn't accept from Hookdeck yet, so it's installed from Hookdeck's marketplace:

```text
/plugin install mcp-events-bridge --marketplace hookdeck/mcp-events-bridge
```

Install one or the other: both add the same MCP server.

## What you need

**A bridge you run yourself,** locally or deployed (Fly.io is the reference deployment), with a [Hookdeck](https://hookdeck.com) account and a project for it. There is no hosted bridge, and the plugin connects only to the endpoint you give it. Set one up with the [quick start](https://github.com/hookdeck/mcp-events-bridge#quick-start).

## Install

Install `mcp-events-bridge-lite` from Claude's plugin directory, or from Hookdeck's marketplace:

```text
/plugin install mcp-events-bridge-lite --marketplace hookdeck/mcp-events-bridge
```

Before Claude Code 2.1.275, add the marketplace first: `/plugin marketplace add hookdeck/mcp-events-bridge`, then `/plugin install mcp-events-bridge-lite@hookdeck`.

When asked, enter:

- **Bridge MCP endpoint:** `https://<bridge>/mcp`, or `http://127.0.0.1:8080/mcp` for a local bridge.
- **Bridge MCP secret:** `BRIDGE_MCP_SECRET` from the bridge's `.env` (or its Fly secrets). Leave it empty only if the endpoint has the secret in it (`/mcp/<BRIDGE_MCP_SECRET>`).

Claude Code keeps both in secure storage. If you skip them (Esc), the plugin still installs, but can't reach the bridge. Set or change them with `/plugin configure mcp-events-bridge-lite`, then start a new session.

The directory shows a warning that `events-bridge` is an unregistered MCP server. That's expected: it's your own bridge, at the endpoint you enter, not a server Hookdeck runs, so there's nothing to register.

## Use

Ask Claude to wait for events your bridge offers, for example "wait for new comments on issues in `<owner>/<repo>` and summarize each one", or "tell me when an email arrives". "What events can the bridge give me?" lists them, and "what happened in `<owner>/<repo>` today?" reads past events.

- **While Claude works on your request:** Claude calls `wait_for_event`, which returns as soon as there are events, or with none after up to 45 seconds, and calls it again. Between prompts, nothing waits, and events wait in Hookdeck Event Gateway until the next call.
- **Starts from now:** the first call returns only events after it.
- **Permissions:** Claude Code asks before each tool call unless you allow the bridge's tools, which only read events.

## What the plugin runs and sends

- **MCP server:** `events-bridge`, at the endpoint you set, with the secret sent as an `Authorization: Bearer` header. Its tools list the bridge's sources (`list_sources`) and read events (`list_events`, `get_event`, `poll_events`, `wait_for_event`).
- **Skill:** `wait`, which tells Claude how to find event names and filters, and to keep calling `wait_for_event` with the cursor it returned.

It has no hooks, monitors or commands, and runs nothing on your machine.

## Privacy

This section is the plugin's privacy policy: what it reads, keeps and sends.

- **What it reads:** events from your own bridge, which can include personal data, such as an inbound email's sender and subject. Claude reads them in your session. The plugin doesn't store them.
- **What it keeps on your machine:** nothing. Claude Code keeps the bridge endpoint and secret you enter in its secure storage.
- **Where it sends data:** only to the bridge endpoint you configure, a server you run, with your secret as an `Authorization: Bearer` header. The plugin sends nothing to Hookdeck or anyone else.
- **Your bridge:** you run it, so you control it and what it keeps. It doesn't store what Claude sends it. It uses your own Hookdeck project: Hookdeck Event Gateway receives the webhooks from your services, verifies them and keeps a record of each event, under the [Hookdeck privacy policy](https://hookdeck.com/privacy).

## More

- [Claude Code guide](https://github.com/hookdeck/mcp-events-bridge/blob/main/skills/mcp-events-bridge/references/claude-code.md): the poll tools, and the full plugin.
- [Troubleshooting](https://github.com/hookdeck/mcp-events-bridge#troubleshooting).

## License

MIT. Made by [Hookdeck](https://hookdeck.com). The [MIT license](https://github.com/hookdeck/mcp-events-bridge/blob/main/LICENSE) is the plugin's terms of use. Your bridge's use of Hookdeck Event Gateway is under Hookdeck's [Terms of Use](https://hookdeck.com/terms).
