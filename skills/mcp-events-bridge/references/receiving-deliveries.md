# Receiving deliveries through a tunnel URL

For an agent on the same machine as a local bridge that implements MCP Events webhook delivery itself (it calls `events/subscribe` and runs an HTTP receiver). Hermes Agent's MCP Events receiver works this way.

## Subscribe

1. Call the bridge's `create_tunnel_url` tool: `agent` (a name for this agent), `name` (one per subscription), `port` (the receiver's local port), `path` (the receiver's path; default `/events`). The first URL fixes the agent's port and path.
   - If the agent builds every callback URL from one base URL plus its own path (for example `<base>/mcp/events/webhook/<id>`), create **one** tunnel URL with `path: '/'` and use it as the base: a tunnel URL covers the paths under it, and the path is forwarded to the receiver.
2. Call `events/subscribe` with `name` (an MCP event name from `events/list`, e.g. `resend.email.received`), `arguments` (filters), and `delivery: { mode: 'webhook', url: <tunnel URL>, secret: 'whsec_...' }`. Generate the secret yourself (24 to 64 random bytes, base64, `whsec_` prefix).
3. Keep the subscription: refresh it (call `events/subscribe` again with the same key) before `refreshBefore`; unsubscribe with `name`, `arguments` and `delivery.url`.

The verification challenge is answered by Event Gateway at the tunnel URL; the receiver never sees it.

## Receive

Each delivery is a `POST` to `http://localhost:<port><path>` (plus any sub-path) with:

- `webhook-id`: the event id. **Dedupe on it**: delivery is at least once.
- `webhook-timestamp`, `webhook-signature`: [Standard Webhooks](https://www.standardwebhooks.com). The signature header carries **several** space-separated `v1,` entries (one is for Event Gateway's source); accept the request if **any** verifies with your secret, as standard libraries do. Reject timestamps more than 5 minutes old.
- `X-MCP-Subscription-Id`: which subscription it's for, so you can pick the secret (or route by path instead).
- Body: `{ "eventId", "name", "timestamp", "data", "cursor": null }`, at most 256 KiB.

Answer `2xx` quickly and do the work afterwards. Your status code doesn't reach the bridge (Event Gateway acknowledges at the tunnel URL), so a `410` doesn't stop deliveries: unsubscribe instead.

## Missed deliveries

If the receiver or the bridge's `hookdeck listen` was down, Event Gateway keeps the requests, and the bridge re-sends missed ones when `listen` reconnects: same `webhook-id`, fresh timestamp and signature, plus `x-mcp-bridge-retry-of`. Nothing to call.
