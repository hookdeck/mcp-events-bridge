# Changelog

## Unreleased

### Fixed

- **Docs:** the Claude Code plugin is tested with Claude Code 2.1.310, and the README's clients table says 2.1.294 to 2.1.310. The ChatGPT steps and the skill's troubleshooting say that an open ChatGPT chat shows a delivered event only after a reload, and that pausing ChatGPT's task unsubscribes it, so events while it's paused aren't delivered later (webhook replay is [#50](https://github.com/hookdeck/mcp-events-bridge/issues/50)).
- **The Claude Code plugin's monitor failed in the bridge's own repository** (`sh: mcp-events-bridge: command not found`, exit 127): there, npx ran the repository's own package instead of the pinned version. The plugin now runs the published CLI from an empty directory, so it works in any project. `MCP_EVENTS_BRIDGE_CLI` still runs in your directory.

## 0.6.0 (2026-10-26)

### Added

- **`source({ type })` for 163 services with an Event Gateway source type,** such as Stripe, Slack, Shopify, Twilio, Linear and Clerk: Event Gateway verifies each service's own signatures, including those that sign a timestamp with the body. The config is typed per source type, generated from Event Gateway's OpenAPI spec, so each type's credentials (for most, `secret`) are checked at compile time: `source({ type: 'stripe', secret: env('STRIPE_WEBHOOK_SECRET'), events: ['invoice.paid'], eventType: { field: 'type' }, eventId: { field: 'id' } })`. `sources add <id> --type stripe` creates the source and prints the entry. Where a service checks the URL when it's registered, the source type can answer: Event Gateway's `slack` source answers Slack's `url_verification` challenge itself. Tested with Stripe, Slack and Postmark requests. See [Sources](README.md#sources) ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).
- **A "Supported MCP clients" table in the README,** near the top ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).
- **The MCP endpoint takes `BRIDGE_MCP_SECRET` as `Authorization: Bearer`,** at `https://<bridge>/mcp`, so the secret stays out of URLs: out of request logs, and out of the client files that store URLs (Hermes's earlier pull request saved each subscription's URL in a file other users could read). Claude Code: `claude mcp add --transport http events-bridge https://<bridge>/mcp --header "Authorization: Bearer <BRIDGE_MCP_SECRET>"`. The URL form, `/mcp/<secret>`, still works, for ChatGPT, which can't send a header; `BRIDGE_MCP_SECRET_URL=false` turns it off. A missing or wrong token gets `401`. See [Security and limitations](README.md#security-and-limitations) ([#59](https://github.com/hookdeck/mcp-events-bridge/pull/59)).
- **`watch` sends the secret as a bearer token** to a URL ending `/mcp`, and builds that form by default from `BRIDGE_PUBLIC_URL` (or the local port) and `BRIDGE_MCP_SECRET`. `--secret-file` reads it from a file (with `--store`, `<store>/mcp-secret`). A URL with the secret in it still works ([#59](https://github.com/hookdeck/mcp-events-bridge/pull/59)).
- **Guides for the Vercel AI SDK, Mastra and TanStack AI,** whose MCP client libraries can subscribe to the bridge, each tested against it: the bearer header, the callback URL, and the receiver ([`references/library-clients.md`](skills/mcp-events-bridge/references/library-clients.md)) ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).
- **`setup` and `serve` warn about event descriptions over 400 characters** (`warning: fills.order.filled's description is 425 characters ...`), which ChatGPT has been reported to leave out. The built-in sources' descriptions are all shorter; this is for `source()` and `defineSource` ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).
- **The Claude Code plugin asks for the secret separately,** and sends it as `Authorization: Bearer`: its options are now the MCP endpoint (`https://<bridge>/mcp`) and the secret. An existing install, whose endpoint has the secret in it, keeps working with the secret field left empty ([#59](https://github.com/hookdeck/mcp-events-bridge/pull/59)).

### Changed

- **Providers are now sources.** "Source" is the common term for where events come from, and "provider" collides with model providers in AI SDKs. `bridge.config.ts` takes `sources`; `webhook({...})` is `source({ type: 'webhook', ... })`; `defineProvider` is `defineSource`; `@hookdeck/mcp-events-bridge/providers` is `/sources`; `providers add webhook <id>` is `sources add <id> --type webhook`; the `list_providers` tool is `list_sources`. The old names still work in 0.6.0: `setup` and `serve` print a warning for each one a config uses (``warning: `providers` in the config is now `sources` ...``), and they'll be removed in a later release. `resend()` and `github()` keep their names ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).
- **`setup` prints `source <id>: <URL>, ...`** for each source (it printed `provider <id>: source <URL>, ...`), and errors and logs say "source" ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).
- **`setup` and `serve` print the `/mcp` endpoint** with the header to send, and the URL with the secret in it only while the URL form is on ([#59](https://github.com/hookdeck/mcp-events-bridge/pull/59)).
- **The Hermes Agent guide covers released Hermes,** v0.22.5 and later, the first release with MCP Events (experimental in Hermes). It replaces the steps for Hermes's earlier pull request: the bridge is an MCP server in Hermes's `config.yaml` with `events: true` and the secret in an `Authorization: Bearer` header, callbacks go to Hermes's webhook listener through a tunnel URL on port 8644, and Hermes asks you to approve each subscription. Claude Code's guide uses `--header` too ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).

### Fixed

- **A tunnel URL's connection could outlive its source.** When the check for an agent's missed deliveries finished just after the bridge deleted that unused URL, it wrote the connection back, on the deleted source, and every later `serve` restarted `hookdeck listen` for it in a loop. The check no longer writes to a deleted URL, and `serve` deletes such a connection when it starts (`deleted tunnel URL agent-<agent>-<name>: its source was deleted`) ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).
- **Integers beyond 2^53 in a service's payload were rounded.** An int64 such as 4323372036854775807 reached subscribers as 4323372036854776000, because the bridge parsed request bodies as JavaScript numbers. It now reaches a callback URL as a string of its digits (`"4323372036854775807"`); other numbers are unchanged. Events read from Event Gateway's API, which rounds it, still carry it rounded: poll mode and `watch`, `get_event`, `list_events`, and callbacks caught up after downtime ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).

## 0.5.0 (2026-10-23)

Breaking, for clients that match on error code numbers, and for anyone relying on a `410` to end a subscription. Both changes follow [SEP-3415](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415), the MCP Events proposal.

### Changed

- **Error codes are SEP-3415's** ([#37](https://github.com/hookdeck/mcp-events-bridge/issues/37), [#55](https://github.com/hookdeck/mcp-events-bridge/pull/55)): `NotFound` is `-32023`, `Forbidden` `-32024`, `ResourceExhausted` `-32025`, `Unsupported` `-32026` and `CallbackEndpointError` `-32027` (they were `-32011` to `-32015`). The `data` shapes are unchanged. `watch` still treats `-32011` as `NotFound`, so it works with older bridges.
- **A `410` from a callback rejects that delivery only, and keeps the subscription** ([#29](https://github.com/hookdeck/mcp-events-bridge/issues/29), [#56](https://github.com/hookdeck/mcp-events-bridge/pull/56)). The bridge used to delete the subscription. A `410` still isn't retried; a receiver that has gone for good unsubscribes, or its subscription expires.
- **`events/stream` answers `Unsupported`** (`{ feature: "deliveryMode", value: "push" }`), or `NotFound` for an unknown event name, instead of method not found: the bridge offers webhook and poll delivery, not push ([#55](https://github.com/hookdeck/mcp-events-bridge/pull/55)).
- **Arguments too large to store answer `ResourceExhausted`** (`{ limit: "argumentsSize" }`), not `InvalidParams` ([#55](https://github.com/hookdeck/mcp-events-bridge/pull/55)).
- **The Claude Code plugin runs 0.5.0.**

### Fixed

- **Hermes Agent guide:** Hermes keeps the bridge's MCP URL, secret included, in a subscriptions file other users can read, so the guide now makes `$HERMES_HOME` private. It said the URL was only in Hermes's `.env`.
- **Docs:** how to set the plugin's MCP URL after skipping it ([#54](https://github.com/hookdeck/mcp-events-bridge/pull/54)); how the bridge conforms to SEP-3415, row by row ([#53](https://github.com/hookdeck/mcp-events-bridge/pull/53)); the transformation research ([#57](https://github.com/hookdeck/mcp-events-bridge/pull/57)); and the design for the next stage, where Event Gateway delivers each event itself and signs every attempt (`docs/ARCHITECTURE.md`).

## 0.4.0 (2026-10-09)

### Added

- **`mcp-events-bridge watch <event...>`** ([#45](https://github.com/hookdeck/mcp-events-bridge/pull/45)): polls a running bridge and prints one JSON line per event, from now on, for agents that wake on a command's output, such as Claude Code's Monitor tool. See [Polling](README.md#in-the-background-watch).
- **`watch --list <file>` and `mcp-events-bridge watches add|remove|list`** ([#47](https://github.com/hookdeck/mcp-events-bridge/pull/47)): `watch` follows a watch list as it changes, saves each watch's cursor, and resumes there next time (events up to 24 hours old). A watch that can't run, or a bridge that can't be reached, is reported on stdout as `{ "problem": ... }`.
- **Claude Code plugin** ([#26](https://github.com/hookdeck/mcp-events-bridge/issues/26), [#47](https://github.com/hookdeck/mcp-events-bridge/pull/47); `plugins/mcp-events-bridge`, installed with `/plugin install mcp-events-bridge --marketplace hookdeck/mcp-events-bridge`): a monitor that runs `watch` on the project's watch list for the whole session, a skill for "watch…", "stop watching…" and "what am I watching?", and the bridge as an MCP server. See [the guide](skills/mcp-events-bridge/references/claude-code.md#3-watch-in-the-background-the-plugin).

### Changed

- **`@modelcontextprotocol/client` is a dependency** (it was a dev dependency), for `watch`.

### Fixed

- **Docs:** ChatGPT keeps the events it can subscribe to from when the plugin was added, so refresh the plugin after upgrading the bridge or adding a provider ([#43](https://github.com/hookdeck/mcp-events-bridge/pull/43)). Connecting Claude Code, with screenshots ([#46](https://github.com/hookdeck/mcp-events-bridge/pull/46)).

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
