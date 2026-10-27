---
name: mcp-events-bridge
description: "Sets up and runs the MCP Events bridge (npm @hookdeck/mcp-events-bridge), an MCP server that turns webhooks from Resend, GitHub, Stripe, Slack and other services, or any HTTP sender, into MCP Events that agents subscribe to, with Hookdeck Event Gateway receiving, verifying and delivering them. Use when an agent should react to events instead of polling, when connecting ChatGPT or an agent on a laptop to webhook events, when adding a source (a service such as Stripe, or any webhook sender, including registering the URL with it by hand), or when troubleshooting setup, serve or deliveries."
---

# MCP Events bridge

The bridge is an MCP server. Agents call `events/subscribe` on it (the [MCP Events](https://developers.openai.com/plugins/build/mcp-events) extension) and receive signed webhook deliveries when something happens. Hookdeck Event Gateway receives each source's webhooks, verifies them, turns each into an MCP Event and delivers it to each subscriber, signed and with retries; the bridge handles subscriptions and manages one Event Gateway connection per subscription. Events don't pass through the bridge.

Full reference: the [README](https://github.com/hookdeck/mcp-events-bridge#readme). This skill is the procedure; follow it in order and check each step's success signal before moving on.

## Rules

- **Credentials come from the user.** Ask for the Hookdeck project's API key and signing secret (Project settings > Secrets) and any service's key or webhook secret; never create accounts. Some commands print secrets (`setup` prints the MCP URL): never repeat a secret in your replies, and never print `.env`.
- **`BRIDGE_MCP_SECRET` is a credential.** Agents send it as `Authorization: Bearer <BRIDGE_MCP_SECRET>` to the `/mcp` endpoint; only clients that can't send a header (ChatGPT) use the URL with it in (`/mcp/<BRIDGE_MCP_SECRET>`). Share it only with the agent being connected.
- **One bridge per Hookdeck project.** Bridges in one project share the sources, subscriptions and callback URLs, and act on each other's.
- **Upgrading from 0.7:** `setup` asks to migrate the project's subscriptions and callback URLs; answer yes. Without a terminal, `serve --migrate` does it. See [docs/UPGRADING.md](https://github.com/hookdeck/mcp-events-bridge/blob/main/docs/UPGRADING.md).

## 1. Decide where the bridge runs

| | Local (default) | Deployed |
|---|---|---|
| Runs | On the agent's machine | On a host with a public URL (Fly.io in the README) |
| Event Gateway's notifications arrive through | The Hookdeck CLI (`hookdeck listen`, started by the bridge) | HTTPS, at the bridge's public URL |
| Agents it can serve | Agents on the same machine (through callback URLs it creates), and any agent that polls | Cloud agents such as ChatGPT, and any agent that polls |
| Notifications connection | `bridge-notifications-local` | `bridge-notifications-public`, or `BRIDGE_DEPLOYMENT` |

ChatGPT needs a deployed bridge (or a tunnel to a local one). For deployment, follow the README's "Deploy to Fly.io" section, then continue at step 3.

## 2. Set up a local bridge

Needs Node 22.12+ and the [Hookdeck CLI](https://hookdeck.com/docs/cli) (`hookdeck version` prints a version).

```sh
mkdir my-bridge && cd my-bridge
npm init -y && npm pkg set type=module
npm install @hookdeck/mcp-events-bridge
printf 'node_modules/\n.env\n.hookdeck/\n' > .gitignore
```

Create `bridge.config.ts` with the sources the user wants (step 3 adds more later):

```ts
import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
import { resend } from '@hookdeck/mcp-events-bridge/sources';

export default defineConfig({
  sources: [resend({ apiKey: env('RESEND_API_KEY') })],
});
```

For only a `source()` (Stripe, any webhook sender), start with `sources: []` and import only `defineConfig`; step 3 adds the entry and its imports.

Write `.env` with `HOOKDECK_API_KEY`, `HOOKDECK_SIGNING_SECRET` and each source's variables (README "Configuration" lists them all). Then:

```sh
npx mcp-events-bridge setup
```

- **Success:** a line per source (`source resend: https://hkdk.events/..., transformation bridge-resend-envelope, webhook registered`; on a re-run, `updated` or `existing`), then the MCP endpoint. Exit code 0. With a local bridge it also logs the Hookdeck CLI in to the bridge's project in `.hookdeck/config.toml`, so `hookdeck` commands run in this directory use that project.
- **First run:** it generates an MCP secret and prints a `BRIDGE_MCP_SECRET=...` line. Add that line to `.env` as printed. `setup` prints the full MCP URL, secret included, on every run: don't repeat it in your replies or write it anywhere but `.env`.
- **Exit code 1 with "Setup isn't complete":** a `source()`'s secret is missing (step 3). Everything else was set up.
- **Data from 0.7:** setup says "The bridge's data model in Event Gateway changed in 0.8" and asks `Migrate now? [Y/n]`. Answer `y`; it ends with `migrated <n> subscription(s) and <m> callback URL(s)`. Declining exits 1, and `serve` won't start until it's migrated.

```sh
npx mcp-events-bridge serve
```

- **Success:** `[bridge] hookdeck listen connected: ...` and `[bridge] MCP endpoint: http://127.0.0.1:8080/mcp with Authorization: Bearer <BRIDGE_MCP_SECRET>, or http://127.0.0.1:8080/mcp/<BRIDGE_MCP_SECRET>`. Keep it running; stop it with Ctrl-C (or `kill` its PID), which also stops its `hookdeck listen`.
- It restarts `hookdeck listen` if it stops. Events don't pass through the bridge (Event Gateway delivers them), so a stopped bridge loses none; `listen` carries Event Gateway's issue notifications and local agents' deliveries.

## 3. Add sources

Every event is named **`{source id}.{event}`**: the source `id` (by default its type) and the service's own event name, e.g. `resend.email.received`, `github.issues`, `stripe.invoice.paid`, `fills.order.filled`. `events/list` shows them.

- **Resend, GitHub:** add `resend({...})` or `github({...})` to `sources` (README "Sources" has every option), add the variables to `.env`, run `setup` again. `setup` registers the webhook itself.
- **Any other service or sender, registered by hand:** a `source({ type })`. For a service with an Event Gateway source type (Stripe, Slack, Shopify and 160 more), `--type stripe`: Event Gateway checks the service's signatures. For anything else, `--type webhook`, verified with HMAC (the default), Standard Webhooks, Basic auth or an API key.
  1. `npx mcp-events-bridge sources add <id> --type <type> --event <sender's event name> [--event-type-field type] [--event-id-field id | --event-id-header x-delivery-id] [--filter symbol]` (`sources add --help` lists every option). It prints the source URL, adds the credential variables to `.env` (`<ID>_WEBHOOK_SECRET=` for a signing secret), and prints a `source({...})` entry.
  2. Paste the entry into `sources` in `bridge.config.ts` (or rerun with `--write-config`; it creates `bridge.config.ts` if there isn't one, and refuses configs it can't edit safely and prints the entry instead).
  3. Register the printed URL with the sender. Put the secret it gives you (or one you generate, e.g. `openssl rand -hex 32`, for a server the user runs) in `.env`. For HMAC, the key is that string exactly as in `.env`, not hex- or base64-decoded.
  4. Run `setup` (exit 0 now; a new secret can take about a minute to take effect), then restart `serve`. Until the secret is set, `serve` refuses to start: the source would accept unverified requests.

## 4. Connect an agent

- **ChatGPT (deployed bridge):** needs Developer mode on (ChatGPT Plus or above). ChatGPT > Plugins > Add > Create MCP App, URL `https://<bridge>/mcp/<BRIDGE_MCP_SECRET>`, No Authentication (ChatGPT can't send an `Authorization` header, so it takes the secret in the URL). Then ask it, in a Work chat, to tell you about new events (e.g. emails from a sender).
- **An agent on the same machine as a local bridge**, which implements MCP Events webhook delivery itself:
  1. It gets a callback URL from the bridge: the `create_callback_url` tool (`agent`, `name`, `port`, `path`, `secret`), or `npx mcp-events-bridge callback-url create --agent <a> --name <n> --port <p> [--path /] [--secret-env <VAR>]` from the bridge's directory. With the `whsec_` secret the agent will subscribe with, Event Gateway answers the challenge and accepts only deliveries signed with it (one URL, one secret). Without a secret, the URL is pass-through: for an agent with a secret per subscription under one base URL (use `path: '/'`), whose receiver must verify every delivery. Either way it's a public `https://hkdk.events/...` URL, and the bridge runs `hookdeck listen` to the agent's port.
  2. It calls `events/subscribe` with that URL (or a path under it) and its secret.
  3. What the agent's receiver must do: [references/receiving-deliveries.md](references/receiving-deliveries.md).
- **Hermes Agent** (v0.22.5 or later; experimental in Hermes): follow [references/hermes-agent.md](references/hermes-agent.md).
- **Code built on the Vercel AI SDK, Mastra or TanStack AI** (their MCP client libraries; experimental): follow [references/library-clients.md](references/library-clients.md).
- **Agents without MCP Events support** (Claude Code, Codex, Cursor): add the bridge as an HTTP MCP server (Claude Code: `claude mcp add --transport http events-bridge <bridge>/mcp --header "Authorization: Bearer <BRIDGE_MCP_SECRET>"`; see [references/claude-code.md](references/claude-code.md)) and use the poll tools, which need no public URL:
  - `wait_for_event` (`name`, `arguments`, `cursor`): waits up to 45 s and returns as soon as there are events. Call it again with the `cursor` it returned to keep waiting.
  - `poll_events` (same, plus `maxEvents`, `maxAgeMs`): returns at once; call again after `nextPollMs`, or at once when `hasMore` is true.
  - Without a cursor, both start from now. Events can repeat: dedupe by `eventId`. For events that already happened, use `list_events` and `get_event`.
- **Claude Code, between prompts:** the poll tools only wait while Claude is working on a request. To be told about events while it's idle, the user installs the plugin, `/plugin install mcp-events-bridge --marketplace hookdeck/mcp-events-bridge` (it asks for the MCP URL), then says "watch … for …"; see [references/claude-code.md](references/claude-code.md), section 3. Other agents that wake on a background command's output can run `npx @hookdeck/mcp-events-bridge watch <event...> [--filter key=value]`, which prints one JSON line per event.
- **Clients that implement MCP Events poll mode** call `events/poll` (same arguments and cursor) instead of subscribing.

## 5. Verify

1. Subscribe an agent (step 4), and check that `serve` logs `subscribed sub_... until ...`.
2. Trigger a real event: send an email to the Resend receiving address, open a GitHub issue, or have the sender post one.
3. The agent gets it. Events don't pass through the bridge, so `serve` logs nothing for it, except for a local agent: `[listen] agent <agent>: ... POST http://localhost:<port><path>`.
4. In the Event Gateway dashboard, the subscription's connection, `mcp-sub-<id>` on `bridge-<source id>`, shows each request: delivered, with its attempts, or `FILTERED` when the subscription's filter or event type didn't match.
5. The `list_sources` tool shows each source's type, events, and how many subscriptions each has.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `setup` exits 1: "Setup isn't complete", then `<id>: set <VAR>` | A webhook secret isn't set | Register the URL, put the secret in `.env`, run `setup` |
| `serve`: "Not set: <VAR> (source <id>)" | Same | Same, then `serve` |
| `serve`: "Event Gateway isn't set up for deployment ..." | `setup` hasn't run with this deployment name and inbound mode | Run `setup` with the same `BRIDGE_DEPLOYMENT` and `BRIDGE_INBOUND` |
| Log: `subscription ... is for "...", which this bridge doesn't offer` | The source was removed, its `id` renamed, or the subscription is from 0.1.0; or it belongs to another bridge in the same Hookdeck project | The agent subscribes again, to a name from `events/list`; ignore another bridge's |
| `events/subscribe` fails: "Unknown event" | Old or wrong name | Use a name from `events/list` |
| A sender gets 401 | Wrong signature, header, encoding or secret | Match the source's `verification` or secret; a new secret can take about a minute |
| An agent doesn't get an event | Its filter or event type didn't match, or its callback is failing | Check the subscription's connection, `mcp-sub-<id>`, in the Event Gateway dashboard (`FILTERED`, or failed attempts), and its name and arguments |
| An event arrives after a minute or two | `hookdeck listen` occasionally takes ~30s to connect; Event Gateway occasionally queues a CLI delivery | Wait; missed deliveries are retried by the bridge |
| The same event twice | A retry, or a replay | Receivers dedupe by `webhook-id` |
| `serve` exits: "... must be migrated before serve starts" | Data from 0.7, and no terminal to ask in | Run `setup` and answer `y`, or start `serve --migrate` |
| ``Config: `providers` in the config is now `sources` ...`` (or another name "removed in 0.8.0") | A name deprecated in 0.6.0 | Rename it as the message says |
| `warning: <name> is a pass-through callback URL` | A subscription uses a callback URL created without a secret | Expected for Hermes Agent and the client libraries; their receivers verify each delivery |
| Subscribing with a callback URL from the bridge fails with `CallbackEndpointError` | The URL holds a different secret from the one subscribing | Create a callback URL with the secret the agent subscribes with |
| ChatGPT's task doesn't show an event that was delivered (the subscription's connection shows it delivered) | ChatGPT shows it in an open chat only after a reload, and can take a minute or so (seen on 27 Oct) | Reload the page; the event is under the task |
| An event sent while a ChatGPT task was paused never arrives | Pausing a task unsubscribes it, and resuming it subscribes again from now (new callback URL, `cursor: null`), so there's nothing to replay | Ask ChatGPT to list it: `list_events` reads it from Event Gateway |
| `warning: <event>'s description is ... characters` | A description over 400 characters; ChatGPT has been reported to leave such events out | Shorten it in `bridge.config.ts`, then refresh the plugin in ChatGPT |
