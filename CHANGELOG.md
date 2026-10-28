# Changelog

## Unreleased

## 0.8.1 (2026-10-28)

### Fixed

- **The secret placeholder is `<BRIDGE_MCP_SECRET>`** in logs, `watch` messages, help text and docs (`/mcp/<BRIDGE_MCP_SECRET>`), as in the bridge's 401 message. It was `<secret>`, which a third-party scanner read as a hidden instruction to an agent ([#73](https://github.com/hookdeck/mcp-events-bridge/pull/73)).
- **Docs:** `GITHUB_TOKEN` can be the GitHub CLI's token (`gh auth token`, scope `repo`) as well as a fine-grained token with the Webhooks permission ([#72](https://github.com/hookdeck/mcp-events-bridge/pull/72)).
- **Wording:** the Resend and GitHub event descriptions in `events/list`, and `watch --help`, say "includes" rather than "carries" ([#72](https://github.com/hookdeck/mcp-events-bridge/pull/72)).

## 0.8.0 (2026-10-28)

Event Gateway now delivers each event to subscribers directly from the service's source, instead of through the bridge. Data from 0.7 is migrated once, after `setup` asks: see [Upgrading from 0.7](docs/UPGRADING.md).

### Breaking

- **Events reach subscribers without passing through the bridge.** Event Gateway delivers each event from the service's source and signs every attempt with the subscriber's secret, so events keep reaching subscribers while the bridge is stopped. Each subscription's deliveries are under its connection, `mcp-sub-<id>`, in the Event Gateway dashboard, and the bridge no longer logs a line per event. `setup` lists each source's transformation instead of an inbound connection (`source resend: ..., transformation bridge-resend-envelope, webhook existing`).
- **Data from 0.7 must be migrated.** `setup` finds it and asks first ("The bridge's data model in Event Gateway changed in 0.8. This project has 2 subscriptions and 1 callback URL from an earlier version. ... Migrate now? [Y/n]"). `serve` asks in a terminal, and otherwise refuses to start until it's migrated; `--migrate` on either migrates without asking. Subscriptions keep their id, callback URL, secret, arguments and expiry, so subscribers don't need to do anything; expired subscriptions, and ones for events the config no longer offers, are removed. Callback URLs from a 0.7 bridge keep their URLs and become pass-through. See [`docs/UPGRADING.md`](docs/UPGRADING.md).
- **`create_tunnel_url` and `list_tunnel_urls` are now `create_callback_url` and `list_callback_urls`.** `create_callback_url` takes an optional `secret`, the one your client subscribes with: Event Gateway then answers the subscribe challenge and accepts only deliveries signed with it, so rotating the secret means creating a new URL. Without a secret the URL is pass-through, for a client with a secret per subscription under one base URL (Hermes Agent, and the AI SDK, Mastra and TanStack AI libraries): the bridge trusts it because it created it, logs a warning when a subscription uses it (`warning: <name> is a pass-through callback URL: ...`), and your receiver must check every signature. Results include `passThrough`. Deliveries missed while your agent was offline are still retried automatically, each signed afresh.
- **The names deprecated in 0.6.0 are removed:** `providers` in the config, `webhook()`, `defineProvider` (and `ProviderDefinition`, `ProviderEvent`), the `/providers` import path, `providers add` and the `list_providers` tool. `providers` in the config and `providers add` fail with a message naming the replacement; the removed exports no longer import.
- **Custom source definitions map events with a `runtime`:** one self-contained function (no imports) that runs in Event Gateway as well as in the bridge, so the mapping has one copy. Each event's `matches`, `eventId`, `occurredAt` and `summarize` move into it, `accepts(args, summary)` becomes `filter(args)`, which returns a filter on the event's `data`, and `inboundDedupeFields` is gone. Only custom `defineSource` definitions change.
- **A webhook source without `eventId`** now uses a hash of the body as the event id (the first 32 hex characters of a SHA-256 of the canonical JSON body), not Event Gateway's request id, so a sender resending the same body gets the same id. **`source()` filters compare with the value's type:** `{ "quantity": 100 }` matches the number 100, not the string `"100"`.
- **Secret rotation is immediate.** A refresh with a new secret replaces the old one at once: deliveries are signed with the new secret only, with no grace window signed with both.

### Added

- **`mcp-events-bridge callback-url create|list`:** asks the bridge running on this machine for a callback URL (`--agent`, `--name`, `--port`, `--path`), reading the secret from an environment variable (`--secret-env <VAR>`) so it never appears in a command line. Without `--secret-env`, the URL is pass-through.
- **`--migrate` on `setup` and `serve`,** to migrate data from an earlier version without asking, for hosts without a terminal.
- **Bridges on different versions don't silently overwrite each other's event mappings.** If a newer version of the bridge set up a source in the same project, `setup` and `serve` say so and ask before replacing it (or migrate with `--migrate`); after an upgrade, the new version updates it and logs `updated the event mapping for source resend, written by 0.8.0, to 0.8.1`.
- **[`docs/UPGRADING.md`](docs/UPGRADING.md),** for upgrading from 0.7.

### Fixed

- **Each retry is signed afresh,** so a delivery retried after more than 5 minutes passes a receiver's timestamp check, and retries no longer have to fit inside that window (SEP-3415 requires a fresh signature on each attempt).
- **Replayed events are signed on every attempt, and retried, like live ones.** While a replay runs, every delivery, replayed or live, has the replay's start as its cursor, so a client that saves the latest cursor never skips events the replay hasn't sent yet.
- **Poll mode no longer depends on how Event Gateway routed each request:** it returns every matching event the source received, deduped by `eventId`.
- **Docs:** what pausing and resuming a ChatGPT task does, tested on 0.7.0: resuming subscribes again from now, with a new callback URL and no cursor, so events sent while it was paused aren't replayed (`list_events` still finds them). A delivered event can take a minute or so to show in ChatGPT. The README's ChatGPT screenshots are now light mode, captured on 0.7.0.

## 0.7.0 (2026-10-27)

### Added

- **Webhook cursors and replay** ([#50](https://github.com/hookdeck/mcp-events-bridge/issues/50), [#64](https://github.com/hookdeck/mcp-events-bridge/pull/64)). Every webhook delivery and subscribe response now includes a `cursor` (it was always `null`), in poll mode's format: a position in Event Gateway's history of the source's requests. Subscribing again with one, after an unsubscribe, an expiry or downtime, replays the events since it, alongside live ones (log: `replaying to <id> from the client's cursor`, then `replayed <n> event(s) to <id>`). A cursor older than Event Gateway's retention replays what's left, with `truncated: true`; a refresh of a live subscription treats its cursor as a no-op. OpenAI's guide says ChatGPT saves each subscription's cursor and sends it when it refreshes. `truncated` on subscribe is now true only for a cursor past retention (it was true for any cursor). Replayed events can repeat ones already delivered: receivers dedupe by `eventId`, as before.

### Fixed

- **Docs:** the Claude Code plugin is tested with Claude Code 2.1.310, and the README's clients table says 2.1.294 to 2.1.310. The ChatGPT steps and the skill's troubleshooting say that an open ChatGPT chat shows a delivered event only after a reload, and that pausing ChatGPT's task unsubscribes it ([#62](https://github.com/hookdeck/mcp-events-bridge/pull/62), [#65](https://github.com/hookdeck/mcp-events-bridge/pull/65)).
- **The Claude Code plugin's monitor failed in the bridge's own repository** (`sh: mcp-events-bridge: command not found`, exit 127): there, npx ran the repository's own package instead of the pinned version. The plugin now runs the published CLI from an empty directory, so it works in any project. `MCP_EVENTS_BRIDGE_CLI` still runs in your directory ([#65](https://github.com/hookdeck/mcp-events-bridge/pull/65)).

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
- **Integers beyond 2^53 in a service's payload were rounded.** An int64 such as 4323372036854775807 reached subscribers as 4323372036854776000, because the bridge parsed request bodies as JavaScript numbers. It now reaches a callback URL as a string of its digits (`"4323372036854775807"`); other numbers are unchanged. Events read from Event Gateway's API, which rounds it, still have it rounded: poll mode and `watch`, `get_event`, `list_events`, and callbacks caught up after downtime ([#60](https://github.com/hookdeck/mcp-events-bridge/pull/60)).

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
- **A local `setup` logs the Hookdeck CLI in** to the bridge's project in `.hookdeck/config.toml`, as `serve` already did, so `hookdeck` commands run in the bridge's directory use that project from the start. Without the CLI, it says so and continues (`serve` still needs it).
- **`setup` prints a generated `BRIDGE_MCP_SECRET=` line on its own,** ready to paste into `.env`; the Fly.io hint is only shown for HTTP inbound.

### Fixed

- **The MCP server's version** (`serverInfo.version`) is the package version, not `0.0.0`.

## 0.1.0 (2026-10-06)

First release: Resend and GitHub providers, MCP Events webhook delivery through Hookdeck Event Gateway, `setup` and `serve`, and deployment to Fly.io.
