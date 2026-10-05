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
| 4 | Event Gateway topology and issue notifications | Spike | Ready |
| 5 | ChatGPT through Secure MCP Tunnel | Spike | Needs the maintainer |
| 6 | Hosted bridge | Build | Not started |
| 7 | Local agents | Build | Not started |
| 8 | Production readiness and reach | Build | Not started |
| Later | Depends on Event Gateway features | | |

Stages 3, 4 and 5 are independent and can run in any order. Stage 6 needs all three.

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

## Stage 5: ChatGPT through Secure MCP Tunnel (spike)

Question: does ChatGPT subscribe and receive through the tunnel, and what principal does it present?

Needs the maintainer. Run the Outpost demo server locally with no public tunnel. The maintainer creates the tunnel, points `tunnel-client` at the demo's MCP URL, and creates a Developer mode app with Tunnel as the connection. The maintainer subscribes from a Work chat, then run `npm run order`.

Passes when subscribe, the challenge and one delivery work. Record what identity, if any, reaches the MCP server, and anything that differs from the 1 Oct public-URL test.

## Stage 6: Hosted bridge (build)

The bridge running on Fly.io: Resend events relayed to the test subscriber and to ChatGPT, with issue feedback. Build in this order, with tests as you go.

1. **Shared pieces.** Port `secret.ts`, `standard-webhooks.ts`, `errors.ts`, `identity.ts` and `callback.ts` from the demo, splitting `callback.ts` as in "Module layout".
2. **Store.** The `Store` interface and the SQLite implementation. Pick `node:sqlite` or `better-sqlite3` and note why (lean `node:sqlite`: no native build).
3. **Event Gateway client.** Sources, connections, destinations, request and event listing, and the Publish API. Port from the fleet demo's `shared/src/hookdeck.ts` and keep its comments on the gotchas.
4. **Resend manifest.** Unit tests of `matches`, `eventId`, `occurredAt`, `summarize` and `accepts` against the stage 2 fixture.
5. **Config and setup.** `defineConfig`, `env()`, loading `bridge.config.ts`, and `bridge setup` for the Resend instance. `list_providers`.
6. **Subscriptions.** Port `subscriptions.ts` from the demo, creating and deleting the per-subscription Event Gateway resources. Long default lifetime; sweeper for expiry.
7. **Inbound route and relay.** Verify the Hookdeck signature, map, match, sign, publish in parallel, `200` only if all succeed.
8. **Issue feedback.** `bridge setup` enables webhook notifications to `bridge-hookdeck-notifications`, a connection to `/inbound/hookdeck`, and issue triggers for delivery (`mcp-sub-*`), request (`bridge-*` sources) and backpressure (`bridge-*-inbound`). The bridge records issues on the subscription or provider instance, reports them in `list_providers`, and returns `deliveryStatus` on refresh.
9. **MCP server.** `events/*` handlers plus `get_event` and `list_recent_events`, on `127.0.0.1`.
10. **CLI entry.** `serve` and `setup`. `doctor` and `--prune` can be stubs.
11. **End-to-end script.** Start the bridge with CLI inbound (`hookdeck listen` to the inbound port), run `bridge setup` with a Resend instance in the config, run the demo's test subscriber with a cloudflared callback, subscribe to `email.received`, and send an email.
12. **Deploy.** Dockerfile (bridge plus `tunnel-client`) and a Fly.io config with a volume for SQLite; deploy, run `bridge setup`, and repeat the end-to-end script against the deployed bridge.
13. **ChatGPT.** Through Secure MCP Tunnel to the deployed bridge, as in stage 5.

Done when:

- An email to the Resend address reaches the test subscriber, and `webhook-id` equals the `svix-id`.
- A `from` filter drops other senders.
- A forced publish failure for one of two subscribers makes the inbound event retry, and each subscriber receives the email once.
- A duplicate provider delivery doesn't reach a subscriber twice.
- `get_event` returns the summary.
- A subscription whose callback keeps failing shows up in `list_providers` and in `deliveryStatus` on its next refresh, from an Event Gateway delivery issue.
- The bridge runs on Fly.io, and ChatGPT subscribes through the tunnel and receives an email event.
- `npm test` passes, and the end-to-end steps are in the README.

## Stage 7: Local agents (build)

- Local agents through the CLI, including the Claude Code channel shim, using the MCP Events source type (in progress in Event Gateway) for the challenge and verification.
- The bridge on a laptop: CLI destination, `listen` supervisor and recovery from the fleet demo. Done when stopping `listen`, sending two emails and restarting delivers both, once each, and restarting during the roughly 2-minute grace window also delivers once.

## Stage 8: Production readiness and reach (build)

- Poll mode (`events/poll`).
- App-level encryption of subscription secrets (`BRIDGE_ENCRYPTION_KEY`).
- `bridge doctor` and `setup --prune`.
- The GitHub provider (see "Second provider: GitHub" in `ARCHITECTURE.md`).
- Deploy docs and automation for Railway and Render.
- A Smithery listing.
- The README.

## Later

Depends on Event Gateway features or later decisions:

- Standard Webhooks destination signing, then publish once per topic.
- Delivering straight from the provider source.
- A public MCP endpoint with OAuth.
