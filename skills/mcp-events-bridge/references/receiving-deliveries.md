# Receiving deliveries through a callback URL from the bridge

For an agent on the same machine as a local bridge that implements MCP Events webhook delivery itself (it calls `events/subscribe` and runs an HTTP receiver). Hermes Agent's MCP Events receiver works this way.

## Subscribe

The agent is an MCP client of the bridge, over Streamable HTTP at the MCP URL. It needs no client capability for MCP Events: `initialize` as usual (with an MCP SDK client, or by hand: every `POST` sends `Accept: application/json, text/event-stream`, and requests after `initialize` send the `mcp-session-id` header its response returned), then:

1. Generate a secret: 24 to 64 random bytes, base64, with the `whsec_` prefix.
2. Get a callback URL: call the bridge's `create_callback_url` tool with `agent` (a name for this agent), `name` (a name for the URL), `port` (the receiver's local port), `path` (the receiver's path; default `/events`) and `secret`. The first URL fixes the agent's port and path. The URL is in the result's `structuredContent.url`. `agent` names an Event Gateway destination shared by the agent's URLs, so make it unique in the Hookdeck project (e.g. include the machine or user). From a setup script, `npx mcp-events-bridge callback-url create --agent <a> --name <n> --port <p> --secret-env <VAR>` does the same, reading the secret from an environment variable.
   - **With `secret`,** Event Gateway answers the subscribe challenge and accepts only deliveries signed with that secret. One URL holds one secret: subscribe with the same one, and to rotate it, create a new URL.
   - **Without `secret`,** the URL is pass-through (`passThrough: true` in the result): Event Gateway verifies nothing and doesn't answer the challenge, and the bridge skips the challenge for it. Use it if the agent uses a different secret for each subscription under one base URL plus its own path (for example `<base>/mcp/events/webhook/<id>`): create **one** URL with `path: '/'` and use it as the base. A callback URL covers the paths under it, and the path is forwarded to the receiver.
3. Call `events/subscribe` with `name` (an MCP event name from `events/list`, e.g. `resend.email.received`), `arguments` (filters), and `delivery: { mode: 'webhook', url: <callback URL, or a path under it>, secret: 'whsec_...' }`. The result is `{ id, refreshBefore, cursor, truncated }`; `id` is the subscription id in each delivery's `X-MCP-Subscription-Id` header.
4. Keep the subscription: refresh it (call `events/subscribe` again with the same key) before `refreshBefore`; unsubscribe with `name`, `arguments` and `delivery.url`.

## Receive

Each delivery is a `POST` to `http://localhost:<port><path>` (plus any sub-path) with:

- `webhook-id`: the event id. **Dedupe on it**: delivery is at least once.
- `webhook-timestamp`, `webhook-signature`: [Standard Webhooks](https://www.standardwebhooks.com), signed with your subscription's secret, freshly on every attempt. **Verify every delivery** with a standard library, and reject timestamps more than 5 minutes old. At a pass-through URL this is the only check: anyone who learns the URL can post to your port through it.
- `X-MCP-Subscription-Id`: which subscription it's for, so you can pick the secret (or route by path instead).
- Body: `{ "eventId", "name", "timestamp", "data", "cursor" }`, at most 256 KiB. `cursor` is a position in the event's history: keep the latest one (from deliveries and subscribe responses) and pass it to `events/subscribe` when you subscribe again, and the bridge replays what you missed.

Answer `2xx` quickly and do the work afterwards. Your status code doesn't reach the sender (Event Gateway acknowledges at the callback URL), so a `410` doesn't stop deliveries: unsubscribe instead.

## Missed deliveries

If the receiver or the bridge's `hookdeck listen` was down, Event Gateway keeps the requests, and the bridge retries missed ones when `listen` reconnects: same `webhook-id`, with a fresh timestamp and signature from Event Gateway. Nothing to call.
