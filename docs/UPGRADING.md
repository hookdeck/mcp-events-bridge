# Upgrading

## From 0.7 to 0.8

0.8 changes how events are delivered. Hookdeck Event Gateway now delivers each event straight from the service's source to each subscriber, and the bridge is no longer in the path. So the bridge stores subscriptions and callback URLs differently in Event Gateway, and data from 0.7 has to be migrated once. The bridge does it for you, after asking.

### What you do

1. **Install 0.8:** `npm install @hookdeck/mcp-events-bridge@0.8`.
2. **Run setup:** `npx mcp-events-bridge setup`. If the project has data from 0.7, setup says so and asks:

   ```text
   The bridge's data model in Event Gateway changed in 0.8. This project has 2 subscriptions and 1 callback URL from an earlier version.
   Subscribers keep their subscriptions and callback URLs. More: https://github.com/hookdeck/mcp-events-bridge/blob/main/docs/UPGRADING.md
   Migrate now? [Y/n]
   ```

   Answer `y` (or press Enter). It logs what it did, ending with `migrated <n> subscription(s) and <m> callback URL(s)`.
3. **Run serve** as before.
4. **Rename anything the 0.6 names still use** (see [Removed names](#removed-names)), and update any code that calls `create_tunnel_url` (see [Callback URLs](#callback-urls)).

`serve` checks for 0.7 data too. In a terminal it asks the same question. Without a terminal (a container, a CI job, a process manager) it doesn't start until the data is migrated, and says how:

```text
[bridge] The bridge's data model in Event Gateway changed in 0.8. This project has data from an earlier version, which must be migrated before serve starts.
Run `mcp-events-bridge setup` to migrate it, or start serve with --migrate to migrate it automatically.
```

`--migrate`, on `setup` or `serve`, migrates without asking. On a project with nothing to migrate it does nothing, so it's safe to leave on.

### On Fly.io, or any host without a terminal

Either:

- **Migrate before you deploy,** from your machine, with the deployment's settings: `BRIDGE_DEPLOYMENT=fly BRIDGE_INBOUND=http BRIDGE_PUBLIC_URL=https://<app>.fly.dev npx mcp-events-bridge setup`, then `fly deploy`; or
- **Migrate when the new version starts:** add `--migrate` to the command that starts `serve` (in a Dockerfile, for example `CMD ["npx", "mcp-events-bridge", "serve", "--migrate"]`), then `fly deploy`.

Each deployment in a Hookdeck project migrates its own inbound connections, so if a project has a local bridge and a deployed one, upgrade both. The first one to migrate moves every subscription in the project; the other only removes its own inbound connections.

### What the migration changes

| In 0.7 | In 0.8 |
| --- | --- |
| A subscription: a connection on the event's topic source (`bridge-out-<event>`), whose destination held the subscriber's secret | A connection on the service's source (`bridge-<source id>`), with the source's transformation, a filter for the event and arguments, dedupe and retry. Its destination signs every attempt with the subscriber's secret |
| Each service source had an inbound connection to each deployment (`bridge-<source id>-<deployment>`), and the bridge relayed every event | No inbound connection for events. Only Event Gateway's issue notifications reach the bridge |
| A callback URL from the bridge (`create_tunnel_url`) held a secret the bridge generated, and the bridge signed deliveries to it twice | A callback URL holds the client's secret, or none (pass-through) |

In detail:

- **Subscriptions** are re-created on their service's source with the same id, callback URL, secret, arguments and expiry, so subscribers don't notice: their refreshes and unsubscribes work as before. Expired subscriptions, and ones for events the config no longer offers, are removed (`removed subscription <id>: ...`). One the migration can't read is left as it was and logged; the subscriber's next refresh creates it again.
- **Callback URLs** created by a 0.7 bridge become pass-through, in place, so their URLs don't change. Event Gateway verifies nothing at a pass-through URL, and the receiver checks every delivery's signature, as every receiver should. The change takes about a minute to reach Event Gateway's edge; deliveries it refuses meanwhile are retried.
- **Topic sources** (`bridge-out-*`) are deleted once nothing is on them, and so are this deployment's inbound connections (`bridge-<source id>-<deployment>`) with their destinations.
- **Each service source gets a transformation,** `bridge-<source id>-envelope`, which setup and serve keep up to date. It builds the MCP event from the service's request, with the same mapping the bridge uses for poll mode and `get_event`.

Events sent to a source while you upgrade aren't lost: Event Gateway keeps every request, and subscribers can catch up with their cursors.

### Callback URLs

`create_tunnel_url` and `list_tunnel_urls` are now `create_callback_url` and `list_callback_urls`. `create_callback_url` takes an optional `secret`:

- **With the secret** your client subscribes with, Event Gateway answers the subscribe challenge and accepts only deliveries signed with that secret. One URL holds one secret, so to rotate the secret, create a new URL and subscribe with it.
- **Without one,** the URL is pass-through: Event Gateway neither answers the challenge nor verifies deliveries, so your receiver must check each signature. Use it for a client with a different secret for each subscription under one base URL, such as Hermes Agent and the AI SDK, Mastra and TanStack AI libraries. The bridge logs a warning when a subscription uses one.

`mcp-events-bridge callback-url create --agent <name> --name <name> [--port <port>] [--path <path>] [--secret-env <VAR>]` asks the running bridge for one from the command line, reading the secret from an environment variable so it never appears in a command line.

### Other changes you might notice

- **Secret rotation is immediate.** A refresh with a new secret replaces the old one at once: Event Gateway signs with one key per destination, so there's no grace window with both.
- **Deliveries are signed on every attempt** by Event Gateway, with a fresh timestamp, so retries no longer have to fit inside 5 minutes.
- **A webhook source without `eventId`** now uses a hash of the body as the event id (the first 32 hex characters of a SHA-256 of the canonical JSON body), not Event Gateway's request id. Set `eventId` if your sender retries with a changed body.
- **`source()` filters compare with the value's type,** as Event Gateway's filters do: `{ "quantity": 100 }` matches the number 100, not the string `"100"`.
- **Your own `defineSource` definitions** move their mapping into a `runtime` function, which runs inside Event Gateway's transformation as well as in the bridge: each event's `matches`, `eventId`, `occurredAt` and `summarize` are keyed by event name in what `runtime(runtimeConfig)` returns, and must be self-contained (no imports). An event's `accepts(args, summary)` is now `filter(args)`, which returns an Event Gateway filter on the event's `data`. `inboundDedupeFields` is gone. See [`src/core/sources/types.ts`](../src/core/sources/types.ts) and the built-in [Resend](../src/core/sources/resend.ts) source.
- **Setup's output** shows each source's transformation instead of its inbound connection: `source resend: https://hkdk.events/..., transformation bridge-resend-envelope, webhook existing`.
- **The bridge logs no line per event** (`... 1/1 published`): events don't pass through it. Each subscription's deliveries are under its connection, `mcp-sub-<id>`, in the Event Gateway dashboard.

### Removed names

Renamed in 0.6.0, with the old names kept as deprecated aliases until now. `providers` in the config and `providers add` fail with a message saying what to use; the removed exports no longer import, and the removed tools aren't listed.

| Removed | Use |
| --- | --- |
| `providers` in `bridge.config.ts` | `sources` |
| `webhook({ id, ... })` | `source({ type: 'webhook', id, ... })` |
| `defineProvider`, `ProviderDefinition`, `ProviderEvent` | `defineSource`, `SourceDefinition`, `SourceEvent` |
| `@hookdeck/mcp-events-bridge/providers` | `@hookdeck/mcp-events-bridge/sources` |
| `mcp-events-bridge providers add webhook <id>` | `mcp-events-bridge sources add <id> --type webhook` |
| The `list_providers` tool | `list_sources` |
| The `create_tunnel_url` and `list_tunnel_urls` tools | `create_callback_url` and `list_callback_urls` |
