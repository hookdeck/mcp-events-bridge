# Changelog

## Unreleased

### Added

- **`mcp-events-bridge watch <event...>`:** polls a running bridge and prints one JSON line per event, from now on, for agents that wake on a command's output, such as Claude Code's Monitor tool. See [Polling](README.md#in-the-background-watch).

## 0.3.0 (2026-10-09)

### Added

- **Poll mode** ([#26](https://github.com/hookdeck/mcp-events-bridge/issues/26)): `events/poll`, for clients that can't receive webhooks, answered from Event Gateway's request history with no event store in the bridge. `events/list` offers `poll`. See [Polling](README.md#polling).
- **`poll_events` and `wait_for_event` tools,** the same polling for MCP clients without MCP Events support, such as Claude Code: `wait_for_event` returns as soon as there are events, or after up to 50 seconds.

### Fixed

- **GitHub: switching from manual mode to automatic registration no longer deletes the webhooks `setup` just created.** The old registration was removed by source URL, which the new webhooks share.

### Changed

- **The capability is also advertised as `extensions["io.modelcontextprotocol/events"]`,** as in the MCP Events SEP (SEP-3415), alongside `events`.

## 0.2.1 (2026-10-08)

### Fixed

- **`setup` prints the generated `BRIDGE_MCP_SECRET=` line unindented,** so copying it as printed doesn't add spaces to `.env`.
- **`providers add webhook --write-config` creates `bridge.config.ts`** when there isn't one, instead of printing the entry.
- **Docs:** `BRIDGE_DEPLOYMENT` doesn't keep bridges sharing a Hookdeck project apart (they share provider sources, subscriptions and tunnel URLs): give each bridge its own project ([#13](https://github.com/hookdeck/mcp-events-bridge/issues/13)). The tunnel URL reference shows the headers a hand-written MCP client sends.

### Changed

- **Published from GitHub Actions** with [npm provenance](https://docs.npmjs.com/generating-provenance-statements), when a GitHub Release is created.

## 0.2.0 (2026-10-08)

### Breaking

0.2.0 breaks compatibility with 0.1.0 deliberately, with no migration paths: 0.1.0 was an early demo release, as far as we know used only by this project.

- **Event names are `{instance id}.{event}`** ([#15](https://github.com/hookdeck/mcp-events-bridge/issues/15)): the provider instance's `id`, then the provider's own name for the event. `email.received` is now `resend.email.received`; GitHub's names are unchanged with the default `id` (`github.issues`), and an instance with another `id` offers `<id>.issues`. Two instances can now offer the same event.
- **No migration from 0.1.0.** Subscriptions to renamed events get nothing (`serve` logs each subscription to an event it doesn't offer): agents, ChatGPT included, subscribe again with a name from `events/list`. Configs take the provider's own event names: `events: ['issues']`, not `['github.issues']`.
- **`get_event(name, eventId)`:** `name` is required. An event id is the provider's own, so two instances can share one; both are in every delivery and in `list_events`.
- **`list_recent_events` is `list_events`.** With a name, it searches only that instance.
- **`list_providers`** returns each provider's events as MCP names (`resend.email.received`, not `email.received`).

### Added

- **Local agents** ([#12](https://github.com/hookdeck/mcp-events-bridge/pull/12)): a local bridge gives agents on the same machine public tunnel URLs (`create_tunnel_url`, `list_tunnel_urls`), runs and supervises `hookdeck listen` for them, and re-sends deliveries they missed while `listen` was down. A tunnel URL covers the paths under it, for agents that build callback URLs from one base URL.
- **Inbound recovery:** a local bridge retries provider events that reached Event Gateway while it was stopped, and restarts its own `hookdeck listen` if it stops.
- **Generic webhooks** ([#14](https://github.com/hookdeck/mcp-events-bridge/pull/14)): `webhook({ id, verification, events, ... })` relays webhooks from any HTTP sender, verified by Event Gateway with HMAC, Standard Webhooks, Basic auth or an API key. `mcp-events-bridge providers add webhook <id>` creates the source, prints its URL and the config entry, and adds the secret's variable to `.env` (`--write-config` edits `bridge.config.ts`).
- **Agent skill:** [`skills/mcp-events-bridge`](skills/mcp-events-bridge/SKILL.md) (`npx skills add hookdeck/mcp-events-bridge`), also in the npm package.
- **Hermes Agent guide** (experimental): [`references/hermes-agent.md`](skills/mcp-events-bridge/references/hermes-agent.md) runs Hermes's MCP Events pull request against a local bridge.

### Changed

- **`deployment` is optional.** It defaults to `BRIDGE_DEPLOYMENT`, then `local` with CLI inbound or `public` with HTTP inbound. A config that sets it, as 0.1.0's examples did, keeps its resource names.
- **`setup` exits 1** when a webhook secret isn't set yet, after setting up everything else, and labels the MCP endpoint "MCP URL".
- **Inbound bodies that aren't JSON** are answered `200` and ignored, so Event Gateway doesn't retry them.
- **`BRIDGE_MCP_SECRET` must be URL-safe** (letters, digits, `-`, `_`, `.`, `~`): it's part of the MCP URL, so `setup` and `serve` refuse anything else. Secrets `setup` generates, in 0.1.0 too, always are.
- **A local `setup` logs the Hookdeck CLI in** to the bridge's project in `.hookdeck/config.toml`, as `serve` already did, so `hookdeck` commands run in the bridge's directory use that project from the start. Without the CLI, it says so and carries on (`serve` still needs it).
- **`setup` prints a generated `BRIDGE_MCP_SECRET=` line on its own,** ready to paste into `.env`; the Fly.io hint is only shown for HTTP inbound.

### Fixed

- **The MCP server's version** (`serverInfo.version`) is the package version, not `0.0.0`.

## 0.1.0 (2026-10-06)

First release: Resend and GitHub providers, MCP Events webhook delivery through Hookdeck Event Gateway, `setup` and `serve`, and deployment to Fly.io.
