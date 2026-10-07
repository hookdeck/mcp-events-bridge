---
name: mcp-events-bridge
description: "Sets up and runs the MCP Events bridge (npm @hookdeck/mcp-events-bridge), an MCP server that turns webhooks from Resend, GitHub or any HTTP sender into MCP Events that agents subscribe to, with Hookdeck Event Gateway receiving, verifying and delivering them. Use when an agent should react to events instead of polling, when connecting ChatGPT or an agent on a laptop to webhook events, when adding a provider or a generic webhook (including registering the URL with a sender by hand), or when troubleshooting setup, serve or deliveries."
---

# MCP Events bridge

The bridge is an MCP server. Agents call `events/subscribe` on it (the [MCP Events](https://developers.openai.com/plugins/build/mcp-events) extension) and receive signed webhook deliveries when something happens. Hookdeck Event Gateway receives each provider's webhooks, verifies them and delivers every event with retries; the bridge maps, matches and signs.

Full reference: the [README](https://github.com/hookdeck/mcp-events-bridge#readme). This skill is the procedure; follow it in order and check each step's success signal before moving on.

## Rules

- **Credentials come from the user.** Ask for the Hookdeck project's API key and signing secret (Project settings > Secrets) and any provider key; never create accounts, and never print a secret or `.env` in your output.
- **The MCP URL (`/mcp/<BRIDGE_MCP_SECRET>`) is a credential.** Share it only with the agent being connected.
- **One bridge per Hookdeck project.** Two bridges in one project relay each event twice.

## 1. Decide where the bridge runs

| | Local (default) | Deployed |
|---|---|---|
| Runs | On the agent's machine | On a host with a public URL (Fly.io in the README) |
| Provider events arrive through | The Hookdeck CLI (`hookdeck listen`, started by the bridge) | Event Gateway, over HTTPS |
| Agents it can serve | Agents on the same machine (through tunnel URLs) | Cloud agents such as ChatGPT |
| Resource names | `bridge-<provider>-local` | `bridge-<provider>-public`, or `BRIDGE_DEPLOYMENT` |

ChatGPT needs a deployed bridge (or a tunnel to a local one). For deployment, follow the README's "Deploy to Fly.io" section, then continue at step 3.

## 2. Set up a local bridge

Needs Node 22.12+ and the [Hookdeck CLI](https://hookdeck.com/docs/cli) (`hookdeck version` prints a version).

```sh
mkdir my-bridge && cd my-bridge
npm init -y && npm pkg set type=module
npm install @hookdeck/mcp-events-bridge
printf 'node_modules/\n.env\n.hookdeck/\n' > .gitignore
```

Create `bridge.config.ts` with the providers the user wants (step 3 adds more later):

```ts
import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
import { resend } from '@hookdeck/mcp-events-bridge/providers';

export default defineConfig({
  providers: [resend({ apiKey: env('RESEND_API_KEY') })],
});
```

Write `.env` with `HOOKDECK_API_KEY`, `HOOKDECK_SIGNING_SECRET` and the provider's variables (README "Configuration" lists them all). Then:

```sh
npx mcp-events-bridge setup
```

- **Success:** a line per provider (`provider resend: source https://hkdk.events/..., connection bridge-resend-local, webhook registered`; on a re-run, `updated` or `existing`), then `MCP URL:`. Exit code 0.
- **First run:** it generates an MCP secret and prints `BRIDGE_MCP_SECRET=...`. Add that line to `.env` without echoing it.
- **Exit code 1 with "Setup isn't complete":** a webhook secret is missing (step 3, generic webhooks). Everything else was set up.

```sh
npx mcp-events-bridge serve
```

- **Success:** `[bridge] hookdeck listen connected: ...` and `[bridge] MCP endpoint: http://127.0.0.1:8080/mcp/<BRIDGE_MCP_SECRET>`. Keep it running.
- It restarts `hookdeck listen` if it stops, and recovers provider events that arrived while the bridge was down.

## 3. Add providers

Every event is named **`{instance id}.{event}`**: the instance `id` (by default its type) and the provider's own event name, e.g. `resend.email.received`, `github.issues`, `fills.order.filled`. `events/list` shows them.

- **Resend, GitHub:** add `resend({...})` or `github({...})` to `providers` (README "Webhook providers" has every option), add the variables to `.env`, run `setup` again. `setup` registers the provider's webhook itself.
- **Any other sender (generic webhook), registered by hand:**
  1. `npx mcp-events-bridge providers add webhook <id> --event <sender's event name> [--verification hmac --header x-signature ...]` (`providers add webhook --help` lists options: verification type, event type and id location, filters). It prints the source URL, adds `<ID>_WEBHOOK_SECRET=` to `.env`, and prints a `webhook({...})` entry.
  2. Paste the entry into `providers` in `bridge.config.ts` (or rerun with `--write-config`; it refuses configs it can't edit safely and prints the entry instead).
  3. Register the printed URL with the sender. Put the secret it gives you (or one you generate, e.g. `openssl rand -hex 32`, for a server the user runs) in `.env`.
  4. Run `setup` (exit 0 now; a new secret can take about a minute to take effect), then restart `serve`.

## 4. Connect an agent

- **ChatGPT (deployed bridge):** ChatGPT > Plugins > Add > Create MCP App, URL `https://<bridge>/mcp/<BRIDGE_MCP_SECRET>`, No Authentication. Then ask it, in a Work chat, to tell you about new events (e.g. emails from a sender).
- **An agent on the same machine as a local bridge**, which implements MCP Events webhook delivery itself:
  1. It calls the bridge's `create_tunnel_url` tool (`agent`, `name`, `port`, `path`; use `path: '/'` if the agent builds callbacks from one base URL plus a path). It gets a public `https://hkdk.events/...` URL; the bridge runs `hookdeck listen` to the agent's port.
  2. It calls `events/subscribe` with that URL and a `whsec_` secret it generates.
  3. What the agent's receiver must do: [references/receiving-deliveries.md](references/receiving-deliveries.md).
- **Hermes Agent** (experimental: from an unmerged pull request; released Hermes has no MCP Events support): follow [references/hermes-agent.md](references/hermes-agent.md).
- **Agents without MCP Events support:** they can still call `list_events` and `get_event` (events that happened, from Event Gateway).

## 5. Verify

1. Trigger a real event: send an email to the Resend receiving address, open a GitHub issue, or (generic webhook) have the sender post one.
2. In `serve`'s output: `[listen] inbound: ... [200] POST http://localhost:8080/inbound/<id>` then `[bridge] <id>.<event> <event id>: 1/1 published` (`0/0` means no subscription matched).
3. The `list_providers` tool shows each provider's events and how many subscriptions each has.
4. The `[listen]` line ends with an Event Gateway dashboard link for the request: every attempt is recorded there.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `setup` exits 1: "Setup isn't complete", then `<id>: set <VAR>` | A webhook secret isn't set | Register the URL, put the secret in `.env`, run `setup` |
| `serve`: "Not set: <VAR> (provider <id>)" | Same | Same, then `serve` |
| `serve`: "Event Gateway isn't set up for deployment ..." | `setup` hasn't run with this deployment name and inbound mode | Run `setup` with the same `BRIDGE_DEPLOYMENT` and `BRIDGE_INBOUND` |
| Log: `subscription ... is for "...", which this bridge doesn't offer` | The provider was removed, its `id` renamed, or the subscription is from 0.1.0 | The agent subscribes again, to a name from `events/list` |
| `events/subscribe` fails: "Unknown event" | Old or wrong name | Use a name from `events/list` |
| A generic webhook sender gets 401 | Wrong signature, header, encoding or secret | Match the `verification` settings; a new secret can take about a minute |
| `[bridge] ... 0/0 published` | No subscription matches (name or filters) | Check the subscription's name and arguments |
| An event arrives after a minute or two | `hookdeck listen` occasionally takes ~30s to connect; Event Gateway occasionally queues a CLI delivery | Wait; missed deliveries are retried by the bridge |
| The same event twice | Two bridges in one Hookdeck project, or a retry | One project per bridge; receivers dedupe by `webhook-id` |
