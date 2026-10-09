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
| 5 | Hosted bridge | Build | Done: `E2E_EXTENDED=1 npm run e2e` passes 13/13 locally and 11/11 against Fly.io; ChatGPT received an email event on 6 Oct |
| 6 | Local agents | Build | In progress: tunnel URLs, with the bridge running `listen` and catching up by itself, built (`E2E_LOCAL=1`, PR #12); Hermes Agent's MCP Events pull request works end to end with the bridge, unpatched (7 Oct; [guide](../skills/mcp-events-bridge/references/hermes-agent.md), experimental); poll mode and the poll tools (#26, 0.3.0, 9 Oct) instead of a Claude Code channel; next, a Claude Code plugin that watches for events |
| 7 | Production readiness and reach | Build | Started: the GitHub provider, the generic webhook provider, the npm package (0.1.0) and the README done early; 0.2.0 (8 Oct): local agents (#12), generic webhooks (#14), `{id}.{event}` names (#17) and an agent skill (#16) |
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
8. **Issue feedback.** `bridge setup` enables webhook notifications to `bridge-hookdeck-notifications`, a connection to `/inbound/hookdeck`, and issue triggers for delivery (`mcp-sub-*`, `final_attempt`), request (`bridge-*` sources) and backpressure (`bridge-*` destinations). On a delivery issue with `410`, delete the subscription; otherwise record it and return `deliveryStatus` on refresh. Resolve the issue after acting on it.
9. **MCP server and auth.** `events/*` handlers plus `get_event` and `list_recent_events` (now `list_events`), served at `/mcp/<secret>` with the secret checked in constant time and redacted from logs.
10. **CLI entry.** `serve` and `setup`. `doctor`, `--prune` and `--rotate-mcp-secret` can be stubs.
11. **End-to-end script.** Start the bridge with CLI inbound (`hookdeck listen` to the bridge's port), run `bridge setup` with a Resend instance in the config, run the demo's test subscriber with a cloudflared callback, subscribe to `email.received`, and send an email.
12. **Deploy.** Dockerfile and a Fly.io config (no volume); set secrets, deploy, run `bridge setup`, and repeat the end-to-end script against the deployed bridge.
13. **ChatGPT.** Add the printed MCP URL in ChatGPT (Developer mode, "No Authentication"), subscribe from a Work chat, and send an email.

Done when (all verified live: `E2E_EXTENDED=1 npm run e2e`, and ChatGPT on 6 Oct):

- An email to the Resend address reaches the test subscriber, and `webhook-id` equals the `svix-id`.
- A `from` filter drops other senders.
- A forced publish failure for one of two subscribers makes the inbound event retry, and each subscriber receives the email once.
- A duplicate provider delivery doesn't reach a subscriber twice.
- `get_event` returns the summary.
- A subscription whose callback returns `410` is deleted from an Event Gateway delivery issue; one that keeps failing otherwise is recorded and returned in `deliveryStatus` on its next refresh.
- A request to the MCP endpoint without the secret is rejected.
- The bridge runs on Fly.io, and ChatGPT subscribes through the secret URL and receives an email event.
- `npm test` passes, and the end-to-end steps are in the README.

## Stage 6: Local agents (build)

Scope (decided 7 Oct): an agent on a laptop that implements MCP Events webhook delivery, with the bridge running on the same machine. One bridge per machine, with one owner, so nothing is shared between users. Delivery goes through Event Gateway and the Hookdeck CLI: the CLI connects out from inside the firewall, so the laptop gets a real webhook endpoint with Event Gateway's retries, and events wait while it's offline. Event Gateway's MCP Events source type (shipped 6 Oct 2026) answers the subscribe challenge and verifies deliveries.

Poll, push and cursor replay aren't part of this stage. They serve clients that can't receive webhooks wherever they run, so they're under "Later".

In order:

1. **Callback URLs (built, PR #12).** Each subscription gets its own MCP Events source with a connection to the agent's shared CLI destination. The bridge signs the challenge and deliveries with both the source's secret and the agent's (client-supplied at subscribe), so no secret passes through a tool. Missed deliveries are re-sent with a fresh signature, and unused URLs are deleted after an hour. A mock agent (an MCP client that subscribes in webhook mode and routes by `X-MCP-Subscription-Id`) proves it end to end: `E2E_LOCAL=1`, 16/16 on 7 Oct.
2. **The bridge runs `listen` and catches up by itself (built, PR #12).** Before, the agent ran `hookdeck listen` and called `retry_missed_deliveries`. Now:
   - `create_callback_url` became `create_tunnel_url`, which returns only the URL, port and path;
   - the bridge starts and supervises the agent's `hookdeck listen` with its own CLI login, and restarts it when a URL is created (a running `listen` only covers the connections it started with, until [hookdeck-cli#467](https://github.com/hookdeck/hookdeck-cli/issues/467));
   - the bridge retries missed deliveries after every (re)connect and on a timer, and `retry_missed_deliveries` left the MCP surface;
   - the bridge also recovers its own inbound: provider events that arrived while the laptop slept wait in Event Gateway as `CLI_DISCONNECTED` on the bridge's inbound connection, and are retried when `listen` reconnects;
   - `listen` is restarted with backoff if it exits, instead of stopping the bridge.

   The agent then needs no Hookdeck CLI or credentials: it asks for a URL and subscribes.
3. **A real local agent.** No released local agent harness supports MCP Events (searched 7 Oct; see "MCP Events clients" in `ARCHITECTURE.md`). Hermes Agent's draft pull request does, with our fixes, and works with the bridge; the e2e still uses the mock agent.
   - [x] Run Hermes Agent locally from its draft PR ([NousResearch/hermes-agent#132908](https://github.com/NousResearch/hermes-agent/pull/132908)) with `mcp_events` enabled, pointed at a local bridge (7 Oct; first with a local patch, then unpatched, below).
   - [x] Confirm, by running it, the mismatches found by reading the code. Hermes's own client code against the bridge (7 Oct): every request is rejected as invalid JSON-RPC (`-32600`, its top-level `_meta`); with that fixed, subscribe and unsubscribe fail with `name is required`. `refreshBefore`, the delivery body's `name` and the challenge need a patched client to reach.
   - [x] Probe path forwarding on an `MCP_EVENTS` source: the challenge at a sub-path is answered, and a delivery's sub-path is forwarded (with destination path `/`, exactly). Hermes builds every callback URL from one public base URL plus `/mcp/events/webhook/<local id>`, so the bridge needs to recognize sub-paths of a tunnel URL as that tunnel's.
   - [x] The bridge recognizes paths under a tunnel URL (for Hermes's one base URL).
   - [x] Patch Hermes locally and run it end to end (7 Oct): Hermes Agent from the PR branch (Claude Haiku), asked in chat, subscribed through a tunnel URL (local path `/`); a real email woke its agent in an `mcp_events` session; it unsubscribed in the spec's shape. The patch fixes the protocol mismatches plus plugin bugs found on the way (the adapter didn't start, tool calls failed, deliveries were dropped as an unauthorized user, and loopback emitters were refused once a secret was set).
   - [x] Comment on the PR with the findings and a link to the fixes, offered as a PR against the author's branch ([posted 7 Oct](https://github.com/NousResearch/hermes-agent/pull/132908#issuecomment-6042749607)).
   - [x] ~~If the author wants it, open the fixes as a PR against their branch.~~ Not needed: the author cherry-picked the eight commits into the pull request, and added the challenge answer, `authorization_is_upstream` and audit URL redaction (7 Oct).
   - [x] Retest the pull request's branch unpatched (`3cda1278a6`, 7 Oct): subscribe, a real email waking an agent session, and unsubscribe, with no allow-all-users setting; then again from a fresh install, following the [guide](../skills/mcp-events-bridge/references/hermes-agent.md) ([reply posted](https://github.com/NousResearch/hermes-agent/pull/132908#issuecomment-6047465909)). The tested commit is also kept on `leggetter/hermes-agent` (`mcp-events-pr-132908-3cda127`).
   - [x] Hermes's tools took the bridge's MCP URL, so its secret reached the model and Hermes's logs. We suggested named emitters; the author added them (`8813311330`). Retested 7 Oct with the URL only in Hermes's `.env`: subscribe and unsubscribe by name, a delivery waking a session, and the secret in no file under `HERMES_HOME` but `.env`. The guide uses them; the tested commit is kept on `leggetter/hermes-agent` (`mcp-events-pr-132908-8813311`).
4. ~~**Claude Code channel.**~~ Superseded 8 Oct: poll mode and the `poll_events` and `wait_for_event` tools (0.3.0) serve Claude Code, and a plugin monitor is next ([#26](https://github.com/hookdeck/mcp-events-bridge/issues/26)). Channels are a research preview that MCP Events support in Claude Code would replace.

Decided 7 Oct: every source keeps its own bridge-generated secret, and a tunnel URL also covers the paths under it. Agents that take a URL per subscription get one source each; a client that builds every callback from one base URL plus a path (Hermes) uses one tunnel URL as that base, so its subscriptions share one source.

Done when: the mock agent, given only a tunnel URL, receives an email; adding a subscription while events flow loses none, with no tool call; stopping `listen` (or the whole bridge), sending two emails and starting again delivers both, once each, with no tool call; and unused tunnel URLs are deleted.

## Stage 7: Production readiness and reach (build)

- Built-in single-user OAuth (auth tier 2), on a maintained library that supports CIMD and resource indicators.
- Bring your own identity provider (auth tier 3).
- Optional OpenAI Secure MCP Tunnel mode, for private networks.
- `bridge doctor`, `setup --prune` and `--rotate-mcp-secret`.
- Done early: the GitHub provider, with automatic and manual modes (see "Second provider: GitHub" in `ARCHITECTURE.md`); the npm package `@hookdeck/mcp-events-bridge` (0.1.0 on 6 Oct, 0.2.0 and 0.2.1 on 8 Oct, 0.3.0 with poll mode on 9 Oct), compiled to `dist/`; the README, restructured around it; and the generic webhook provider, for any HTTP sender with HMAC, Standard Webhooks, Basic auth or API key verification, with `providers add webhook <id>` to create its source before the secret exists (see "Generic provider: webhooks" in `ARCHITECTURE.md`).
- A release workflow (added 8 Oct): publishing a GitHub Release publishes to npm from GitHub Actions, with npm trusted publishing and provenance (`.github/workflows/release.yml`), and a `test` workflow on pull requests and `main`. Maintainers follow the `mcp-events-bridge-release` skill.
- Deploy docs and automation for Railway and Render.
- A Smithery listing.

## Later

Depends on Event Gateway features, a client that needs it, or later decisions:

- Standard Webhooks destination signing, then publish once per topic.
- Delivering straight from the provider source.
- Outpost for spec-conformant delivery, as an option.
- Poll mode (`events/poll`) from Event Gateway's stored requests, with cursor replay, for clients that can't receive webhooks. Tools wrapping it for hosts without MCP Events support.
- Push mode (`events/stream`). With a bridge on the same machine, a push-only client would connect over `localhost` and need no tunnel.
- An optional namespace so several bridges can share one Hookdeck project ([#13](https://github.com/hookdeck/mcp-events-bridge/issues/13)). Until then, one project per bridge.
