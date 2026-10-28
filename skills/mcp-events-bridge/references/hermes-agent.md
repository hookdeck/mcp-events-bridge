# Hermes Agent with a local bridge

[Hermes Agent](https://github.com/NousResearch/hermes-agent) v0.22.5 and later can subscribe to the bridge's events: each event starts an agent run, like any other Hermes webhook. With a local bridge, Hermes receives through a pass-through callback URL from the bridge.

**Status: experimental, in Hermes too** ("MCP Events (experimental)" in Hermes's MCP docs). Hermes implements webhook delivery only, from [hermes-agent#140121](https://github.com/NousResearch/hermes-agent/pull/140121).

**Tested:** Hermes Agent v0.22.5 against a local 0.8.0 bridge on 27 Oct 2026, with a pass-through callback URL from `callback-url create`: a subscription approved in chat, a signed fill delivered, verified by Hermes and acted on, and unsubscribing. (Also against 0.7 on 26 Oct, through a tunnel URL.)

The bridge is an ordinary MCP server in Hermes's `config.yaml`, with `events: true`, and `BRIDGE_MCP_SECRET` goes in an `Authorization: Bearer` header that reads the secret from Hermes's `.env`. Neither the model nor Hermes's subscription files see it. Hermes posts its callback URLs to the gateway's webhook listener (port 8644), which needs a public HTTPS address: a callback URL from the bridge.

That URL is **pass-through**: Hermes gives each subscription its own secret, under one base URL, and an Event Gateway source holds only one secret. So Event Gateway doesn't verify deliveries to it; Hermes verifies each one with the subscription's secret. The bridge skips the subscribe challenge for it, since it created the URL for Hermes, and logs a warning when Hermes subscribes. Hermes's approach conforms to the MCP Events spec; the limitation is Event Gateway's.

## 1. Install Hermes v0.22.5 or later

Install or update Hermes (see Hermes's README). Hermes needs three optional dependency groups for this:

- **`mcp`:** the MCP client's HTTP transport. Without it, the bridge fails to connect, with `requires HTTP transport but mcp` in `agent.log`.
- **`messaging`:** `aiohttp`, for the webhook listener. Without it, `gateway.log` has `Webhook: aiohttp not installed`.
- **Your model provider:** for example `anthropic`, used in step 4.

From a source checkout, which is how this was tested (needs Python 3.14 and [uv](https://docs.astral.sh/uv/)):

```sh
git clone --branch v0.22.5 https://github.com/NousResearch/hermes-agent.git && cd hermes-agent
uv venv --python 3.14 && uv pip install -e ".[anthropic,messaging,mcp]"
.venv/bin/hermes --version
```

**Success:** the version line starts `Hermes Agent v0.22.5`.

If you already use Hermes, set `HERMES_HOME` to a new directory for these steps (every `hermes` command below needs it), so they don't change your `~/.hermes`.

## 2. Run the bridge

Run a local bridge (`npx mcp-events-bridge serve`; see the [skill](../SKILL.md), steps 2 and 3) and leave it running.

## 3. Create a callback URL for Hermes

Hermes builds every callback URL from one public base URL plus `/webhooks/<route>`, so create one callback URL, with no secret and path `/`, for its webhook listener's port, 8644. Run it from the bridge's directory, with the bridge running, so `BRIDGE_MCP_SECRET` comes from its `.env`:

```sh
npx mcp-events-bridge callback-url create --agent hermes --name base --port 8644 --path /
```

**Success:** `base: https://hkdk.events/... -> http://localhost:8644/ (pass-through: your receiver verifies every delivery)`. That URL is Hermes's public URL.

## 4. Configure Hermes

In `$HERMES_HOME/.env` (by default `~/.hermes/.env`), the model provider's key, the bridge's secret, and the webhook listener's settings:

```sh
ANTHROPIC_API_KEY=...
BRIDGE_MCP_SECRET=...                # the bridge's, from its .env
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=...                   # for Hermes's own webhook routes; generate: openssl rand -hex 32
```

In `$HERMES_HOME/config.yaml`:

```yaml
model:
  default: "claude-haiku-4-5-20251001"
  provider: "anthropic"
mcp_servers:
  events-bridge:
    url: "http://127.0.0.1:8080/mcp"
    headers:
      Authorization: "Bearer ${BRIDGE_MCP_SECRET}"   # resolved from .env when Hermes connects
    events: true                                      # adds the event tools for this server
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      public_url: "https://hkdk.events/..."           # the callback URL from step 3
```

Hermes names the event tools after the server: `mcp_events_bridge_list_event_types`, `mcp_events_bridge_subscribe_event` and `mcp_events_bridge_unsubscribe_event`.

## 5. Start the Hermes gateway

```sh
.venv/bin/hermes gateway run
```

**Success:** `$HERMES_HOME/logs/gateway.log` has `[webhook] Listening on * (all interfaces, IPv4+IPv6):8644` and `✓ webhook connected`, and `curl http://localhost:8644/health` answers `{"status": "ok", "platform": "webhook"}`. Leave it running: events arrive only while it runs.

## 6. Subscribe

Hermes asks you to approve every subscription, because each one starts unattended agent runs, so subscribe in an interactive chat (a one-shot chat, with `--oneshot`, `-Q` or no terminal, declines):

```sh
.venv/bin/hermes chat
```

Then ask, for example:

> Subscribe to the bridge's resend.email.received event, and for each email summarize who it's from and what it's about.

Use an event name from the bridge (`mcp_events_bridge_list_event_types` lists them, with their filters). Hermes shows a "Subscribe to MCP event ... from server 'events-bridge'?" panel with the instructions and arguments: choose **Allow once**.

**Success:** Hermes reports `{"subscribed": {"name": ..., "refreshBefore": ...}}`, and `serve` logs `warning: base is a pass-through callback URL: ...` (expected) and `subscribed sub_...`.

## 7. Verify

Trigger a real event for the subscription (for example, send an email to the Resend receiving address).

**Success:**

- `serve` logs `[listen] agent hermes: ... [202] POST http://localhost:8644/webhooks/mcp-events-bridge-<id>`;
- `gateway.log` has `[webhook] POST ... delivery=mcp-event:<eventId>`, then `inbound message: platform=webhook` and `response ready`: the agent ran on the event. With the default destination (`log`), its answer is in `gateway.log` (`[webhook] Response for ...`). Ask for another destination when you subscribe (a Telegram or Slack chat Hermes is connected to, for example).

`BRIDGE_MCP_SECRET` is in no file under `$HERMES_HOME` but `.env`.

To stop, ask Hermes to unsubscribe (`mcp_events_bridge_unsubscribe_event` with the same event name and arguments; no approval needed). The bridge deletes the callback URL an hour after no subscription uses it.

## Keeping a subscription

Hermes asks for a 24-hour subscription. It refreshes subscriptions while a Hermes process is connected to the bridge, and subscribes again to all of them whenever it connects. **Not tested yet:** whether `hermes gateway run` alone keeps that connection between chats. Until it is, check `mcp_events_bridge_list_event_types` (each subscription's `refreshBefore`) after a day, or start a chat before then.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `gateway.log`: `Webhook: aiohttp not installed` | Install the `messaging` extra (step 1), then restart the gateway |
| Hermes says the `events-bridge` server isn't connected; `agent.log` has `requires HTTP transport but mcp` | Install the `mcp` extra (step 1) |
| Subscribing returns `The user did not approve this event subscription` | Subscribe in an interactive `hermes chat` and choose **Allow once**; one-shot chats decline |
| Hermes can't connect to `events-bridge` though the `mcp` extra is installed | `BRIDGE_MCP_SECRET` in Hermes's `.env` must match the bridge's, and the header must read `Bearer ${BRIDGE_MCP_SECRET}` |
| Subscribing says MCP events need `public_url` | Set `platforms.webhook.extra.public_url` to the callback URL (an `https://` URL) |
| Subscribing fails with a callback error | The callback URL was created with a secret: create one without (step 3), and use it as `public_url` |
| Subscribe fails with `Unknown event` | Use a name from `mcp_events_bridge_list_event_types`, such as `resend.email.received` |
| Deliveries stop after a busy spell | Hermes limits each route to 30 requests a minute by default; raise `platforms.webhook.extra.rate_limit` |
| The gateway can't bind port 8644 | Pick another port, in the callback URL (step 3), `WEBHOOK_PORT` and `platforms.webhook.extra.port` |

## Before v0.22.5

Earlier, the bridge was tested with Hermes's draft pull request [#132908](https://github.com/NousResearch/hermes-agent/pull/132908) (an `mcp_events` platform with named emitters, at commit `8813311330`), which is still open. Released Hermes took a different implementation, #140121, configured as above.
