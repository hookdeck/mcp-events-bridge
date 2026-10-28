# MCP Events bridge

Turn webhooks into [MCP Events](https://developers.openai.com/plugins/build/mcp-events), so AI agents can act the moment something happens: an email arrives, an issue is opened, a workflow fails. [Hookdeck Event Gateway](https://hookdeck.com) receives, verifies and delivers every event.

<img src="docs/images/overview.svg" alt="Services (Resend, GitHub and others) send webhooks to Hookdeck Event Gateway, which receives and verifies them, turns each into an MCP Event, and delivers it with retries to agents, such as ChatGPT, Hermes Agent and others, which subscribed through the MCP Events bridge over MCP. Claude Code polls the bridge over MCP instead." width="100%">

For example, an email arrives at a Resend address, and ChatGPT, subscribed through the bridge, acts on it:

![ChatGPT, subscribed through the bridge, reporting "New inbound email" with the sender, the subject "Hello ChatGPT from the MCP Events bridge" and the recipient, under an "Inbound email alerts" task that is Monitoring](docs/images/chatgpt-email-event.png)

## Why

MCP Events is an experimental MCP extension that lets an agent subscribe to events instead of polling for them, and ChatGPT supports it. But an agent can only subscribe to MCP servers that implement it, and almost none do yet, while nearly every service already sends webhooks.

The bridge closes that gap:

- **Webhooks become MCP Events.** Sources: Resend inbound email, GitHub, any of 163 Event Gateway source types (Stripe, Slack, Shopify and more), and webhooks from any HTTP sender, such as a service you've built, verified with HMAC, Standard Webhooks, Basic auth or an API key. Add others with `defineSource`.
- **Subscribers choose what wakes them.** Events have filters, such as an email's sender, or a GitHub repository and action.
- **Every event verified, delivered and recorded.** Event Gateway verifies each service's signatures, retries failed deliveries, drops duplicates within an hour, and keeps a record of every event and attempt.
- **Stateless.** Each subscription is an Event Gateway connection, so there's no database.

It's for developers who want agents ([ChatGPT, Claude Code, Hermes Agent and others](#supported-mcp-clients)) to react to events from the services they already use.

**Status:** 0.8, a working demo built in stages. MCP Events is experimental, and this package may change with it. See [`docs/PLAN.md`](docs/PLAN.md) for what's done and what's next, and [`CHANGELOG.md`](CHANGELOG.md) for changes between versions. Upgrading from 0.7: see [`docs/UPGRADING.md`](docs/UPGRADING.md).

## How it works

<img src="docs/images/architecture.svg" alt="Services (Resend, GitHub and others) send webhooks to Hookdeck Event Gateway sources, which verify and keep them. Agents like ChatGPT and Hermes Agent (through the Hookdeck CLI) subscribe to the MCP Events bridge over MCP, and the bridge creates one Event Gateway connection per subscription on the service's source. Each connection turns a webhook into an MCP Event, filters it by the subscription's arguments, and delivers it to the agent's callback URL, signed for that subscriber. Claude Code polls the bridge over MCP instead." width="100%">

- **Event Gateway** verifies each service's webhook signature, keeps every request, turns each one into an MCP Event, and delivers it to each subscriber, signed with the subscriber's secret, with retries.
- **The bridge** is the MCP server: it lists the events on offer, handles subscribe (including the spec's endpoint challenge), and manages one Event Gateway connection per subscription. Events don't pass through it.
- **The Hookdeck CLI** forwards MCP Events to [local agents](#local-agents), and Event Gateway's notifications to a bridge on your laptop, so neither needs a public URL.

The design, its trade-offs and how it maps to the spec are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Supported MCP clients

Clients that support MCP Events subscribe to the bridge, and receive each event as a webhook at their callback URL. Clients that don't, such as Claude Code, poll with the bridge's tools.

| Client | How it gets events | Needs a public URL? | Tested | Guide |
| --- | --- | --- | --- | --- |
| ChatGPT (Plus or above, Developer mode) | MCP Events, webhook delivery | Yes, for the bridge's MCP endpoint: [deploy the bridge](#deploy-to-flyio), or tunnel to a local one | Yes, end to end | [Connect ChatGPT](#connect-chatgpt) |
| Claude Code | Polls, with no MCP Events support: `wait_for_event` and `poll_events` during a turn, and the plugin (which runs `watch`) between prompts | No | 2.1.294 to 2.1.310 | [Connect Claude Code](#connect-claude-code) |
| Hermes Agent | MCP Events, webhook delivery | No: a local bridge creates its callback URL | v0.22.5 | [Hermes Agent guide](skills/mcp-events-bridge/references/hermes-agent.md) |
| Vercel AI SDK (`@ai-sdk/mcp`) | MCP Events, webhook delivery | A callback URL: your own public route, or one a local bridge creates | 2.0.84 | [Library guide](skills/mcp-events-bridge/references/library-clients.md#vercel-ai-sdk) |
| Mastra (`@mastra/mcp`) | MCP Events, poll or webhook delivery | Poll: no. Webhook: a callback URL, as for the Vercel AI SDK | 2.5.0 | [Library guide](skills/mcp-events-bridge/references/library-clients.md#mastra) |
| TanStack AI (`@tanstack/ai-mcp`) | MCP Events, webhook delivery | A callback URL: your own public route, or one a local bridge creates | 1.0.0 | [Library guide](skills/mcp-events-bridge/references/library-clients.md#tanstack-ai) |
| OpenClaw | MCP Events (beta builds only), webhook delivery | Yes: a bare HTTPS origin, with no path, which a local bridge's callback URLs can't be | Not tested | None yet ([openclaw#184684](https://github.com/openclaw/openclaw/issues/184684)) |
| Other MCP clients (Cursor, Codex, VS Code and others) | Polls, with `wait_for_event` and `poll_events` | No | Not tested | [Polling](#polling) |

Versions are the ones tested against the bridge, in October 2026. MCP Events support is experimental in Hermes Agent and in the three libraries.

## Set up with a coding agent

The [`mcp-events-bridge` skill](skills/mcp-events-bridge/SKILL.md) walks a coding agent (Claude Code, Cursor, Codex and others that support [Agent Skills](https://agentskills.io)) through setup, adding sources, connecting an agent and troubleshooting, with a success signal for each step:

```sh
npx skills add hookdeck/mcp-events-bridge
```

Then ask the agent to set up the bridge. It asks you for the credentials. The skill is also in the npm package, under `skills/`.

## Quick start

You need:

- Node 22.12 or later.
- A [Hookdeck](https://hookdeck.com) account and a project for the bridge. From the project's settings (Secrets): the **API key** and the **signing secret**.
- The [Hookdeck CLI](https://hookdeck.com/docs/cli), for running the bridge locally (and for `npm run e2e`).
- At least one [source](#sources): a Resend or GitHub account, or any service that sends webhooks, including your own.

1. **Create a project and install the bridge:**

   ```sh
   mkdir my-bridge && cd my-bridge
   npm init -y && npm pkg set type=module
   npm install @hookdeck/mcp-events-bridge
   printf 'node_modules/\n.env\n.hookdeck/\n' > .gitignore   # .env and .hookdeck/ hold credentials
   ```

2. **Choose sources** in `bridge.config.ts`:

   ```ts
   import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
   import { github, resend } from '@hookdeck/mcp-events-bridge/sources';

   export default defineConfig({
     sources: [
       resend({ apiKey: env('RESEND_API_KEY') }),
       // Only `setup` uses the token, so it's optional here: a deployed bridge runs without it.
       github({ token: env('GITHUB_TOKEN', { optional: true }), scope: { repos: ['your-org/your-repo'] } }),
     ],
   });
   ```

   Keep only the sources you use, or add others, such as Stripe or your own service: see [Sources](#sources).

3. **Add credentials** to `.env`:

   ```sh
   HOOKDECK_API_KEY=...
   HOOKDECK_SIGNING_SECRET=...
   RESEND_API_KEY=...      # if you use Resend
   GITHUB_TOKEN=...        # if you use GitHub
   ```

4. **Create the Event Gateway resources and the webhooks:**

   ```sh
   npx mcp-events-bridge setup
   ```

   The first run generates an MCP secret: add it to `.env` as `BRIDGE_MCP_SECRET`. Setup is safe to re-run, and updates the webhooks when you add sources or change events or repositories. Removing a source or a repository deletes nothing: delete its webhook (and its Event Gateway source) yourself. Upgrading from 0.7, setup offers to migrate your subscriptions: see [`docs/UPGRADING.md`](docs/UPGRADING.md).

5. **Run the bridge:**

   ```sh
   npx mcp-events-bridge serve
   ```

   Locally, `serve` checks that setup has run, and starts `hookdeck listen` for Event Gateway's notifications (which tell the bridge about failing callbacks) and for [local agents](#local-agents); it restarts `listen` if it stops. Events don't pass through the bridge: Event Gateway delivers each one to its subscribers, so none are lost while the bridge is stopped. Once an agent has subscribed, send an email to your Resend address, or open an issue, and its delivery shows under the subscription's connection, `mcp-sub-<id>`, in the Event Gateway dashboard.

6. **Connect an agent:** see [Connect ChatGPT](#connect-chatgpt), [Connect Claude Code](#connect-claude-code), or [Supported MCP clients](#supported-mcp-clients) for the others. ChatGPT has to reach the bridge's MCP endpoint, so [deploy](#deploy-to-flyio) the bridge, or expose your local port with a tunnel such as `cloudflared tunnel --url http://127.0.0.1:8080` and use `https://<tunnel host>/mcp/<BRIDGE_MCP_SECRET>`. Events don't need the tunnel: Event Gateway delivers them to ChatGPT directly.

## Connect ChatGPT

With Developer mode on (ChatGPT Plus or above), go to Plugins, choose Add > Create MCP App, paste `https://<your bridge>/mcp/<BRIDGE_MCP_SECRET>`, and choose No Authentication. ChatGPT can't send an `Authorization` header (it offers only OAuth or no authentication), so it takes the secret in the URL. Then, in a Work chat, ask to be told about new events, for example emails from a particular sender. ChatGPT subscribes and sets up a monitoring task:

![A ChatGPT Work chat: asked to be told about all inbound emails, ChatGPT subscribes through the MCP Events bridge and shows an "Inbound email alerts" task that is Monitoring](docs/images/chatgpt-subscribe.png)

When an event arrives, the task runs with it, as in the screenshot at the top. A chat that's open shows it on its own, about a minute after the event arrives, even though ChatGPT answers the delivery within about 2 seconds (seen on 28 Oct, in an open, focused tab); if it doesn't appear, reload the page. Pausing the task unsubscribes it from the bridge, and resuming it subscribes again from now, with a new callback URL and no cursor, so events that arrive while it's paused aren't delivered or replayed (seen on 27 Oct). They're still in Event Gateway, so ChatGPT can list them with `list_events`.

ChatGPT keeps the list of events it can subscribe to from when you added the plugin. After you upgrade the bridge or add a source, refresh the plugin in Plugins, or ChatGPT can't subscribe to the new or renamed events (it may still list them, since that call goes to the bridge). Then ask it to subscribe again.

That URL is a credential: anyone with it can use the bridge. Keep it private (see [Security and limitations](#security-and-limitations)).

## Connect Claude Code

Claude Code doesn't support MCP Events yet, so it polls. Install the plugin, which asks for the bridge's MCP endpoint (`https://<bridge>/mcp`) and its secret (`BRIDGE_MCP_SECRET`), sent as an `Authorization: Bearer` header, and keeps both in secure storage:

```text
/plugin install mcp-events-bridge --marketplace hookdeck/mcp-events-bridge
```

If you skip them (Esc), the plugin still installs. Set them later with `/plugin configure mcp-events-bridge@hookdeck`, then start a new session. An endpoint with the secret in it (`/mcp/<BRIDGE_MCP_SECRET>`), set before the secret field existed, still works.

Then, in any project, ask Claude to watch for events your bridge offers ("what events can the bridge give me?" lists them). For example, with the [GitHub source](#github) set up for a repository, "watch `<owner>/<repo>` for new issues and comments"; with [Resend](#resend), "tell me when an email arrives". The plugin keeps a watch list per project and runs [`watch`](#in-the-background-watch) for the whole session, so each event wakes Claude, between prompts too, and a new session first catches up on what it missed (up to 24 hours). It needs no public URL, so it works with a local bridge.

Without the plugin, add the bridge as an MCP server and ask Claude to wait for events with the poll tools (see [Polling](#polling)). The [Claude Code guide](skills/mcp-events-bridge/references/claude-code.md) has both.

## Sources

A source is where events come from: a service that sends webhooks. Each source in `bridge.config.ts` has an `id` (by default its type: `resend`, `github`, `stripe`), and its events are offered over MCP as `{id}.{event}`, where `event` is the service's own name for it: `resend.email.received`, `github.issues`, `stripe.invoice.paid`. So `events/list` says which source each event comes from, and two sources can offer the same kind of event (two Resend accounts, two trading servers) under different ids. Renaming an `id` renames its events, so agents need to subscribe again.

| Source | What it gives you | Who registers the webhook |
| --- | --- | --- |
| [`resend()`](#resend), [`github()`](#github) | Event descriptions, summaries and filters written for the service | `setup`, through the service's API (or you, in GitHub's manual mode) |
| [`source({ type: 'stripe', ... })`](#services-with-an-event-gateway-source-type) and 160 other Event Gateway source types | Event Gateway verifies the service's own signatures; you name the events and where their type and id are | You, with the URL `setup` prints |
| [`source({ type: 'webhook', ... })`](#any-http-sender-webhook-sources) | Any HTTP sender, such as a service you run, verified with HMAC, Standard Webhooks, Basic auth or an API key | You |

### Resend

Inbound email. Every Resend account has a receiving domain (`<id>.resend.app`; Emails > Receiving), so no custom domain is needed.

- **Options:** `resend({ apiKey })`. The API key needs permission to create webhooks.
- **Event:** `email.received` (offered as `resend.email.received`), with the sender, recipients, subject and Resend's email id. Read the full email with Resend's own API.
- **Filters:** `from` (recommended: it limits who can wake the agent) and `to`.

### GitHub

One event per GitHub webhook type: `issues`, `pull_request`, `push`, and so on (26 types), offered as `github.issues`, `github.pull_request`, `github.push`.

- **Events:** by default issues, issue comments, pull requests, reviews, pushes, releases and workflow runs. Choose with GitHub's names, `events: ['issues', 'push', ...]`, or `['*']` for all.
- **Filters:** `repository`, `actions` (for example `["opened"]`) and `sender`.
- **Summary:** repository, action, sender, title, number and URL for every type, plus a few fields for the common ones (labels, branches, merged, ref, commit count, workflow conclusion). Payloads aren't passed through; read details with GitHub's own tools.

Two ways to connect repositories:

| Mode | Options | Who adds the webhooks |
| --- | --- | --- |
| **Automatic** | `github({ token, scope: { repos: ['owner/name', ...] } })`, or `scope: { org: 'name' }` for every repository in an organization | `setup`, with a fine-grained token that has the Webhooks (read and write) permission. For an organization's repositories, the token's resource owner must be the organization. `scope: { org }` creates one organization webhook, which needs an organization owner and the organization Webhooks permission |
| **Manual** | `github({ webhookSecret })`, no token | You: in each repository, Settings > Webhooks > Add webhook, with the Payload URL `setup` prints, content type `application/json`, and the same secret |

### Services with an Event Gateway source type

Stripe, Slack, Shopify, Twilio, Linear, Clerk and 157 more: `source({ type })` takes any Event Gateway source type that's verified with credentials you give it, and Event Gateway checks the service's own signatures, including those that sign a timestamp with the body, as Stripe and Slack do. For example, Stripe:

```ts
import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
import { source } from '@hookdeck/mcp-events-bridge/sources';

export default defineConfig({
  sources: [
    source({
      type: 'stripe',                            // the id defaults to the type, so events are stripe.<event>
      secret: env('STRIPE_WEBHOOK_SECRET'),      // the endpoint's signing secret, whsec_...
      events: {
        'invoice.paid': { description: 'A Stripe invoice was paid.' },
        'customer.subscription.deleted': { description: 'A Stripe subscription ended.' },
      },
      eventType: { field: 'type' },              // where Stripe names the event
      eventId: { field: 'id' },                  // evt_..., stable across Stripe's retries
      occurredAt: { field: 'created' },
    }),
  ],
});
```

- **Credentials:** most types take `secret`, the service's webhook signing secret. Others take their own fields: `source({ type: 'postmark', username, password, ... })`, `source({ type: 'twitter', apiKey, ... })`. The TypeScript types list each type's fields, and the config won't compile with a missing or unknown one.
- **Events:** you name the events and say where the service puts the event type and id, with the same options as a webhook source (below). Presets that fill these in per service are planned.
- **Not offered yet:** source types with a choice of verification methods (GitLab, Grafana, Azure Event Grid, SendGrid Inbound Parse, Ordinal) and those configured without credentials (AWS SNS and a few others). Use a webhook source, or your own definition, for those.
- **Registration handshakes:** some services check a URL when you register it. Slack's Events API sends a `url_verification` challenge, and Event Gateway's `slack` source answers it itself, so registering the URL in Slack needs no code. A `webhook` source answers every request with Event Gateway's standard response, not the challenge. Other services' handshakes haven't been checked.
- **Tested** on 26 Oct 2026 with requests signed or authenticated as each service does (no accounts at the services): Stripe and Slack (a signature over a timestamp and the body) and Postmark (Basic auth). Correct ones reached a subscriber; wrong ones were rejected by Event Gateway (`VERIFICATION_FAILED`). The other source types use the same path, but haven't each been tested.

### Any HTTP sender: webhook sources

`source({ type: 'webhook' })` takes webhooks from any HTTP sender: a service you run yourself, or one without an Event Gateway source type. For example, instead of an agent polling a trading server's orders every bar to see whether an order filled, the server sends a webhook when it fills, and the agent subscribes to `fills.order.filled` for the symbols it trades:

```ts
import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
import { source } from '@hookdeck/mcp-events-bridge/sources';

export default defineConfig({
  sources: [
    source({
      id: 'fills',                       // names the Event Gateway source: bridge-fills
      type: 'webhook',
      verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },
      events: { 'order.filled': { description: 'An order on my trading server filled.' } },
      eventId: { header: 'x-delivery-id' },     // stable across the sender's retries
      occurredAt: { field: 'filled_at' },
      filters: ['symbol', 'side'],              // an agent subscribes with { "symbol": "AAPL" }
    }),
  ],
});
```

The server signs each request's raw body with HMAC-SHA256 and the shared secret, hex-encoded in `x-signature`, and POSTs JSON such as `{ "symbol": "AAPL", "side": "buy", "quantity": 100, "price": 187.5, "filled_at": "2026-10-07T14:30:00Z" }`.

- **`verification`** (required for `webhook`): Event Gateway verifies every request and rejects the rest, so they reach no subscriber. One of:
  - `{ type: 'hmac', algorithm, encoding, header, secret }`: an HMAC of the raw body in a header. `algorithm` is `sha1`, `sha256` or `sha512`; `encoding` is `hex`, `base64` or `base64url`. A `sha256=` prefix on the value is accepted. The key is the secret string as written (UTF-8), not decoded from hex or base64.
  - `{ type: 'standard-webhooks', secret }`: [Standard Webhooks](https://www.standardwebhooks.com) signatures, usually with a `whsec_...` secret.
  - `{ type: 'basic-auth', username, password }` or `{ type: 'api-key', header, key }`: a shared credential sent with every request. Prefer a signature: Event Gateway keeps request headers, so these credentials are stored with each request, and anyone who sees one can replay it.
  There's no unverified option: anyone with the URL could otherwise wake your agents with whatever they send.

These options work for every `source()`, whatever its type:

- **`events`:** the sender's event names (offered as `{id}.{name}`, e.g. `fills.order.filled`), as a list or with a description each. Keep a description under about 400 characters: ChatGPT has been reported to leave out events with longer ones, and `setup` and `serve` warn about them. With more than one, `eventType` says where the sender names the event, `{ header }` or `{ field }` (a dot path into the body), and each event's `value` is the sender's name for it (default: the event name). Requests for other values are ignored.
- **`eventId`:** the sender's id for an event, from `{ header }` or `{ field }`. It becomes the MCP event's `eventId` (and its `webhook-id`), and Event Gateway drops repeats within an hour. Default: a hash of the JSON body (the first 32 hex characters of its SHA-256), so a sender's retry with the same body is dropped as a repeat, and two different events with identical bodies count as one. Set it if your sender has an id.
- **`occurredAt`:** a body field with an ISO 8601 or Unix time. Default: when Event Gateway received the request (for a live delivery, when Event Gateway built the event from it, moments later).
- **Data:** the JSON body as sent, or only the top-level fields in `fields: [...]`. Bodies must be JSON (anything else is skipped, and stays in Event Gateway), and the event at most 256 KiB.
- **`filters`:** top-level body fields subscribers can filter on, by exact match of value and type: `{ "quantity": 100 }` matches the number 100, not the string `"100"`.

### Adding a source from the command line

Credentials are `env()` references. A service usually gives you its secret only after you register the URL, so the bridge can create the source first:

1. **Create the source and the config entry:**

   ```sh
   npx mcp-events-bridge sources add fills --type webhook --event order.filled --event-id-header x-delivery-id --filter symbol --filter side
   npx mcp-events-bridge sources add stripe --type stripe --event invoice.paid --event-type-field type --event-id-field id --occurred-at-field created
   ```

   It creates the Event Gateway source (`bridge-fills`, `bridge-stripe`) and prints its URL, adds the credential variables to `.env` (`FILLS_WEBHOOK_SECRET=`, `STRIPE_WEBHOOK_SECRET=`: empty, and only if `.env` doesn't have them), and prints the `source({...})` entry to paste into `sources`. `--write-config` adds the entry to `bridge.config.ts` itself (creating the file if there isn't one), or prints it if the file isn't a shape it can edit safely (for example sources built conditionally). For `--type webhook`, `--verification` chooses `hmac` (the default; `--algorithm`, `--encoding` and `--header` set the rest), `standard-webhooks`, `basic-auth` or `api-key`; `sources add --help` lists every option. Re-running it reuses the source and adds nothing twice.
2. **Register the URL with the sender,** and copy the secret it gives you (or, for your own server, generate one with `openssl rand -hex 32` and give it to the server).
3. **Put the secret in `.env`:** `FILLS_WEBHOOK_SECRET=...`.
4. **Run `npx mcp-events-bridge setup`.** It sets the secret on the source. A new or changed secret can take up to about a minute to take effect at Event Gateway, which rejects requests signed with it until then.

Until the secret is set, the source verifies nothing, so `serve` refuses to start and no agent can subscribe to its events. Requests that arrive meanwhile are kept in Event Gateway. `setup` still sets up everything else, then exits with an error naming the variable (so a deploy script or CI notices).

### Your own source definition

When the options above aren't enough (a payload that needs summarizing, filters on nested fields, registering the webhook through the service's API), write a `defineSource({...})` definition: the Event Gateway source type (or a `WEBHOOK` source with the verification config in `sourceConfig`), a `runtime` that recognizes and summarizes each event, each event's subscribe filter, and optionally how to register the webhook. The runtime runs inside Event Gateway's transformation as well as in the bridge, so it must be self-contained: no imports, no API calls. See ["Adding a source"](docs/ARCHITECTURE.md#adding-a-source) and the built-in [Resend](src/core/sources/resend.ts) and [GitHub](src/core/sources/github.ts) sources, and [`source()`](src/core/sources/source.ts).

### Removed in 0.8.0

Sources were called providers before 0.6.0, and the old names were deprecated aliases until 0.8.0, which removes them: `providers` in the config (now `sources`), `webhook()` (now `source({ type: 'webhook', ... })`), `defineProvider` (now `defineSource`), `@hookdeck/mcp-events-bridge/providers` (now `/sources`), `providers add webhook` (now `sources add`), and the `list_providers` tool (now `list_sources`). `providers` in the config and `providers add` fail with a message naming the replacement; the removed exports no longer import. See [`docs/UPGRADING.md`](docs/UPGRADING.md).

## Deploy to Fly.io

Any host that runs Node works; Fly.io is the reference. The bridge needs no volume, since Event Gateway is the store.

Add a `Dockerfile` to your project:

```dockerfile
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bridge.config.ts ./
EXPOSE 8080
CMD ["npx", "mcp-events-bridge", "serve"]
```

Then:

```sh
fly launch --no-deploy        # creates fly.toml: set internal_port = 8080, and BRIDGE_DEPLOYMENT = 'fly' under [env]
fly secrets set HOOKDECK_API_KEY=... HOOKDECK_SIGNING_SECRET=... RESEND_API_KEY=... BRIDGE_MCP_SECRET=...
BRIDGE_DEPLOYMENT=fly BRIDGE_INBOUND=http BRIDGE_PUBLIC_URL=https://<app>.fly.dev npx mcp-events-bridge setup
fly deploy
```

On Fly.io, the bridge receives Event Gateway's notifications over HTTP at its public URL instead of through the Hookdeck CLI, using the `fly` resources that `setup` created. Only `setup` needs `GITHUB_TOKEN`, so it doesn't have to be a Fly secret; in GitHub's manual mode, set `GITHUB_WEBHOOK_SECRET` as a Fly secret too, and likewise each `source()`'s credentials. The Dockerfile copies only `bridge.config.ts`: copy any other files your config imports, such as your own source definitions.

When an upgrade needs a migration (from 0.7 to 0.8, for example), `serve` doesn't start without a terminal to ask in. Run `setup` with the deployment's settings (as above) before `fly deploy`, or end the Dockerfile with `CMD ["npx", "mcp-events-bridge", "serve", "--migrate"]` to migrate without asking (see [`docs/UPGRADING.md`](docs/UPGRADING.md)).

Use a separate Hookdeck project for each environment you want isolated: deployments in one project share the sources and the subscriptions. An optional namespace for sharing a project is proposed in [#13](https://github.com/hookdeck/mcp-events-bridge/issues/13).

## What setup creates

In the Event Gateway dashboard:

```text
bridge-resend                    source: Resend's webhooks, verified with Resend's signatures
  mcp-sub-sub_3f9a...            one connection per subscription, created when an agent subscribes:
                                 transformation bridge-resend-envelope, filter, dedupe, retry,
                                 to the agent's callback URL, signed with its secret
bridge-hookdeck-notifications    source: Event Gateway's issue notifications
  bridge-notifications-local     to the bridge (one connection per deployment)
```

- **`bridge-<source id>`** (here `bridge-resend`) is the source's Event Gateway source, the URL its webhooks are registered with. Setup also writes its transformation, `bridge-<source id>-envelope`, which turns each request into an MCP Event; every subscription to the source's events uses it.
- **`mcp-sub-<id>`** is one subscription: a connection on the source with the transformation, a filter for the event name and the subscription's arguments, dedupe on `webhook-id` and retries, and a destination at the subscriber's callback URL that signs every attempt with the subscriber's secret. The bridge creates it when an agent subscribes, and deletes it when the subscription ends.
- **`bridge-hookdeck-notifications`** receives Event Gateway's issue notifications and forwards them to each deployment, so the bridge hears about failing callbacks and reports them to subscribers.
- **`bridge-replay`** (created by the first replay) is a Publish API source: while a subscription made with a cursor catches up, a connection from it, `bridge-replay-<subscription id>`, delivers the replayed events to the subscription's destination, and the bridge deletes it when they're delivered.

Locally (CLI inbound), `setup` also logs the Hookdeck CLI in to the bridge's project in `.hookdeck/config.toml` (gitignore it: it holds a key), so `hookdeck` commands run in the bridge's directory use that project rather than your global login.

## Configuration

### The bridge

Every deployment needs these, whichever sources it uses.

| Variable | Required | Purpose |
| --- | --- | --- |
| `HOOKDECK_API_KEY` | Yes | Project API key, for the Event Gateway API and the Publish API (which replay uses) |
| `HOOKDECK_SIGNING_SECRET` | Yes | Verifies Event Gateway's signature on the notifications it sends the bridge |
| `BRIDGE_MCP_SECRET` | To run `serve` | The MCP endpoint's secret: sent as `Authorization: Bearer <BRIDGE_MCP_SECRET>` to `/mcp`, or in the URL (`/mcp/<BRIDGE_MCP_SECRET>`) by clients that can't send a header, such as ChatGPT. `setup` generates one |
| `BRIDGE_MCP_SECRET_URL` | No | `false` turns the URL form (`/mcp/<BRIDGE_MCP_SECRET>`) off, leaving the header; for a bridge no ChatGPT connects to. Default `true` |
| `BRIDGE_INBOUND` | No | How Event Gateway's notifications reach the bridge: `cli` (through `hookdeck listen`; also what offers callback URLs to local agents) or `http` (a public URL). Default: `http` on Fly.io, `cli` elsewhere |
| `BRIDGE_PUBLIC_URL` | For `http` inbound off Fly.io | The bridge's public URL. Default on Fly.io: `https://$FLY_APP_NAME.fly.dev` |
| `BRIDGE_PORT` | No | Listener port (default: `PORT`, else 8080) |
| `BRIDGE_DEPLOYMENT` | No | Names this bridge's Event Gateway resources: its notifications connection becomes `bridge-notifications-<deployment>`. It doesn't keep bridges in one Hookdeck project apart: they share the sources, subscriptions and callback URLs, so give each bridge its own project ([#13](https://github.com/hookdeck/mcp-events-bridge/issues/13)). Default: `local` with `cli` inbound, `public` with `http` inbound (`deployment` in `bridge.config.ts` takes precedence) |
| `BRIDGE_HOOKDECK_CLI_CONFIG` | No | Where `setup` and `serve` log the Hookdeck CLI in to the bridge's project, for `hookdeck listen` and any `hookdeck` command run in that directory (default `.hookdeck/config.toml`); the inbound recovery watermark is kept next to it |

`defineConfig` also takes `inbound`, `publicUrl`, `port` and `hookdeck` directly, and `subscriptions` for subscription lifetimes. Run `npx mcp-events-bridge` for the commands and flags.

### Sources

Set only what the sources in your `bridge.config.ts` need. The names are the ones the examples pass to `env()`; use your own if you prefer.

#### Resend

| Variable | Required | Purpose |
| --- | --- | --- |
| `RESEND_API_KEY` | Yes | API key that can create webhooks. `setup` registers the webhook with it, and the example config requires it wherever the bridge runs |

#### GitHub

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | In automatic mode | Fine-grained token with the Webhooks (read and write) permission, or the GitHub CLI's (`gh auth token`, scope `repo`). Only `setup` uses it |
| `GITHUB_WEBHOOK_SECRET` | In manual mode | The secret on the webhooks you add (at least 16 characters). Needed wherever the bridge runs |

#### `source()`

Each `source()`'s credentials, named as its `env()` references name them. `sources add <id>` uses these names:

| Variable | Required | Purpose |
| --- | --- | --- |
| `<ID>_WEBHOOK_SECRET` | For a `webhook` source with `hmac` or `standard-webhooks`, and for most source types (`secret`) | The signing secret the sender uses |
| `<ID>_WEBHOOK_API_KEY` | For `api-key` | The key the sender sends in its header |
| `<ID>_WEBHOOK_USERNAME`, `<ID>_WEBHOOK_PASSWORD` | For `basic-auth` | The sender's Basic auth credentials |
| `<ID>_<FIELD>` | For a source type's other credential fields | For example `POSTMARK_USERNAME` for `source({ type: 'postmark', username })` |

`<ID>` is the source id, upper-cased, with other characters as `_` (`fills` gives `FILLS_WEBHOOK_SECRET`). Needed wherever the bridge runs: `setup` sets them on the Event Gateway source, and `serve` refuses to start without them.

## MCP surface

- `events/list`, `events/subscribe`, `events/unsubscribe`, with webhook delivery, and `events/poll`, for poll delivery. Event names are `{id}.{event}` (see [Sources](#sources)).
- `poll_events(name, arguments?, cursor?, maxAgeMs?, maxEvents?)` and `wait_for_event(name, arguments?, cursor?, timeoutMs?)`: the same polling as tools, for MCP clients without MCP Events support (see [Polling](#polling)).
- `get_event(name, eventId)` and `list_events(name?, since?, limit?)`: events that happened, read from Event Gateway (`events/list` is the catalog of events you can subscribe to). `get_event` takes the event's name as well as its id, since an id is the service's own and two sources can share one.
- `list_sources()`: configured sources, their types and events, and their subscriptions.
- `create_callback_url(agent, name, port?, path?, secret?)` and `list_callback_urls(agent)`: public callback URLs for agents on the same machine as a local bridge (see [Local agents](#local-agents)). Not offered by a deployed bridge.

## Polling

For MCP clients that can't receive webhooks, or don't support MCP Events yet. A client that implements MCP Events poll mode calls `events/poll`; any other MCP client, such as Claude Code, Codex or Cursor, calls the `poll_events` and `wait_for_event` tools, which take the same arguments and cursor:

```sh
claude mcp add --transport http events-bridge https://<bridge>/mcp --header "Authorization: Bearer <BRIDGE_MCP_SECRET>"
```

Any MCP client that can send a header connects the same way: the `/mcp` endpoint, with `BRIDGE_MCP_SECRET` as a bearer token.

Then ask the agent to wait for an event (Claude Code: see [the guide](skills/mcp-events-bridge/references/claude-code.md)), for example "wait for fills.order.filled for AAPL and tell me about each fill". It calls `wait_for_event`, which returns as soon as there are events (or after up to 50 seconds with none), and calls it again with the `cursor` it returned.

![Claude Code, asked to watch hookdeck/hookdeck-demos for new issue comments until three arrive, calls the events-bridge tools and reports each comment as it's posted, then lists all three with their times](docs/images/claude-code-wait-for-event.png)

- **No public URL needed:** each poll reads the source's requests from Event Gateway, so it works from a laptop, with a deployed or a local bridge.
- **Start from now:** a first call without a cursor returns no events, only a cursor. For events that already happened, use `list_events`.
- **At least once:** events can repeat, so dedupe by `eventId`. `truncated: true` means events were skipped (`maxAgeMs`, or older than Event Gateway keeps).
- **Replay:** every delivery and every subscribe response includes a `cursor`, a position in Event Gateway's history of the source's requests. Subscribe again with the latest one, after an unsubscribe, an expiry or downtime, and the bridge delivers what you missed, alongside live events, up to Event Gateway's retention (3 days on the Developer plan). Refreshing a live subscription with it changes nothing. Poll mode uses the same cursors.
- **Latency:** an event reaches a poller about 2 seconds after Event Gateway receives it, sometimes up to 15. Polls share one listing of Event Gateway's requests, at most every 2 seconds, so the API's rate limit (240 requests a minute per key) is shared, however many agents poll, as long as each polls at the `nextPollMs` it's given (`wait_for_event` does). When the limit runs low, `nextPollMs` grows to 30 seconds.

### In the background: `watch`

`mcp-events-bridge watch` polls a running bridge from now on and prints each event on its own line, as JSON (`{ eventId, name, timestamp, data }`), until stopped:

```sh
npx @hookdeck/mcp-events-bridge watch github.issues github.issue_comment --filter repository=<owner>/<repo>
```

Run it under an agent that wakes on a command's output, and the agent hears about events while it's idle or busy with something else. Here Claude Code runs `watch` with its Monitor tool, answers another question, then reports an issue opening, two comments and the issue closing, each as it happens, with no prompt:

![Claude Code, with a watch on hookdeck/hookdeck-demos running in the background, answers "what events can the bridge give me?", then four Monitor events arrive one by one and Claude reports each: issue #29 opened, two comments quoted in full, and the issue closed](docs/images/claude-code-watch.png)

In Claude Code, install the plugin, which runs `watch` for the whole session and lets you say "watch `<owner>/<repo>` for new issues" (see [the guide](skills/mcp-events-bridge/references/claude-code.md#3-watch-in-the-background-the-plugin)):

```text
/plugin install mcp-events-bridge --marketplace hookdeck/mcp-events-bridge
```

`watch` also follows a watch list file that changes while it runs (`--list`, edited with `mcp-events-bridge watches add|remove|list`), and resumes where it left off. It reads the MCP URL from `--url` or `BRIDGE_MCP_URL`, else uses `BRIDGE_PUBLIC_URL` (or the local port) plus `/mcp`; to a URL ending `/mcp` it sends `BRIDGE_MCP_SECRET` as `Authorization: Bearer`. It retries when the bridge can't be reached. `watch --help` lists the options.

## Local agents

An agent on a laptop has no public URL to receive webhooks on. Run the bridge on the same machine, in its own Hookdeck project, and it gives the agent public callback URLs, through Event Gateway and the Hookdeck CLI:

1. **Create a callback URL** with the `create_callback_url` tool, or `npx mcp-events-bridge callback-url create` from the bridge's directory: your `agent` name, a `name` for the URL, your local `port` (default 3000) and `path` (default `/events`), and the `secret` you'll subscribe with. Your first URL sets the port and path, and the rest share them.
2. **Subscribe** with `events/subscribe`, using the URL and that secret. Event Gateway answers the challenge. Deliveries arrive at `http://localhost:<port><path>`, signed with your secret; route them by `X-MCP-Subscription-Id`.

That's all the agent does. The bridge runs `hookdeck listen` for your port, and restarts it to cover each new URL. Deliveries missed while `listen` was down (the laptop slept, or during a restart) wait in Event Gateway, and the bridge retries them when it reconnects: Event Gateway signs each retry afresh, so standard verification (including its 5-minute window) passes. Delivery is at least once: dedupe by `webhook-id`.

A callback URL with a secret accepts only deliveries signed with that secret, so it holds one secret: to rotate, create a new URL and subscribe with it. The command line reads the secret from an environment variable, so it stays out of your shell history:

```sh
npx mcp-events-bridge callback-url create --agent laptop --name email --port 4000 --secret-env MY_AGENT_SECRET
```

**Pass-through callback URLs.** If your agent uses a different secret for each subscription under one base URL plus a path (Hermes Agent, and the AI SDK, Mastra and TanStack AI libraries do), create one callback URL with no secret and path `/`, and use it as the base: the URL covers the paths under it. Event Gateway can hold only one secret on a source, so a URL without one is pass-through: Event Gateway neither answers the challenge nor verifies deliveries, the bridge skips the challenge for it (it created the URL for this agent) and logs a warning, and your receiver must verify every delivery's signature, as the spec asks receivers to.

A URL that no subscription has used for an hour is deleted. An agent name is a label, not an identity: any client of the bridge's owner can use it.

What an agent's receiver has to do (signatures, dedupe, missed deliveries) is in [`skills/mcp-events-bridge/references/receiving-deliveries.md`](skills/mcp-events-bridge/references/receiving-deliveries.md). `npm run e2e` tests this path with a mock agent; see [`docs/PLAN.md`](docs/PLAN.md).

### Hermes Agent (experimental)

[Hermes Agent](https://github.com/NousResearch/hermes-agent) v0.22.5 and later work with a local bridge through a pass-through callback URL: Hermes subscribes, with your approval, and each event starts an agent run. MCP Events is experimental in Hermes too, and Hermes supports webhook delivery only.

[`skills/mcp-events-bridge/references/hermes-agent.md`](skills/mcp-events-bridge/references/hermes-agent.md) covers installing Hermes with what it needs, the callback URL, Hermes's configuration, subscribing and checking a delivery. The bridge is an MCP server in Hermes's `config.yaml` with `events: true`, and its secret goes in an `Authorization: Bearer` header that reads it from Hermes's `.env`, so the secret stays out of the model's context and Hermes's other files.

### MCP client libraries: Vercel AI SDK, Mastra, TanStack AI

Three TypeScript MCP client libraries have experimental MCP Events support, and each works with the bridge (tested on 0.8.0 on 28 Oct 2026, with a local bridge through a pass-through callback URL, and on 0.7 with a deployed bridge's `/mcp` endpoint):

| Library | Tested | Delivery |
| --- | --- | --- |
| Vercel AI SDK (`@ai-sdk/mcp`) | 2.0.84 | Webhook |
| Mastra (`@mastra/mcp`) | 2.5.0 | Poll or webhook |
| TanStack AI (`@tanstack/ai-mcp`) | 1.0.0 | Webhook |

[`skills/mcp-events-bridge/references/library-clients.md`](skills/mcp-events-bridge/references/library-clients.md) has the code for each: the bearer header, the callback URL (your own route, or a path under a pass-through callback URL from a local bridge), and the receiver.

## Security and limitations

- **The MCP secret is a credential.** `BRIDGE_MCP_SECRET` authenticates one owner, sent as `Authorization: Bearer` to `/mcp`, or in the URL (`/mcp/<BRIDGE_MCP_SECRET>`) by clients that can only take a URL, such as ChatGPT. Prefer the header where the client supports it: a URL is easily logged or saved in a client's files, a header much less so. A bridge no ChatGPT connects to can turn the URL form off (`BRIDGE_MCP_SECRET_URL=false`). The secret is redacted from the bridge's logs and can be rotated by changing `BRIDGE_MCP_SECRET`. OAuth is planned, for ChatGPT without a secret in the URL.
- **The Claude Code plugin keeps a copy of the endpoint and secret on disk.** Claude Code keeps them in secure storage, but plugin monitors can't read that, so a session-start hook writes them to `~/.claude/plugins/data/mcp-events-bridge-hookdeck/` (`mcp-url` and `mcp-secret`), readable only by you. Uninstalling the plugin deletes that directory.
- **Every event is verified.** Event Gateway verifies each service's own signature, and sources have no unverified option. The bridge's own inbound route, for Event Gateway's notifications, accepts only requests Event Gateway signed.
- **Each delivery is signed for its subscriber.** Event Gateway signs every attempt, retries included, with the subscriber's secret, which lives only in the subscription's Event Gateway destination. A refresh with a new secret replaces it at once: there's no window in which both are signed with (Event Gateway destinations take one key).
- **A pass-through callback URL verifies nothing.** Anyone who learns one can post to the agent's port through it, so the agent must check every delivery's signature (standard libraries do). A callback URL with a secret accepts only deliveries signed with it.
- **Event content is data, not instructions.** An email or issue can say anything. Filters narrow what triggers an agent: GitHub's `sender` is the authenticated user, but an email's `from` can be forged, so don't rely on it alone.
- **Webhook and poll delivery.** Push (`events/stream`) may come later if clients need it. Local agents receive webhooks through the Hookdeck CLI (above). Poll mode misses a request that takes more than 60 seconds to appear in Event Gateway's request listing (it took up to 15 when measured).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `setup` exits 1: "Setup isn't complete", then `<id>: set <VAR>` | A generic webhook's secret isn't set; everything else was set up | Register the printed URL with the sender, put the secret in `.env`, run `setup` again |
| `serve`: "Event Gateway isn't set up for deployment ..." | `setup` hasn't run with this deployment name and inbound mode | Run `setup` with the same `BRIDGE_DEPLOYMENT` and `BRIDGE_INBOUND` |
| `serve` exits: "The bridge's data model in Event Gateway changed in 0.8 ... must be migrated before serve starts" | The project has subscriptions or callback URLs from 0.7, and there's no terminal to ask in | Run `setup` (it asks), or start `serve --migrate`; see [`docs/UPGRADING.md`](docs/UPGRADING.md) |
| `serve` logs `<n> from 0.7 or earlier, not served until migrated` | The same, in a bridge started without the check (for example from code) | Run `setup` and migrate |
| ``Config: `providers` in the config is now `sources` ...`` (or another name "removed in 0.8.0") | A name deprecated in 0.6.0 | Rename it as the message says |
| `serve` logs `subscription ... is for "...", which this bridge doesn't offer` | The source was removed, its `id` renamed, or the subscription is from 0.1.0 (before `{id}.{event}` names); or it belongs to another bridge in the same Hookdeck project | The agent subscribes again, to a name from `events/list`; ignore another bridge's |
| `events/subscribe` fails with "Unknown event" | An old or wrong name | Use a name from `events/list` |
| A sender gets 401 | Wrong signature, header, encoding or secret | Match the source's `verification` or secret; a new secret can take about a minute to apply |
| An agent doesn't get an event | The subscription's filter didn't match, the event type isn't enabled, or the callback is failing | In the Event Gateway dashboard, the subscription's connection, `mcp-sub-<id>`, shows each request: `FILTERED` for a filter or an event type it doesn't offer, or the failed attempts. `list_sources` shows each source's events and subscriptions |
| `serve` logs `warning: <name> is a pass-through callback URL` | A subscription uses a callback URL created without a secret | Expected for Hermes Agent and the client libraries; the receiver must verify every delivery |
| Subscribing with a callback URL from the bridge fails with `CallbackEndpointError` | The URL was created with a different secret from the one subscribing | Create a callback URL with the secret you subscribe with (one URL holds one secret) |
| An event takes a minute or two | `hookdeck listen` occasionally takes ~30s to connect, and Event Gateway occasionally queues a CLI delivery | Wait: the bridge retries missed deliveries itself |
| The same event twice | Two bridges in one Hookdeck project, or a retry | One Hookdeck project per bridge; receivers dedupe by `webhook-id` |
| `setup` or `serve` warns `<event>'s description is ... characters` | A description in `source()` or `defineSource` over 400 characters; ChatGPT has been reported to leave such events out | Shorten it, then refresh the plugin in ChatGPT |
| Claude Code (plugin) reports `{"problem": "can't reach the bridge, still retrying: no MCP URL yet ..."}` | The plugin's MCP endpoint isn't set, or was set during this session | Set it, and the secret, with `/plugin configure mcp-events-bridge@hookdeck` in Claude Code (or pipe them to `claude plugin configure mcp-events-bridge@hookdeck --values-stdin`), then start a new session |
| Claude Code (plugin) never reports events | The session isn't interactive (`claude -p`), or nothing is watched in this project | Ask "what am I watching?"; plugin monitors run only in interactive sessions |
| Claude Code (plugin) reports events cut off | Monitor notifications shorten long lines | Nothing: Claude reads the whole event with `get_event` |

## Development

```sh
git clone https://github.com/hookdeck/mcp-events-bridge && cd mcp-events-bridge
npm install
cp .env.example .env      # fill in; the comments explain each variable
npm test                  # unit and in-process integration tests, with a fake Event Gateway
npm run typecheck
npm run build             # compiles to dist/, as published
npm run bridge -- setup   # the CLI from source; this repo's bridge.config.ts imports from ./src
```

`npm run e2e` checks the whole path against real services. It starts a bridge and `hookdeck listen`, subscribes test subscribers whose callbacks are Event Gateway MCP Events sources (they answer the spec's challenge; `hookdeck listen` forwards deliveries), sends real email through Resend, and checks delivery, filters, `get_event` and unsubscribe. `E2E_SOURCE=webhook` drives the same checks with signed fills to a webhook source instead of emails, so it sends no email and uses no Resend quota (needs `FILLS_WEBHOOK_SECRET`, as below). `E2E_GITHUB=1` adds a real GitHub push; `E2E_LOCAL=1` adds a mock local agent receiving through callback URLs from the bridge, with the bridge running `hookdeck listen` and retrying what the agent missed; `E2E_WEBHOOK=1` adds a webhook source, with the script as a trading server sending signed and wrongly signed fills (needs `FILLS_WEBHOOK_SECRET`, which enables the `fills` instance in this repo's `bridge.config.ts`, and `setup` run with it); `E2E_EXTENDED=1` adds retries, duplicates, a `410` and failing callbacks (about 10 minutes; the status-code subscribers use a cloudflared tunnel, since an MCP Events source acknowledges deliveries itself); `E2E_BRIDGE_URL=https://...` runs against a deployed bridge.

Issues and pull requests are welcome. [`AGENTS.md`](AGENTS.md) has the project's conventions, for people and coding agents alike.

Releases are published to npm by GitHub Actions when a maintainer creates a GitHub Release, following the [release skill](.claude/skills/mcp-events-bridge-release/SKILL.md).

## License

[MIT](LICENSE)
