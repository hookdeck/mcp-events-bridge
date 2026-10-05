# Plan

The build runs as numbered **stages**, in order. Each stage is one of two kinds:

- **Spike:** a short experiment that answers a question and may change the design. Results go in [`SPIKES.md`](SPIKES.md).
- **Build:** working code with tests, toward a usable bridge.

Design and rationale are in [`ARCHITECTURE.md`](ARCHITECTURE.md). Update the status table when a stage starts or finishes.

## Status

| Stage | Name | Kind | Status |
| --- | --- | --- | --- |
| 1 | Repo setup | Build | Done |
| 2 | Resend inbound | Spike | Done ([results](SPIKES.md#stage-2-resend-inbound)) |
| 3 | Signed pass-through and retries | Spike | Done ([results](SPIKES.md#stage-3-signed-pass-through-and-retries)) |
| 4 | Event Gateway topology and issue notifications | Spike | Done ([results](SPIKES.md#stage-4-event-gateway-topology-and-issue-notifications)) |
| 5 | Hosted bridge | Build | In progress: steps 1 to 4 done |
| 6 | Local agents | Build | Not started |
| 7 | Production readiness and reach | Build | Not started |
| Later | Depends on Event Gateway features or later decisions | | |

## Stage 1: Repo setup

Git repo, package scaffold (TypeScript ESM, Node 22+, `tsx`, `vitest`, `zod` v4, MCP SDK v2, `standardwebhooks`), `.env.example`, and a read-only clone of `hookdeck-demos` for the fleet-demo code.

## Stage 2: Resend inbound (spike)

Question: does a `RESEND` source verify and deliver real `email.received` webhooks, and what are the manifest's field paths?

Upsert `spike-resend` with `--source-type RESEND` and a CLI destination. Create a Resend webhook for `email.received` at the source URL and set the returned `signing_secret` with `--source-webhook-secret`. Run `hookdeck listen` to a local endpoint that logs headers and body, and send an email to `RESEND_INBOUND_ADDRESS`. Then send one unsigned request and record what Event Gateway does.

Passes when Event Gateway accepts the email as verified, the endpoint gets it, and a redacted fixture is saved with the paths for event id, occurred-at, email id, from, to and subject.

## Stage 3: Signed pass-through and retries (spike)

Question: when Event Gateway retries a request the bridge signed, what changes?

Run a public receiver on a cloudflared quick tunnel that logs every attempt's headers and a SHA-256 of the raw body, verifies with `standardwebhooks`, and returns `500` first and `200` after. Upsert `spike-passthrough`: a `PUBLISH_API` source, an HTTP destination at the receiver, `--rule-filter-headers` on `X-MCP-Subscription-Id`, retry linear, 2 retries, 30 seconds, `--rule-retry-response-status-codes` `!410,!413`. Publish one request signed with the demo's `signStandardWebhook`.

Record: body hash across attempts and against the publisher's; which headers change, especially `webhook-timestamp` and `webhook-signature`; headers added or dropped; whether verification passes on the retry. Confirm a `410` stops retries and that `!410,!413` is accepted. Then fail a delivery, delete its connection while a retry is scheduled, and record whether another attempt arrives.

## Stage 4: Event Gateway topology and issue notifications (spike)

Question: does the topic-source topology route, dedupe and report problems as designed?

On the `spike-passthrough` source, add a second filtered connection and a dedupe rule on `headers.webhook-id`. Publish to each subscription, and the same request twice. Record: each connection gets only its own request; the duplicate becomes an ignored event; the `FILTERED` records on the other connection. Check filter behavior for later: `$in` on a string, array matching, case sensitivity.

Then enable webhook notifications to a `spike-notifications` source, add a delivery issue trigger on the spike connections, let a delivery fail, and save a redacted `issue.opened` payload: its shape, how it's signed, and whether it carries the failing response status (needed to act on `410`).

## Stage 5: Hosted bridge (build)

The bridge running on Fly.io: Resend events relayed to the test subscriber and to ChatGPT, with secret-URL authentication and issue feedback. Build in this order, with tests as you go.

1. **Shared pieces.** Port `secret.ts`, `standard-webhooks.ts`, `errors.ts`, `identity.ts` and `callback.ts` from the demo, splitting `callback.ts` as in "Module layout".
2. **Store.** Event Gateway as the store: subscriptions as connections with readable metadata in their descriptions and the signing secret in destination auth, indexed in memory at startup; an in-memory store for tests.
3. **Event Gateway client.** Sources, connections, destinations, issues and issue triggers, notifications, request and event listing, and the Publish API. Port from the fleet demo's `shared/src/hookdeck.ts` and keep its comments on the gotchas.
4. **Resend manifest.** Unit tests of `matches`, `eventId`, `occurredAt`, `summarize` and `accepts` against the stage 2 fixture.
5. **Config and setup.** `defineConfig`, `env()`, loading `bridge.config.ts`, and `bridge setup` for the Resend instance: inbound connection (`cli` in development, `http` when deployed), Resend webhook, and the MCP secret (generated and printed if unset). `list_providers`.
6. **Subscriptions.** Port `subscriptions.ts` from the demo, creating and deleting the per-subscription Event Gateway resources with the retry rule `[">=300", "!410", "!413"]` and dedupe on `headers.webhook-id`. Long default lifetime; sweeper for expiry.
7. **Inbound route and relay.** Verify the Hookdeck signature, map, match, sign, publish in parallel, `200` only if all succeed.
8. **Issue feedback.** `bridge setup` enables webhook notifications to `bridge-hookdeck-notifications`, a connection to `/inbound/hookdeck`, and issue triggers for delivery (`mcp-sub-*`, `final_attempt`), request (`bridge-*` sources) and backpressure (`bridge-*-inbound`). On a delivery issue with `410`, delete the subscription; otherwise record it, report it in `list_providers`, and return `deliveryStatus` on refresh. Resolve the issue after acting on it.
9. **MCP server and auth.** `events/*` handlers plus `get_event` and `list_recent_events`, served at `/mcp/<secret>` with the secret checked in constant time and redacted from logs.
10. **CLI entry.** `serve` and `setup`. `doctor`, `--prune` and `--rotate-mcp-secret` can be stubs.
11. **End-to-end script.** Start the bridge with CLI inbound (`hookdeck listen` to the bridge's port), run `bridge setup` with a Resend instance in the config, run the demo's test subscriber with a cloudflared callback, subscribe to `email.received`, and send an email.
12. **Deploy.** Dockerfile and a Fly.io config (no volume); set secrets, deploy, run `bridge setup`, and repeat the end-to-end script against the deployed bridge.
13. **ChatGPT.** Add the printed MCP URL in ChatGPT (Developer mode, "No Authentication"), subscribe from a Work chat, and send an email.

Done when:

- An email to the Resend address reaches the test subscriber, and `webhook-id` equals the `svix-id`.
- A `from` filter drops other senders.
- A forced publish failure for one of two subscribers makes the inbound event retry, and each subscriber receives the email once.
- A duplicate provider delivery doesn't reach a subscriber twice.
- `get_event` returns the summary.
- A subscription whose callback returns `410` is deleted from an Event Gateway delivery issue; one that keeps failing otherwise shows up in `list_providers` and in `deliveryStatus` on its next refresh.
- A request to the MCP endpoint without the secret is rejected.
- The bridge runs on Fly.io, and ChatGPT subscribes through the secret URL and receives an email event.
- `npm test` passes, and the end-to-end steps are in the README.

## Stage 6: Local agents (build)

Local delivery through Event Gateway and the Hookdeck CLI. Needs Event Gateway's MCP Events source type for the challenge; until it ships, a cloudflared callback stands in during development.

- **Subscriber command.** `mcp-events-bridge subscriber`: creates the agent's MCP Events source and CLI connection, supervises `hookdeck listen`, recovers events missed while offline (ported from the fleet demo's `recover.ts`), and forwards deliveries to the local agent.
- **Claude Code channel shim.** Built on the subscriber command; emits `notifications/claude/channel`.
- **Local bridge.** Inbound connection with a CLI destination, `listen` supervision and recovery; MCP endpoint on `127.0.0.1`; `bridge serve --tunnel` for ChatGPT through a cloudflared quick tunnel.
- **Poll mode** (`events/poll`) from Event Gateway's stored requests, with cursor replay; tools wrapping it for hosts without MCP Events support.

Done when a local agent subscribed through the subscriber command receives an email; stopping `listen`, sending two emails and restarting delivers both, once each; restarting during the roughly 2-minute grace window also delivers once; and a poll with a stale cursor returns the missed events.

## Stage 7: Production readiness and reach (build)

- Built-in single-user OAuth (auth tier 2), on a maintained library that supports CIMD and resource indicators.
- Bring your own identity provider (auth tier 3).
- Optional OpenAI Secure MCP Tunnel mode, for private networks.
- `bridge doctor`, `setup --prune` and `--rotate-mcp-secret`.
- The GitHub provider (see "Second provider: GitHub" in `ARCHITECTURE.md`).
- Deploy docs and automation for Railway and Render.
- A Smithery listing.
- The README.

## Later

Depends on Event Gateway features or later decisions:

- Standard Webhooks destination signing, then publish once per topic.
- Delivering straight from the provider source.
- Outpost for spec-conformant delivery, as an option.
- Push mode (`events/stream`), only if a client needs it.
