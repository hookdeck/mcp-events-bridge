# MCP Events bridge

Subscribe an agent to things that happen in apps whose vendors haven't shipped [MCP Events](https://developers.openai.com/plugins/build/mcp-events). The bridge turns a provider's ordinary webhooks into MCP Events, with [Hookdeck Event Gateway](https://hookdeck.com) receiving, verifying and delivering them.

Built-in providers: **Resend** inbound email (`email.received`) and **GitHub** (one event per GitHub webhook type, such as `github.issues` or `github.pull_request`, filtered by repository, action and sender). Someone emails an address on Resend, or opens an issue, and an agent subscribed to that event (for example in ChatGPT) wakes up and acts. Other providers are a `defineProvider` away.

Status: a working demo, built in stages. See [`docs/PLAN.md`](docs/PLAN.md) for what's done and what's next, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

## How it works

<img src="docs/images/architecture.svg" alt="Webhook providers (Resend, GitHub, any other) send webhooks to Hookdeck Event Gateway sources, which verify and keep them and forward them to the MCP Events bridge. Agent hosts like ChatGPT subscribe over MCP. The bridge maps, matches and signs each event and publishes it to an Event Gateway topic source, which delivers it to each subscriber's callback through one connection per subscription." width="100%">

- **Event Gateway** verifies the provider's signature, keeps every request, and delivers each MCP Event to each subscriber with retries.
- **The bridge** is the MCP server: the event catalog, subscribe (with the endpoint challenge), and turning each provider webhook into a signed MCP Event per subscriber. It's stateless: subscriptions are Event Gateway connections, so there's no database.
- **The Hookdeck CLI** forwards provider events to a bridge on your laptop during development, so you don't need a public URL.

In the Event Gateway dashboard, a running bridge looks like this:

![Event Gateway connections, grouped by source: bridge-out-email_received to one mcp-sub connection with filter, dedupe and retry rules; bridge-hookdeck-notifications to bridge-notifications-fly and bridge-notifications-dev; bridge-resend to bridge-resend-fly and bridge-resend-dev](docs/images/event-gateway-connections.png)

- **`bridge-resend`** (the Resend source) feeds one inbound connection per deployment: `bridge-resend-fly` (HTTP, to the bridge on Fly.io) and `bridge-resend-dev` (CLI, to a bridge on a laptop).
- **`bridge-out-email_received`** is the topic source the bridge publishes to. Each subscription is one connection from it, `mcp-sub-<id>`, with filter, dedupe and retry rules, to a destination at the subscriber's callback (here, ChatGPT's).
- **`bridge-hookdeck-notifications`** receives Event Gateway's issue notifications and forwards them to each deployment, so a bridge hears about failing callbacks.

## Requirements

