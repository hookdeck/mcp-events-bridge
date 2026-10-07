# Changelog

## 0.2.0 (unreleased)

### Breaking

- **Event names are `{instance id}.{event}`** ([#15](https://github.com/hookdeck/mcp-events-bridge/issues/15)): the provider instance's `id`, then the provider's own name for the event. `email.received` is now `resend.email.received`; GitHub's names are unchanged with the default `id` (`github.issues`), and an instance with another `id` offers `<id>.issues`. Two instances can now offer the same event. Existing subscriptions to old names get nothing: `serve` logs each one with the name to subscribe to, and agents (ChatGPT included) need to subscribe again.

### Added

- **Local agents** ([#12](https://github.com/hookdeck/mcp-events-bridge/pull/12)): a local bridge gives agents on the same machine public tunnel URLs (`create_tunnel_url`, `list_tunnel_urls`), runs and supervises `hookdeck listen` for them, and re-sends deliveries they missed while `listen` was down. A tunnel URL covers the paths under it, for agents that build callback URLs from one base URL.
- **Inbound recovery:** a local bridge retries provider events that reached Event Gateway while it was stopped, and restarts its own `hookdeck listen` if it stops.
- **Generic webhooks** ([#14](https://github.com/hookdeck/mcp-events-bridge/pull/14)): `webhook({ id, verification, events, ... })` relays webhooks from any HTTP sender, verified by Event Gateway with HMAC, Standard Webhooks, Basic auth or an API key. `mcp-events-bridge providers add webhook <id>` creates the source, prints its URL and the config entry, and adds the secret's variable to `.env` (`--write-config` edits `bridge.config.ts`).
- **`list_providers`** reports MCP event names and each provider's subscription count.
- **Agent skill:** [`skills/mcp-events-bridge`](skills/mcp-events-bridge/SKILL.md) (`npx skills add hookdeck/mcp-events-bridge`), also in the npm package.

### Changed

- **`deployment` is optional.** It defaults to `BRIDGE_DEPLOYMENT`, then `local` with CLI inbound or `public` with HTTP inbound. A config that sets it, as 0.1.0's examples did, keeps its resource names.
- **`setup` exits 1** when a webhook secret isn't set yet, after setting up everything else, and labels the MCP endpoint "MCP URL".
- **Inbound bodies that aren't JSON** are answered `200` and ignored, so Event Gateway doesn't retry them.

## 0.1.0 (2026-10-06)

First release: Resend and GitHub providers, MCP Events webhook delivery through Hookdeck Event Gateway, `setup` and `serve`, and deployment to Fly.io.