- Node 22 or later.
- A Hookdeck account, and a Hookdeck project for each deployment (for example one for development and one for production). Its Project API key and signing secret.
- The [Hookdeck CLI](https://hookdeck.com/docs/cli), for local development.
- A Resend account and an API key that can create webhooks. Every Resend account gets a receiving domain (`<id>.resend.app`; Emails > Receiving > ... > Receiving address), so no custom domain is needed. To send test emails, a verified sending domain.

## Run it locally

1. Install:

   ```sh
   npm install
   cp .env.example .env
   ```

   Fill in `HOOKDECK_API_KEY`, `HOOKDECK_SIGNING_SECRET` and `RESEND_API_KEY`. For the end-to-end check, also `RESEND_INBOUND_ADDRESS` (any address on your receiving domain) and `RESEND_TEST_FROM` (an address on your verified sending domain).

2. Configure providers in `bridge.config.ts`:

   ```ts
   import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
   import { github, resend } from '@hookdeck/mcp-events-bridge/providers';

   export default defineConfig({
     deployment: 'dev',
     providers: [
       resend({ apiKey: env('RESEND_API_KEY'), events: ['email.received'] }),
       // Optional: GitHub events for a list of repositories (or { org: 'name' }). Default events: issues,
       // issue_comment, pull_request, pull_request_review, push, release, workflow_run; `events: ['*']` enables all.
       github({ token: env('GITHUB_TOKEN'), scope: { repos: ['example-org/widgets', 'example-org/gadgets'] } }),
     ],
   });
   ```

   (This repo's own `bridge.config.ts` imports from `./src` instead.)

3. Create the Event Gateway resources and the Resend webhook:

   ```sh
   npm run bridge -- setup
   ```

   The first run generates an MCP secret; put it in `.env` as `BRIDGE_MCP_SECRET`. Setup is safe to re-run.

4. Run the bridge, and forward events to it with the Hookdeck CLI (the exact commands are printed by `setup` and `serve`):

   ```sh
   npm run bridge -- serve
   hookdeck listen 8080 bridge-resend bridge-resend-dev
   hookdeck listen 8080 bridge-hookdeck-notifications bridge-notifications-dev
   ```

5. Check the whole path with real email:

   ```sh
   npm run e2e
   ```

   This starts its own bridge and `hookdeck listen`, subscribes a test subscriber (behind a cloudflared quick tunnel, because the MCP Events challenge needs a synchronous answer), sends emails through Resend, and checks delivery, that `webhook-id` equals Resend's `svix-id`, `get_event`, the `from` filter, and unsubscribe. `E2E_EXTENDED=1` adds a failed publish and its retry, a duplicate provider delivery, a `410` deleting a subscription, and `deliveryStatus` for a failing callback (about 10 minutes).

## Deploy to Fly.io

`fly.toml` and the `Dockerfile` run one always-on machine; there's no volume, since Event Gateway is the store.

```sh
fly apps create <app>                      # then set app in fly.toml
fly secrets set HOOKDECK_API_KEY=... HOOKDECK_SIGNING_SECRET=... RESEND_API_KEY=... BRIDGE_MCP_SECRET=...
fly deploy
BRIDGE_DEPLOYMENT=fly BRIDGE_INBOUND=http BRIDGE_PUBLIC_URL=https://<app>.fly.dev npm run bridge -- setup
E2E_BRIDGE_URL=https://<app>.fly.dev npm run e2e
```

Use a separate Hookdeck project for each deployment: deployments in one project share the provider source and the subscriptions.

## Connect ChatGPT

With Developer mode on (ChatGPT Plus or above), go to Plugins, choose Add > Create MCP App, paste `https://<app>.fly.dev/mcp/<BRIDGE_MCP_SECRET>`, and choose No Authentication. Then, in a Work chat, ask to be told about new emails, for example from a particular sender. ChatGPT subscribes to `email.received` and sets up a monitoring task:

![A ChatGPT Work chat: asked to be told about all inbound emails, ChatGPT subscribes through the MCP Events bridge and shows an "Inbound email notifications" task that is Monitoring](docs/images/chatgpt-subscribe.png)

When an email arrives, the task runs with the event: sender, recipients and subject.

![The same chat after an email arrived: "New email received" with the sender, the recipient on the Resend receiving domain, and the subject "Hello ChatGPT from the MCP Events bridge"](docs/images/chatgpt-email-event.png)

The URL is a credential: anyone with it can use the bridge's MCP endpoint. Keep it private. OAuth options are planned (see "Authentication" in the architecture doc).

## Configuration

| Variable | Purpose |
| --- | --- |
| `HOOKDECK_API_KEY` | Project API key, for the Event Gateway API and the Publish API |
| `HOOKDECK_SIGNING_SECRET` | Verifies Event Gateway's signature on requests to the bridge |
| `RESEND_API_KEY` | Creates the Resend webhook (referenced from `bridge.config.ts`) |
| `GITHUB_TOKEN` | Creates the GitHub webhooks: a token with the Webhooks (read and write) permission on the repositories or organization. Only `setup` uses it |
| `BRIDGE_MCP_SECRET` | Secret path segment of the MCP URL; `setup` generates one |
| `BRIDGE_DEPLOYMENT` | Names this deployment's Event Gateway resources (read by this repo's `bridge.config.ts`) |
| `BRIDGE_INBOUND` | `cli` (development, through `hookdeck listen`) or `http` (deployed); defaults to `http` on Fly.io |
| `BRIDGE_PUBLIC_URL` | For `http` inbound; defaults to `https://$FLY_APP_NAME.fly.dev` on Fly.io |
| `BRIDGE_PORT` | Listener port (default 8080) |

## MCP surface

- `events/list`, `events/subscribe`, `events/unsubscribe` (webhook delivery).
- `get_event(eventId)` and `list_recent_events(name?, since?, limit?)`: past events, read from Event Gateway.
- `list_providers()`: configured providers and their subscriptions.

## Tests

```sh
npm test          # unit and in-process integration tests, with a fake Event Gateway
npm run typecheck
```

## License

MIT
