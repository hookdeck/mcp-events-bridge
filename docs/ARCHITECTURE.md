# MCP Events bridge: architecture

Status: draft, revised 7 Oct 2026. Repo `hookdeck/mcp-events-bridge`, npm package `@hookdeck/mcp-events-bridge`.

This is the design. The staged plan and its status are in [`PLAN.md`](PLAN.md), and spike results in [`SPIKES.md`](SPIKES.md). Agents working on the repo should also read `AGENTS.md` at the repo root.

## What it does

The bridge lets an agent subscribe to things that happen in apps whose vendors haven't shipped MCP Events. It turns a provider's ordinary webhooks into MCP Events.

- **Hookdeck Event Gateway** receives and verifies the provider's webhooks, and delivers every MCP Event to every subscriber with retries and a record of each attempt.
- **The bridge** is the MCP side: the event catalog, subscriptions, the challenge, and turning a provider webhook into signed MCP Events.
- **The Hookdeck CLI** is how anything local takes part: a local agent receiving events, or the bridge itself running on a laptop. The hosted path came first (stage 5); local agents are stage 6.

Worked example: Resend inbound email. Someone emails an address on Resend, Resend sends `email.received`, and a ChatGPT dot (or a local agent) subscribed to that event wakes up and acts.

## Goals and non-goals

Goals:

- Events for providers that haven't shipped MCP Events, starting with Resend.
- **Hosted first.** The bridge runs as a service with a public MCP endpoint that ChatGPT connects to directly.
- **Local agents through the Hookdeck CLI.** Events reach a laptop through Event Gateway and `hookdeck listen`, including events that arrive while it's offline.
- **Low friction for self-hosters.** Nothing beyond Hookdeck and the providers themselves is required: no identity provider, no tunnel service.
- **Built on Hookdeck.** Event Gateway and the Hookdeck CLI do the receiving, delivering and local delivery; where they can't yet, the design says what would close the gap (see "Evolution").
- Setup through a typed config file (`bridge.config.ts`) that a coding agent can edit: "add Resend inbound email".
- Event Gateway as the single record of every provider's events, inbound and outbound.
- A path to taking the bridge out of the data path entirely (see "Evolution").

Non-goals for now:

- **Wrapping provider APIs as tools.** Vendors' own MCP servers do that. Resend's already lists and reads inbound emails. The bridge supplies events only.
- **Hosting the bridge for other people.** That's the multi-tenant product and a separate decision.
- **A required identity provider or tunnel service.** Authentication starts with a secret URL; OAuth and tunnels are optional (see "Authentication").

## System overview

```mermaid
flowchart TB
    P["Provider<br>Resend"] -- "webhook, Svix-signed" --> SRC["Event Gateway<br>RESEND source"]
    SRC -- "inbound connection<br>HTTP destination" --> B["Bridge, hosted<br>map, match, sign"]
    B -- "Publish API<br>one request per subscriber" --> T["Event Gateway<br>topic source per MCP event"]
    T -- "connection per subscription<br>filter, dedupe, retry" --> CG["ChatGPT callback"]
    T -. "connection per subscription" .-> HS["Local agent's callback<br>MCP Events source"]
    HS -. "hookdeck listen" .-> LA["Local agent"]
    AG["Agent host<br>ChatGPT, or a local agent"] -- "MCP over HTTPS<br>secret URL or OAuth" --> B
```

The challenge at subscribe time is the one thing the bridge sends straight to a callback, because it needs the echo back synchronously.

## Delivery: the relay

The bridge sits between two Event Gateway sources and holds no event state. Event Gateway is the durable store on both sides.

1. Resend sends `email.received` to the RESEND source. Event Gateway verifies the Svix signature.
2. The inbound connection delivers to the bridge's public inbound route. The bridge verifies the Hookdeck signature.
3. The bridge maps the request with the provider manifest and matches it against live subscriptions.
4. For each match, it builds the MCP Events envelope, signs it with that subscriber's `whsec_` secret, and publishes it to the topic source with `X-MCP-Subscription-Id`.
5. If every publish succeeds, it returns `200`. If anything fails, it returns `5xx` and Event Gateway retries the inbound event.
6. Each subscription's connection passes only its own request and delivers it to the callback, with its own retries.

Rules that make it correct:

- **Partial failure produces duplicates.** If publishing to A succeeds and B fails, the inbound retry publishes to A again. Each subscription connection has a dedupe rule on `headers.webhook-id`, which is the provider's event id and stable across retries. Dedupe is best-effort with a window of at most 1 hour, so subscribers must still dedupe on `webhook-id`.
- **The inbound retry rule finishes inside the dedupe window.** For example, linear retries that end within an hour.
- **Publish to all matches in parallel,** so the inbound response stays well inside the destination timeout.
- **On an inbound retry, skip subscriptions created after the event's `occurredAt`,** so a retry doesn't hand a new subscriber an old event. A retry is Event Gateway's own (`x-hookdeck-attempt-count` above 1), a manual one (`x-hookdeck-attempt-trigger` other than `INITIAL`), or a request the bridge itself recovered after its `listen` was down (recognized by `x-hookdeck-requestid`, since that arrives as attempt 1 of a new event). A first attempt goes to every current subscription, because provider timestamps can predate the action: editing an old GitHub release keeps its `published_at`.
- **Outbound retries carry the first signature.** Event Gateway passes the published headers through unchanged, so a retry has the original `webhook-timestamp`. The spec says each retry attempt MUST regenerate the timestamp and signature, so this doesn't conform (see "Spec conformance"). Keep each subscription connection's retries inside 5 minutes, the window inside which receivers SHOULD accept a timestamp, until Event Gateway can sign Standard Webhooks itself. Stage 3 confirms the pass-through behavior.
- **The inbound connection also dedupes** on `headers.svix-id`, to drop fast provider retries before they reach the bridge. Best-effort, as above.

Both rules on dedupe come from the same caveat in the Event Gateway docs: "Deduplication is a best-effort feature and is not guaranteed."

## Event Gateway topology

Per provider instance (see "Configuration file"):

```text
source:      bridge-<instance id>                 (RESEND)
connection:  bridge-<instance id>-<deployment>
  dedupe:    include_fields [headers.svix-id], window <= 1h
  retry:     linear, finishing within the dedupe window
destination: bridge-<instance id>-<deployment> -> https://<bridge>/inbound/<instance id>
             (auth: Hookdeck Signature, verified by the bridge)
```

Per MCP event name (a topic), created on first subscribe:

```text
source:      bridge-out-<MCP event name, slugged> (PUBLISH_API: only Publish API requests accepted)
             e.g. bridge-out-resend_email_received: resource names allow only letters, digits, - and _
             (two names can slug alike, e.g. a_b.c and a.b_c; they share a source harmlessly,
             since each subscription's connection filters on X-MCP-Subscription-Id)
```

Per subscription:

```text
connection:  mcp-sub-<id>, from the topic source; description = readable metadata
  filter:    headers X-MCP-Subscription-Id = <id>
  dedupe:    include_fields [headers.webhook-id], window <= 1h
  retry:     exponential, bounded under 5 min, response_status_codes [">=300", "!410", "!413"]
destination: mcp-sub-<id> -> callback URL; auth = the signing secret (CUSTOM_SIGNATURE); the bridge signs
```

Why this shape:

- **One topic source per MCP event name,** not one shared source and not one source per subscription. A shared source records a `FILTERED` ignored event for every other subscription on every publish. A source per subscription has no filter noise but can't move to publish-once later. The topic source keeps the noise to that topic's subscribers and changes in place when Event Gateway can sign (below).
- **One destination per subscription,** even when two subscriptions share a callback URL. Today a destination has no auth, so sharing would work. Once Event Gateway signs, the subscriber's secret lives on the destination, and secrets are per subscription.

## Evolution

### When Event Gateway signs Standard Webhooks

This needs a Standard Webhooks destination auth type in Event Gateway. Today's destination auth methods are Hookdeck Signature, Custom SHA-256, Basic, API key and Bearer; both signature methods sign the body only.

Status: not available today. The subscription's secret already lives in its destination's auth config, so enabling it would be a switch of `auth_type`. Event Gateway already verifies Standard Webhooks on inbound sources; outbound signing would need the signer itself, per-destination secret rotation, and a choice of where `webhook-id` comes from.

What the feature has to do, for this design:

- sign `webhook-id.webhook-timestamp.body` with a `whsec_` secret held on the destination, producing `webhook-id`, `webhook-timestamp` and `webhook-signature`;
- sign fresh on every attempt, with `webhook-id` stable across attempts;
- take `webhook-id` from the request (a header such as `webhook-id`, or a body field), so it stays the provider's event id; Event Gateway's own event id differs per connection, so it can't be used when one request fans out to several subscribers;
- sign with both the old and new secret for a grace window after rotation (space-separated `v1,` signatures);
- allow a header prefix other than `webhook-`, as Standard Webhooks permits;
- validate the destination address at delivery time and not follow redirects, per the spec's SSRF rules.

Then the topology changes in place:

| | Now | With destination signing |
| --- | --- | --- |
| Publishes per event | One per matching subscriber | One per topic |
| Subscription connection filter | `X-MCP-Subscription-Id` | The subscription's arguments, e.g. `from` |
| Destination auth | None; the bridge signs | Standard Webhooks with the subscriber's secret |
| Partial-failure duplicates | Possible; dedupe absorbs them | Gone: one publish is accepted or not |
| Outbound retry window | Under 5 minutes | Normal; fresh signature per attempt |
| Subscriber secrets live in | The bridge | Event Gateway destinations |
| `FILTERED` records mean | Not this subscription | This subscriber's filter didn't match |

Matching moves into Hookdeck filter syntax, which has no regex and no documented case-insensitive matching. The bridge still builds the envelope, so it adds normalized fields before publishing (for example a lowercased bare `fromAddress` parsed from `Name <addr>`), and connection filters use only `$eq` and `$in`. Each manifest declares how its subscribe arguments map to a filter, and subscribe rejects arguments it can't express.

### Hookdeck capabilities that would simplify the design

| Capability | What it would replace or enable |
| --- | --- |
| Standard Webhooks destination auth in Event Gateway | Spec-conformant re-signing on every retry; publish once per topic (above) |
| An MCP Events source type, answering the challenge at the source | Shipped 6 Oct 2026. Local agents receiving through the Hookdeck CLI, and the e2e test subscribers without a tunnel (see "Local agents and the bridge on a laptop") |
| CLI redelivery of events missed while a session was disconnected | The bridge's retry of missed deliveries, which re-sends each one with a fresh signature (see "Missed deliveries") |
| CLI sessions that pick up newly matching sources ([hookdeck-cli#467](https://github.com/hookdeck/hookdeck-cli/issues/467)) | Restarting `listen` after each new tunnel URL, and the retry that covers the restart |
| An MCP Events source holding several secrets, selected by `X-MCP-Subscription-Id` | Nothing the bridge needs today, since it dual-signs; it would let one source serve a receiver whose senders sign with one secret each, as the spec's receiver model expects |
| Source updates that take effect at once (a secret change took 61 seconds to reach ingestion) | The bridge never changes a callback source's secret; overlapping old and new secrets during a rotation would make the delay harmless |
| A request/response mode for the Hookdeck CLI | The cloudflared tunnel for a local MCP endpoint, which needs synchronous responses |

### Outpost for delivery (future option)

Hookdeck Outpost already delivers Standard Webhooks with a fresh signature on every attempt, one destination per subscription, and retries; the Outpost demo passed OpenAI's MCP Events checklist that way on 1 Oct. Using it for the bridge's outbound side would close the re-signing gap today. It's a future option rather than the default because it adds a second service to run or sign up for, and the design keeps Event Gateway as the single product and the single record.

### Research: deliver straight from the provider source

The further step: attach each subscription's connection to the RESEND source itself, with a transformation that builds the envelope. Resend then reaches the agent through Event Gateway alone, and the bridge is control plane only (catalog, subscribe, challenge, connection lifecycle).

Nothing in MCP Events requires the MCP server to be the sender. A delivery is a webhook signed with the subscriber's secret; the signature is what the subscriber checks. The problems are practical:

- **Signing.** Blocked until Standard Webhooks destination auth exists. The interim workaround, signing inside a transformation, is poor: the runtime has no crypto (a pure-JS HMAC would have to be bundled), is synchronous with a 1-second limit, keeps the secret in transformation environment variables, and runs once per event so retries reuse the first timestamp.
- **Per-subscription values.** `X-MCP-Subscription-Id` differs per subscription, so each connection needs its own transformation (or some per-destination header). That's one transformation per subscription to create, update and delete.
- **Mapping runs in the transformation sandbox.** The manifest's `summarize` has to exist as transformation code: no IO, no async, 1 second. Providers whose webhook is too thin and needs an API call to build the event can't use this path; they keep the relay. Resend's `email.received` is metadata-only and would fit.
- **Two copies of the mapping.** The TypeScript manifest (catalog, schemas, tests) and the transformation code must agree. Lean: generate the transformation from the manifest and run the same code under vitest.
- **Failures happen outside the bridge.** A transformation error becomes a `TRANSFORMATION_FAILED` ignored event; nothing tells the subscriber. The bridge learns of it through Event Gateway issue notifications (see "Problem feedback from Event Gateway").
- **Filter expressiveness.** As above: arguments must map to Hookdeck filters, with normalization done in the transformation (rule order: transformation, filter, dedupe, retry).
- **Size.** The 256 KiB payload limit has to be enforced in the transformation.
- **What stays the same:** `get_event` and `list_events` already read from Event Gateway; the challenge is already sent by the bridge; expiry and unsubscribe already delete connections.

To answer before committing to it: whether a destination can carry a per-subscription static header, whether a transformation can be shared across connections with per-connection values, and how transformation failures are surfaced through the API. (Event Gateway documents no limits on the number of connections.)

## Problem feedback from Event Gateway

Event Gateway does most of the delivering, so the bridge needs to hear about problems it no longer sees directly. It uses Event Gateway's own issues and webhook notifications, delivered through Event Gateway like any other event:

```text
issue triggers ──> issue.opened / issue.updated ──> source bridge-hookdeck-notifications
  ──> connection bridge-notifications-<deployment> ──> https://<bridge>/inbound/hookdeck
```

Issue triggers, scoped by name pattern:

| Issue type | Scope | What it tells the bridge | Bridge action |
| --- | --- | --- | --- |
| Delivery, `final_attempt` | connections `mcp-sub-*` | A subscriber's callback is failing, with the response status (in practice from the project's default `first_attempt` trigger; see "Verified facts") | `410`: delete the subscription. Otherwise record it on the subscription, surface it in `list_providers` and `bridge doctor`, and return it in `deliveryStatus`. Then resolve the issue so the next failure notifies again |
| Request, rejection causes | sources `bridge-*` | The provider's requests fail verification, e.g. a rotated Resend secret | Mark the provider unhealthy; `bridge doctor` suggests re-running `bridge setup` |
| Backpressure | destinations `bridge-*` | The bridge is slow or down | Operator alert only |
| Transformation, `log_level` `fatal` | transformations `mcp-sub-*` (direct path, later) | Mapping is broken for a subscription | Mark the subscription unhealthy |

Notes:

- Webhook notifications are set per project (`PUT /notifications/webhooks` with `topics` and `source_id`). This project is dedicated to the bridge, so that's fine; in a shared project it would need agreeing.
- A delivery issue is aggregated per connection and response status (`aggregation_keys`: `webhook_id`, `response_status`, `error_code`). While it's open, further failures with the same key don't notify again, so the bridge resolves the issue (`PUT /issues/{id}` with `RESOLVED`) after acting on it.
- `issue.opened` carries the connection (`trigger_webhook`, including its `name`, which identifies the subscription), the failing attempt with its `response_status`, and the event (stage 4, `test/fixtures/hookdeck/issue-opened-delivery.json`). Resolving an issue sends `issue.updated`.
- Notifications are Hookdeck-signed deliveries like any other, so the inbound route verifies them the same way.
- New projects come with default issue triggers. `bridge setup` adds its own, scoped by name pattern; the most specific trigger wins.
- To check: whether every `TRANSFORMATION_FAILED` ignored event opens a transformation issue (direct path only).

Nothing goes back to the subscriber: if its callback is failing, there's no channel to reach it. Issue notifications are for the bridge and its operator.

## Local agents and the bridge on a laptop

Local delivery goes through Event Gateway and the Hookdeck CLI, so a laptop gets Hookdeck's durability: events are kept while it's offline and delivered when it reconnects.

**Scope (decided 7 Oct).** The bridge runs on the same machine as the agent: one bridge per machine, with one owner, in its own Hookdeck project (several bridges in one project would load and act on each other's resources; an optional namespace is [#13](https://github.com/hookdeck/mcp-events-bridge/issues/13)). Poll, push and cursor replay serve clients that can't receive webhooks wherever they run, so they're not part of local support (see "Clients that can't receive webhooks").

**Status.** Built (PR #12): tunnel URLs, dual signing, the bridge running `listen` for agents and retrying their missed deliveries by itself, recovery of its own missed inbound, and cleanup. Not yet: a real local agent (`PLAN.md`, stage 6, step 3).

### A local agent receiving events

A local agent subscribes like any other subscriber, with webhook delivery. The catch is that it has no public URL, and the challenge needs a synchronous answer. A plain Hookdeck source answers immediately with its own response, so the echo never comes back and subscribe fails with `-32015`. Local agents therefore receive through Event Gateway's MCP Events source type (`MCP_EVENTS`, shipped 6 Oct 2026) and the Hookdeck CLI, and the bridge creates the public URLs for them.

**Tunnel URLs from the bridge** (`create_tunnel_url`, `src/core/callbacks.ts`). An agent asks for one per subscription, then subscribes with it as the callback URL. The tool is offered only by a bridge with CLI inbound, the one on the agent's machine:

```text
agent-<agent>            CLI destination, shared by the agent's URLs (its local port and path, e.g. 3000 and /events)
agent-<agent>-<name>     MCP Events source + connection to that destination, one per URL
```

- **One source per subscription** keeps each subscription's history, retries and pause controls separate. All of an agent's subscriptions share one CLI destination, so they arrive on one local path and the agent routes them by `X-MCP-Subscription-Id`, which the spec requires so a receiver can pick the right secret. The shared destination also lets a rate limit protect the agent as a whole.
- **Paths under a tunnel URL.** A tunnel URL also covers any path under it: the bridge treats `<tunnel URL>/<path>` as that tunnel's, signing the challenge and deliveries with the source's secret, re-sending missed deliveries to the subscription's own URL, and counting the tunnel as in use. The source answers the challenge at a sub-path and forwards the sub-path through `listen` (probed 7 Oct). This is for clients that build every callback URL from one base URL plus a path, such as Hermes (`<base>/mcp/events/webhook/<id>`): they use one tunnel URL as the base, with local path `/`, so their subscriptions share one source (and its history), while each source still has its own secret.
- **Two secrets, two signatures.** The source's secret is generated by the bridge when it creates the URL and never leaves it. The agent subscribes with its own secret, client-supplied as the spec says, through `events/subscribe`, never through a tool. The bridge signs the challenge and every delivery to a tunnel URL with both (Standard Webhooks allows several `v1,` entries): the source verifies its signature and answers the challenge, the agent verifies its own. So the source never needs updating, and the agent rotates its secret without touching Event Gateway. Updating a source's secret instead was tested and took about 61 seconds to reach ingestion. Because the source's secret is the bridge's, a source shared by several subscriptions wouldn't tie their secrets together either.
- **Only the bridge's deliveries get through.** Unlike a general tunnel (cloudflared, ngrok), the source rejects anything not signed with its secret, so the URL can't be used to reach the agent's port.
- **The bridge runs `hookdeck listen` for the agent** (`src/host/local-runtime.ts`): one process per agent port, at most 10 sources each, with the bridge's own CLI login, so the agent needs no Hookdeck CLI or credentials. A running `listen` only receives the connections it resolved at startup ([hookdeck-cli#467](https://github.com/hookdeck/hookdeck-cli/issues/467) proposes sessions that pick up new sources), so the bridge restarts it when URLs are created or deleted (debounced, and the old process exits before the new one starts, so sessions never overlap), and retries what arrived in between. A process that exits is started again with backoff.
- **One local port and path per agent.** The first URL sets them (default `3000` and `/events`; the path is the shared destination's) and different ones are refused. At most 50 URLs per agent.
- **Status codes stop at the source.** The source acknowledges each delivery, so the agent's own response (a `410` to stop, a `5xx` to retry) never reaches the bridge's delivery. The agent unsubscribes instead.
- **Cleanup.** The sweeper deletes a URL's source and connection once no subscription has used it for an hour, not the moment one ends: an agent changing a subscription's arguments unsubscribes and subscribes again on the same URL, and an agent may create a URL before subscribing. The agent's destination stays. Tunnel URLs are always verified at subscribe (never from the verification cache), and a deleted URL's cached verification is dropped, so a subscription can't be recreated on a deleted source.
- **Identity.** An agent name is a label, not an identity: any client of the owner can create, list or retry for any agent name. That suits one bridge per machine.

**Missed deliveries are retried, freshly signed.** With a CLI destination and no session connected, a request is kept with an ignored event of cause `CLI_DISCONNECTED`; within roughly 2 minutes of a drop, events are created and then fail without a response. The bridge runs the retry after every (re)connect (the CLI prints "Connected" at startup and after each websocket reconnect), every 5 minutes as a backstop, and again shortly (up to 10 times) while a run isn't up to date, but only while the agent's `listen` is connected: a re-send while it's down is only ignored again. Each run makes two listings since a watermark: the tunnel source's requests (with headers and body, for re-sending; the source feeds only this connection) and the connection's events (`GET /events?webhook_id=`). Ignored events are only looked up for a request that has some and no event. It judges each event by its latest attempt:

- **Missed** (ignored as `CLI_DISCONNECTED`, or `FAILED` with no response): the bridge sends it again to the tunnel URL, with the same `webhook-id` and body and a fresh timestamp and signature (both secrets), plus `x-mcp-bridge-retry-of: <original request id>`. Event Gateway's own retry would resend the original timestamp, which a standard receiver rejects once it's over five minutes old.
- **Rejected by the agent** (`FAILED` with a response status): not retried.
- **Pending** (in flight, or not yet processed by Event Gateway) and **delivered**: left alone.

A new request takes a few seconds to appear in Event Gateway's listing, so a run straight after a re-send would see only the missed original and send it again (seen live on 7 Oct, when a timer run started 2 seconds after a reconnect run). So each re-send carries `x-mcp-bridge-resend-id`, and until a listing shows that re-send (or 3 minutes pass), its event counts as pending. The watermark (in the connection description) moves to two minutes before the run, only after a run that sent nothing and found nothing pending, so a run while `listen` is still offline, or racing Event Gateway's processing, loses nothing. Delivery is at least once; agents dedupe by `webhook-id`, as the spec asks.

**Retry, not replay.** In the spec, a *retry* is the sender attempting the same event again (same `eventId` and `webhook-id`, a new request with its own timestamp), and *replay* is the client asking, with a cursor, for events from a past position. This job retries deliveries lost on the way to the laptop. Cursor replay, for any client and delivery mode, is separate and later.

### The bridge's own inbound on a laptop

The same code runs on a laptop if the inbound connection uses a CLI destination instead of the bridge's public URL. Development has used this since stage 5: the config's inbound mode is `cli`, `bridge setup` upserts the inbound connection with a CLI destination at path `/inbound/<instance id>`, and `bridge serve` runs `hookdeck listen` to the bridge's port. Before starting it, `serve` checks that every connection the config implies exists, on the right source, with a CLI destination at the right path, and fails closed otherwise: `listen` would create default `<source>-cli` connections for a source without one. It then runs a single `hookdeck listen <port> <source>,<source>,...` covering every provider source plus the notifications source; given no connection name, `listen` uses each source's existing CLI connection (verified live). Requests forwarded by the CLI carry the same Hookdeck signature as HTTP deliveries (stage 2), so the inbound route doesn't change. No public URL or tunnel is needed for inbound.

Running it unattended on a laptop, as local agents need, brings back what the fleet demo solved:

- **Fail closed on missing connections:** built (above).
- **Supervising `listen`:** built. `serve` logs the CLI in with its own key (`hookdeck ci` into a private config), waits for the first "Connected", and restarts `listen` with backoff if it exits.
- **Recovering missed provider events** (`src/core/inbound-recovery.ts`, ported from the fleet demo's `recover.ts`): built. While the laptop sleeps, provider requests wait on the bridge's inbound connection as `CLI_DISCONNECTED` (or, within about 2 minutes of the drop, as events that failed without a response). After every (re)connect, and on the same timer while connected, the bridge retries them for its own connection only (`POST /requests/{id}/retry` with `webhook_ids`, or `POST /events/{id}/retry` for a settled failed event), and the relay signs fresh deliveries as usual. Each run filters on the connection: one listing of its events (`GET /events?webhook_id=`), and the source's requests that have ignored events (`ignored_count[gt]=0`; Event Gateway has no listing of ignored events across requests), the only ones looked at one by one. Events still in flight are left alone, and nothing is retried again within 3 minutes, since its retry may not be listed yet. The watermark is kept in a small file next to the CLI config, so a bridge started again after a weekend checks from where it stopped (the first run looks back a day).

A local agent on the same machine connects to the bridge's MCP endpoint on `127.0.0.1`. ChatGPT can't reach a local bridge's MCP endpoint without a public URL with synchronous responses, such as a cloudflared tunnel (see the README's quick start).

### Clients that can't receive webhooks

- **Poll** (`events/poll`): later, when a client needs it. Backed by Event Gateway's stored requests, with the cursor as a position in that history, so it also gives catch-up and replay. Hosts without MCP Events support (Codex CLI, Cursor) would get the same implementation as tools.
- **Push** (`events/stream`): later, only if a client needs it. With the bridge on the same machine, a push-only client would connect over `localhost` and need no tunnel, though events would skip Event Gateway's delivery records.

### MCP Events clients

Searched on 7 Oct 2026, for clients that subscribe (not servers that emit):

| Client | State | Delivery | Fit with the bridge |
| --- | --- | --- | --- |
| ChatGPT | Shipped (29 Sep) | Webhook, to a cloud callback | Verified with the bridge on 6 Oct |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent/pull/132908) | Draft PR, 4 Oct | Webhook, to a local receiver (`POST /mcp/events/webhook/<local id>`, one public base URL, one global `whsec_` secret) | With a local patch, yes: on 7 Oct it subscribed through a tunnel URL, a real email woke its agent, and it unsubscribed. As drafted, no: its requests aren't valid MCP (`_meta` placement), its subscribe and unsubscribe don't follow the sketch, and plugin bugs stop the receiver starting and the tools running |
| [pi-mcp-events](https://github.com/richardanaya/pi-mcp-events) (Pi coding agent) | 0.1.1 | Webhook, poll and push calls as tools; receives no webhooks itself | Poll or push only |
| [OpenClaw](https://github.com/openclaw/openclaw/issues/166586) | Feature request | Poll and push proposed; webhook deferred | None yet |

So no local agent works with the bridge unmodified today; the e2e tests use a mock agent, and Hermes works with a local patch. Run against the bridge on 7 Oct, Hermes's unmodified client code fails every request: its top-level `_meta` makes the message invalid JSON-RPC (`-32600` from the MCP SDK), and with that fixed, subscribe and unsubscribe fail with `name is required`. Hermes's receiver would suit a tunnel URL once it follows the spec: Event Gateway answers the challenge for it, and path forwarding on the tunnel source works for its path-per-subscription receiver (probed 7 Oct). Hermes uses one public base URL for every subscription, so its callback URLs are sub-paths of one tunnel URL, which the bridge recognizes as that tunnel's (see "Paths under a tunnel URL").

### When a public tunnel is used

Anything local is reached through the Hookdeck CLI by default, and a subscriber's callback through an MCP Events source. A plain public tunnel (cloudflared) is used only when the caller needs the local response synchronously. Today that means the spike receivers and the e2e subscribers that test status codes (`410`, `5xx`), whose responses Event Gateway acts on, and a local bridge's MCP endpoint for ChatGPT.

## Authentication

Single tenant: one deployment, one owner. Tiers, from least friction:

| Tier | How ChatGPT (or any MCP client) connects | Extra service | Stage |
| --- | --- | --- | --- |
| **1. Secret URL** (default) | `https://<bridge>/mcp/<secret>`, with "No Authentication" in ChatGPT | None | 5 |
| **2. Built-in single-user OAuth** | `https://<bridge>/mcp`; the bridge is its own authorization server, and the owner approves once with an admin password | None | 7 |
| **3. Bring your own identity provider** | `https://<bridge>/mcp`; tokens from the provider, verified against its published keys | Yes, optional | 7 |
| Optional: OpenAI Secure MCP Tunnel | For private-network deployments; `tunnel-client` beside the bridge | Yes, optional | 7 |

**Secret URL.** `BRIDGE_MCP_SECRET` should hold at least 32 random bytes, base64url (the generated one does; the bridge doesn't enforce it). If it's unset, `bridge setup` generates one and says where to set it (for example `fly secrets set`), then prints the full MCP URL to paste into ChatGPT. The URL is a credential: the bridge redacts the secret segment in its own logs and compares it in constant time. To rotate it, change `BRIDGE_MCP_SECRET` and redeploy (ChatGPT then needs the new URL); a `setup --rotate-mcp-secret` helper is planned. Every caller with the URL is the deployment's owner, so there is one principal, `owner`.

**Built-in OAuth.** For real tokens without a third party: authorization code with PKCE `S256`, the `resource` parameter copied into the token audience, ChatGPT's redirect URIs allowlisted, and client registration by CIMD (Client ID Metadata Documents) or dynamic registration. Built on a maintained library rather than hand-written; which one supports CIMD and resource indicators is still to check. The token subject becomes the principal.

**Bring your own identity provider.** `auth: { issuer, audience, allowedPrincipals }`: standard discovery and signature checks, so any compliant provider works.

## Process model

One service per deployment:

- **One HTTP listener** (`BRIDGE_PORT`): `POST /inbound/<instance id>` (Hookdeck-signed only, bodies up to 10 MiB, else `413`; runs the relay; `200` or `5xx`) and the MCP endpoint at `/mcp/<secret>` (or `/mcp` with OAuth): Streamable HTTP, stateless per the 2026-07-28 revision, as in `mcp-events-outpost-demo`. Deployed, it's public; on a laptop it binds to `127.0.0.1`.
- **The subscription index:** in memory, loaded from Event Gateway at startup (see "Data model").
- **The sweeper:** expires subscriptions and deletes their connections and destinations, and deletes tunnel URLs no subscription has used for an hour.
- **With CLI inbound, `hookdeck listen`:** one process for the provider and notification sources, and one per local agent port, supervised and restarted by the bridge, with recovery after each reconnect (see "Local agents and the bridge on a laptop").

## Module layout

```text
src/
  core/                 runtime-agnostic: fetch, and no node: imports except node:crypto
    providers/          provider types + one file per built-in provider (resend.ts, github.ts)
    config.ts           defineConfig, defineProvider, env(), config validation
    relay.ts            inbound routes: map, match (each event's accepts()), sign, publish; issue notifications
    catalog.ts          events/list from enabled providers, named {instance id}.{event}
    subscriptions.ts    subscribe, refresh, unsubscribe, sweep; challenge; TTL; per-subscription EG resources
    sign.ts             Standard Webhooks signing
    callback.ts         parse and check callback URLs, build the challenge; CallbackTransport interface
    store.ts            SubscriptionStore interface
    event-gateway-store.ts  subscriptions kept in Event Gateway: metadata in descriptions, secrets in destination auth
    memory-store.ts     for tests
    names.ts            Event Gateway resource names
    hookdeck.ts         Event Gateway API and Publish API client
    mcp.ts              MCP server: tools + hand-registered events/* handlers
    setup.ts            `setup`: Event Gateway resources, provider webhooks, issue feedback
    inbound-plan.ts     the inbound connections a config implies; `hookdeck listen` arguments
    event-history.ts    get_event and list_events, from Event Gateway's requests
    callbacks.ts        tunnel URLs for local agents: create, sweep unused, plan listen, retry missed deliveries
    inbound-recovery.ts recover provider events a local bridge missed while its listen was down
  host/
    callback-transport.ts  CallbackTransport over node:http(s) with a pinned, public-only DNS lookup
    server.ts           HTTP listener: inbound routes and the MCP endpoint (secret-URL check)
    cli-listen.ts       logs the CLI in; supervises `hookdeck listen` processes (restart, "Connected")
    local-runtime.ts    a laptop bridge's listen processes: inbound with recovery, local agents with retries
    load-config.ts      finds and loads bridge.config.ts (TypeScript through tsx)
  cli.ts                serve | setup (planned: setup --prune, doctor)
test/
```

Later: `adapters/claude-channel.ts`, built-in OAuth, and `core/poll.ts` (with cursor replay) if a client needs it.

The `core/` boundary keeps a serverless build possible. `node:crypto` is allowed because Workers (with `nodejs_compat`), Deno and Bun support it. Sending to a callback is not: the SSRF guard resolves the host, rejects non-public addresses and pins the connection to the checked IP, which `fetch` can't do. So `core/` calls a `CallbackTransport`, and `host/` implements it with `node:dns` and `node:http(s)`. A serverless host would supply its own. Today only the challenge uses it, since Event Gateway makes the deliveries.

### What to reuse

From `hookdeck/mcp-events-outpost-demo` (passed OpenAI's checklist with ChatGPT on 1 Oct):

| File | Use |
| --- | --- |
| `src/server/callback.ts` | `verifyEndpoint` (the challenge), `parseCallbackUrl`, public-address checks with `allowLocal`. Split on port: pure checks to `core/callback.ts`, `postToCallback` and the pinned lookup to `host/callback-transport.ts` |
| `src/server/identity.ts` | `deriveSubscriptionId` for idempotent subscribe |
| `src/server/errors.ts` | MCP Events error codes, including `-32015` for a failed challenge |
| `src/shared/secret.ts`, `src/shared/standard-webhooks.ts` | `whsec_` checks and signing |
| `src/server/subscriptions.ts` | Subscribe, refresh, unsubscribe and sweep; replace the Outpost calls with Event Gateway connection and destination management |
| `src/server/mcp.ts` | The pattern: the SDK has no MCP Events support, so `events/*` are registered by hand |
| `src/client/subscriber.ts` | The test subscriber |
| `scripts/tunnel.ts` | cloudflared quick tunnel, for a development test subscriber's callback |

From `hookdeck/hookdeck-demos/hookdeck/cli-fleet-fanout`:

| File | Use |
| --- | --- |
| `shared/src/hookdeck.ts` | API client and its documented gotchas |
| `per-machine/src/ensure-connection.ts` | Fail closed at boot (done: `serve` checks the inbound connections) |
| `per-machine/src/recover.ts` | Recovering the bridge's own inbound after a disconnect (done: `core/inbound-recovery.ts`) |
| `shared/src/machine.ts` | How `listen` is spawned and "Connected" detected (done: `host/cli-listen.ts`, with restarts) |

Also: `hookdeck/claude-channel-plugin` for the channel shim, and `hookdeck/webhook-skills` for per-provider event lists and verification details.

## Configuration file

The bridge is a technical product: whoever runs it configures credentials and deploys it. Configuration is a typed file, `bridge.config.ts`, and it's the single source of truth for which providers are set up. Setup "from an agent" means a coding agent editing this file and running `bridge setup`, not MCP tools.

```ts
// bridge.config.ts
import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
import { resend, github } from '@hookdeck/mcp-events-bridge/providers';
import { acmeCrm } from './providers/acme-crm';   // custom, written with defineProvider

export default defineConfig({
  deployment: 'prod',
  providers: [
    resend({ apiKey: env('RESEND_API_KEY'), events: ['email.received'] }),
    github({
      id: 'github-hookdeck',                      // instance id; defaults to the provider type
      token: env('GITHUB_TOKEN'),
      scope: { org: 'hookdeck' },
      events: ['issues', 'pull_request'],   // offered as github-hookdeck.issues, ...; subscribers filter by action, e.g. ['opened']
    }),
    acmeCrm({ webhookSecret: env('ACME_WEBHOOK_SECRET'), events: ['contact.created'] }),
  ],
  auth: { mode: 'secret-url' },                    // later: 'builtin-oauth' or { issuer, audience, allowedPrincipals }
  subscriptions: { defaultTtlMs: 30 * 24 * 3600_000 },
});
```

- **Secrets are `env()` references only,** so the file can be committed and reviewed.
- **Each provider entry is an instance** with an `id` (letters, digits, `-` and `_`, and not `hookdeck`, which is the notifications route), so one deployment can have several of the same provider (two Resend accounts, several GitHub orgs). Event Gateway resources are named after the instance id.
- **Providers are code.** Built-in providers ship with the package; a deployment adds its own with `defineProvider` and redeploys, with no fork and no bridge release.
- **The config is loaded at startup.** A TypeScript config is imported through `tsx`'s API (`tsImport`), so it works from source and from the published package, which ships compiled JavaScript in `dist/`. A serverless build would bundle the config as an ordinary module, so the `core/` boundary is unaffected.

Applying it:

- **`bridge setup`** upserts each instance's source and inbound connection and registers its provider webhook. Idempotent.
- **`bridge serve`** checks the config against Event Gateway at startup. With CLI inbound it fails closed if a declared instance isn't set up; with HTTP inbound it warns.
- **Planned (stage 7): `bridge doctor`** to report drift and unhealthy instances (see "Problem feedback from Event Gateway").
- **Removing an instance from the file deletes nothing.** Planned (stage 7): `bridge setup --prune` to clean up, so a bad deploy can't unregister webhooks by accident.

The bridge ships as the npm package `@hookdeck/mcp-events-bridge` with a CLI binary, `mcp-events-bridge`; the repo `hookdeck/mcp-events-bridge` holds the package and examples.

## Data model

No database. Event Gateway is the store, so the bridge is stateless and needs no volume:

- **Events:** never stored by the bridge; Event Gateway is the record of every event.
- **Subscriptions:** one connection each, `mcp-sub-<id>`, from the topic source to an HTTP destination at the callback URL:
  - **connection description:** readable JSON metadata, so the operator can see it in the dashboard: `{"v":1,"principal":…,"event":…,"arguments":…,"expiresAt":…,"createdAt":…,"updatedAt":…}`, plus `delivery` while it isn't healthy. At most 500 characters; subscribe rejects arguments that don't fit.
  - **destination auth:** the signing secret, as `CUSTOM_SIGNATURE` config. This is Event Gateway's field for credentials: masked in the dashboard and in every listing, returned only by `GET /destinations/{id}?include=config.auth`. It's also where the secret will be used once Event Gateway can sign Standard Webhooks.
- **Topics:** found by name, `bridge-out-<event name, slugged>`.
- **Provider instances:** found by name, `bridge-<instance id>` and `bridge-<instance id>-<deployment>`, with the provider's webhook id in the source description.

At startup the bridge lists `mcp-sub-*` connections, reads each destination's secret, and builds an in-memory index; subscribe, unsubscribe, refresh and issue handling keep it current. That assumes one bridge instance per deployment, which fits single tenancy. A description edited into something unreadable is skipped and reported at startup.

Two consequences of keeping the secret in destination auth:

- **An extra header.** With `CUSTOM_SIGNATURE`, Event Gateway adds an HMAC of the body under `x-mcp-bridge-hmac` to each delivery (verified live). Subscribers ignore it; it reveals nothing about the secret. It goes away when the destination switches to Standard Webhooks auth.
- **The previous secret during a rotation has no slot,** so it's kept in memory for its grace window. A restart inside the window ends dual-signing early (dual-signing is a SHOULD).

The description format is versioned (`{"v":1,…`) so a sealed, encrypted format could be added later, for example for multi-tenant hosting, and told apart when reading.

## Provider manifests

Manifests describe events. They don't wrap provider APIs, apart from registering the webhook at setup. Built-in and custom providers are both written with `defineProvider`, which returns the factory used in the config file.

```ts
const resend = defineProvider({
  type: 'resend',
  displayName: 'Resend',
  sourceType: 'RESEND',                  // Event Gateway source type
  options: z.object({                    // typed config options: credentials and setup arguments
    apiKey: secretRef(),
    events: z.array(z.enum(['email.received'])),
  }),
  events: [/* ProviderEvent */],
  register?(ctx: { sourceUrl: string; providerEvents: string[]; options: ResolvedOptions; fetch: typeof fetch }):
    Promise<{ webhookId: string; signingSecret: string }>;
  unregister?(ctx: { webhookId: string; options: ResolvedOptions; fetch: typeof fetch }): Promise<void>;
  nativeMcpEvents?: { serverUrl: string; events: string[] }; // vendor ships its own
});

interface ProviderEvent<Args, Summary> {
  name: string;                        // the provider's event name: "email.received" (offered as "<instance id>.email.received")
  description: string;
  providerEvent: string;               // the provider's event type
  matches(req: InboundRequest): boolean;
  eventId(req: InboundRequest): string;     // stable provider id
  occurredAt(req: InboundRequest): string;  // ISO 8601
  summarize(req: InboundRequest): Summary;  // well under 256 KiB; includes normalized fields
  inputSchema: JsonSchema;             // subscribe arguments
  parseArguments(args: unknown): Args; // validate and normalize (e.g. lower-cased addresses); throws on invalid input
  accepts(args: Args, summary: Summary): boolean;
  toFilter?(args: Args): HookdeckFilter; // for matching in Event Gateway later
  payloadSchema: JsonSchema;
}
```

`register()` matters beyond convenience: the signing secret the provider returns goes straight onto the Event Gateway source and never enters the model's context.

Resend, first manifest (settled in stage 2; see `SPIKES.md` and `test/fixtures/resend/email-received.json`):

- `sourceType`: `RESEND`. Event Gateway verifies Resend's Svix signature.
- `register()`: Resend's create-webhook API with the source URL and `email.received`; it returns `signing_secret`.
- `matches`: `body.type === "email.received"`.
- `eventId`: the `svix-id` header.
- `occurredAt`: `body.data.created_at` (the received email's time, millisecond precision).
- `summarize`: `emailId` (`data.email_id`), `from`, `to`, `cc`, `subject`, `messageId`, `attachmentCount`, plus normalized `fromAddress` and `toAddresses` (bare, lowercased). Resend sent a bare `from` in stage 2, but normalization stays. The webhook carries metadata only; the body comes from Resend's own MCP server.
- `inputSchema`: `from` and `to` filters, matched on the normalized addresses. Recommend `from` in the event description, since it limits who can wake the agent.

## Adding a provider

Three built-in providers exist: Resend and GitHub, each with an Event Gateway source type, and generic webhooks, on a `WEBHOOK` source with verification configured (see "Generic provider: webhooks").

| Step | What it is | Deploy needed? |
| --- | --- | --- |
| 1. A provider definition exists | Built in, or a custom `defineProvider` in the deployment's own code | Built in: no. Custom: part of the deployment |
| 2. Add an instance to `bridge.config.ts` | Options, events, and `env()` references for credentials | Yes: set the secrets and redeploy |
| 3. `bridge setup` | Creates the source and inbound connection, registers the provider webhook | No, a one-off command (or part of the deploy) |
| 4. Subscribe | Agents call `events/subscribe`; ChatGPT needs "Refresh tools" to see new events | No |

Nothing else in the deployment changes per provider. The inbound route is generic (`/inbound/<instance id>`), and topic sources and subscription connections are created on demand.

Gaps, and where the config file leaves them:

1. **No webhook-creation API.** Many providers only set up webhooks in their dashboard. Solved as far as it can be: `mcp-events-bridge providers add webhook <id>` creates the source and prints its URL before the secret exists (most providers show the secret only after the URL is registered), holds delivery until the secret is set, and adds the config entry and the empty `.env` variable; `bridge setup` then sets the secret on the source and connects it. The manual paste into the provider's dashboard remains.
2. **No Event Gateway source type.** Solved: the generic `webhook()` provider uses a `WEBHOOK` source with HMAC, Standard Webhooks, Basic auth or API key verification, and `defineProvider` has `sourceConfig` for the verification config (setup keeps the source's config equal to it) and `missingCredentials` for credentials not set yet.
3. **Where the provider key lives.** Solved: in the deployment's env, referenced from the config. `setup` and `--prune` run from the deployment and need it.
4. **Thin webhooks.** Providers that send an id and expect you to fetch the rest put an API call in the relay. It fits the relay (a failure returns `5xx` and retries) but is untested.
5. **More than one instance** of a provider. Solved: instance ids, and MCP event names of the form `{instance id}.{event}`, so instances offering the same event don't clash.
6. **Provider-specific setup arguments,** such as which GitHub repository or organization. Solved: typed `options`.
7. **Manifests as code or data.** Solved for now: code, written in the deployment's own config when it isn't built in. A declarative format can still come later if most providers turn out to be header and JSON-path lookups.

### Second provider: GitHub

GitHub has about 70 webhook event types, most with several actions, and payloads of up to hundreds of KB, so it isn't mapped event by event:

- **One event per GitHub event type:** `issues`, `pull_request`, `push`, `workflow_run`, and so on (26 types), offered as `github.issues` and so on with the default instance id. The action is a subscribe filter, not part of the name.
- **A generic summary for every type,** from the fields all GitHub payloads share: `event`, `action`, `repository` and `sender` (lower-cased), and the main object's `title`, `number` and `url`. The most-used types add a few fields: labels and state for issues, merged and branches for pull requests, ref, commit count and head commit for pushes, conclusion for workflow runs. Text is capped at 500 characters.
- **Arguments on every type:** `repository`, `actions` and `sender`.
- **The config chooses the types:** `github({ events: [...] })`; the default is issues, issue comments, pull requests, reviews, pushes, releases and workflow runs, and `['*']` enables all. The webhook is registered for exactly those types.
- **Scope:** a list of repositories (`{ repos: ['owner/name', ...] }`) or an organization (`{ org: 'name' }`). Personal accounts have no account-wide webhooks, and organization webhooks need an org admin, so the list is the common case. Every repository's webhook points at the same `GITHUB` source with the same secret; the payload names the repository, and subscribers filter on it.
- **Secret:** GitHub lets the caller choose it, so `register()` generates one and sets it on the source, which verifies `X-Hub-Signature-256`.
- **Manual mode:** `github({ webhookSecret })`, with no token or scope. Setup creates the source with that secret and prints the source URL; you add webhooks to any repositories yourself. Only deliveries signed with the secret get past Event Gateway, so "any repository" means any repository you configured. A GitHub App would make this automatic across installations; that's later.
- **No ids stored:** the bridge finds its webhooks by URL (the source URL), so it doesn't keep an id per repository in the 500-character source description. Registering updates a webhook in place if one already delivers to the source, so re-running after a partial failure doesn't duplicate webhooks.
- **Changing the list:** setup keeps a fingerprint of the repositories and the enabled events in the source description. When either changes, it updates the webhooks and reuses the source's secret, so deliveries in flight still verify. Removing a repository from the list leaves its webhook in place; delete it in the repository's settings, or its events keep arriving (subscribers filtering by repository won't see them).
- **Event id:** `X-GitHub-Delivery`, also the inbound dedupe field. **Occurred-at:** the main object's latest timestamp, else the push's head commit, else the time received. The `ping` sent when a webhook is created matches no event and is ignored.

Several GitHub instances (for example one per organization) can be configured side by side: their events are named by instance id (`github-hookdeck.issues`, `github-acme.issues`), so they don't clash. One instance with a repository list or an organization, filtered by `repository`, still covers the common case.

### Generic provider: webhooks

For senders with no Event Gateway source type: a service you run yourself (the motivating case: trading agents polling an orders tool every bar to see whether an order filled, which would rather subscribe to a fill), or a provider without built-in support. Everything is static config in `bridge.config.ts`; the provider is `webhook({...})`, which builds a provider definition per instance, since its events come from the config.

- **Source:** `bridge-<id>`, type `WEBHOOK`, with the verification Event Gateway supports for generic sources: `HMAC` (`algorithm` `sha1`, `sha256` or `sha512`; `encoding` `hex`, `base64` or `base64url`; a header), `STANDARD_WEBHOOKS`, `BASIC_AUTH` and `API_KEY` (a header). MD5 isn't offered. Verification is required: an unverified source would let anyone with the URL wake agents with content they choose, and agents act on event content.
- **Credentials:** `env()` references, resolved inside the `verification` object (`resolveConfig` now resolves nested references). Setup writes the source config only when the type or a field differs, so re-running doesn't churn the secret.
- **URL before secret:** most senders show their secret only after the URL is registered. The instance's `env()` references are made optional, and `missingCredentials` reports the unset ones: setup then creates the source (no verification) and prints its URL, but creates no inbound connection, `setup` then exits with an error naming the variable (after setting up everything else), and `serve` fails closed. Requests that arrive meanwhile are kept by Event Gateway, rejected as `NO_CONNECTION`, and never delivered on their own. `mcp-events-bridge providers add webhook <id>` does this from flags, and writes the `.env` variable and (with `--write-config`) the config entry.
- **Only verified requests:** each event's `matches` requires `x-hookdeck-verified: true`, which Event Gateway sets on delivery and overwrites if the sender sent it. That covers the windows where the source accepted requests unverified: before the secret was set (a request kept then can be retried by hand once the connection exists, and is delivered) and while a new secret reaches Event Gateway's edge.
- **Events:** one or more MCP event names. With one and no `eventType`, every request is that event. Otherwise `eventType` (a header or a body dot path) is read, and each event's `value` (default: its name) picks it; other values are ignored.
- **Event id:** a header or body path, which is also the inbound dedupe field (`headers.<name>` or `body.<path>`) and, for a header, `eventIdHeader` for `get_event`. Default: `x-hookdeck-requestid`, Event Gateway's request id, which is stable across Event Gateway's retries of the inbound event but not across the sender's own retries (each is a new request), so there's no inbound dedupe rule then. A missing configured id throws, so the inbound event fails visibly. Event Gateway treats a missing dedupe field as an empty string, so requests that lack the header would dedupe against each other; they fail in the bridge anyway.
- **Occurred-at:** a body field (ISO 8601, or Unix seconds or milliseconds); else the time received, as GitHub's last fallback.
- **Data:** the JSON body as sent, optionally narrowed to top-level `fields`; a non-object JSON body is wrapped as `{ body }`. The relay's 256 KiB envelope limit applies, and a non-JSON body is ignored with `200` (a `4xx` would only make Event Gateway retry it); the request stays in Event Gateway.
- **Arguments:** equality filters on declared top-level `filters` (string, number or boolean, compared as strings), as a strict JSON Schema object, so an agent subscribes with `{ "symbol": "AAPL" }`. Filters must be among `fields` when both are set.
- **History:** `list_events` maps stored requests too: the event history adds `x-hookdeck-requestid` and `x-hookdeck-verified` (from the request's `verified`) to each stored request's headers, as delivery would. `get_event` finds events by a header id only.

The config edit in `providers add webhook --write-config` splices the entry into the `providers` array at positions from the parsed AST, so the rest of the file keeps its formatting, and adds the `webhook` and `env` imports through magicast (a small library for programmatic config edits, on Babel's parser; loaded only by this command). The result is re-parsed and checked, then written through a temporary file and a rename. It refuses, and prints the entry instead, when the default export isn't `defineConfig({...})` or an object literal, `providers` isn't an array literal or contains a spread (providers enabled conditionally, as in this repo's own config), or the import paths can't be inferred.

## MCP surface

Handlers registered by hand:

- `events/list`: the catalog from configured providers. Each event is named `{instance id}.{event}`, where `event` is the provider's own name for it (`resend.email.received`, `github.issues`, `fills.order.filled`): the catalog says which provider an event comes from, and instances can't clash.
- `events/subscribe`: validate, check the callback, send the challenge, create the subscription's Event Gateway resources, store, return `id` and `refreshBefore`.
- `events/unsubscribe`.

Tools:

- `list_providers()`: configured instances, their events, and how many subscriptions each has.
- `create_tunnel_url(agent, name, port?, path?)` and `list_tunnel_urls(agent)`: tunnel URLs for local agents, on a bridge with CLI inbound (see "A local agent receiving events"). Results carry the URL, port and path, never secrets.
- `get_event(name, eventId)` and `list_events(name?, since?, limit?)`: events that happened, read from Event Gateway (not the catalog of event kinds, which is `events/list`). These also work around openai/codex#50714, where dot runs don't receive event data.
- Later, if a client needs it, poll mode: `events/poll` (`name`, `arguments`, `cursor`, `maxAgeMs`, `maxEvents`), read from Event Gateway's stored requests on the provider source; the cursor is a position in that history. Advertise `"poll"` in each event's `delivery` once built. If a host supports neither MCP Events nor `events/poll`, expose the same implementation as `poll_events` and `wait_for_event` tools.

There are no setup tools: providers change through the config file.

## Flows

### Set up a provider instance (`bridge setup`)

1. Upsert the source `bridge-<instance id>` and the inbound connection `bridge-<instance id>-<deployment>` to the bridge's inbound URL, with the dedupe and retry rules above. Fail if it fails.
2. If the provider has `register()`, create the provider webhook at the source URL and set the returned secret on the source. Otherwise set the secret from the instance's options and print the source URL.
3. Record the instance. Its events join the catalog.

`bridge setup` also ensures the deployment-wide pieces: webhook notifications to `bridge-hookdeck-notifications`, its connection to the bridge, and the issue triggers in "Problem feedback from Event Gateway".

Planned (stage 7): `bridge setup --prune` handles instances that are in the store but not in the config: it unregisters the provider webhook, deletes the inbound connection, and deletes the instance's subscriptions and their resources.

### Subscribe

1. Validate the event name, arguments and `whsec_` secret.
2. Check the callback: `https`, and resolving only to public addresses. The challenge goes over a pinned connection that never follows redirects. (A host allowlist, such as ChatGPT's receiver host, is planned.)
3. Send the signed challenge directly and check the echo. On failure return `-32015`.
4. Derive the subscription id. Upsert the topic source if it's the first subscription to this event, then the subscription's destination and connection.
5. Store and return `id` and `refreshBefore`. Use a long default lifetime: ChatGPT sent no `ttlMs` in the 1 Oct test.

### Receive and relay

As in "Delivery: the relay". Envelope: `eventId` is the provider id, `timestamp` is when the event happened, `data` is the summary, plus `X-MCP-Subscription-Id`. Sign fresh for each publish; an inbound retry re-signs.

### Refresh, expiry and unsubscribe

A refresh with the same parameters updates expiry (and the secret, if it changed). The sweeper deletes expired subscriptions with their connections and destinations. Unsubscribe does the same immediately. Delete the topic source when its last subscription goes.

## Environment

Secrets and per-host values, referenced from `bridge.config.ts` with `env()`:

- `HOOKDECK_API_KEY`: a Project API key, for the Event Gateway API and the Publish API.
- `HOOKDECK_SIGNING_SECRET`: to verify Hookdeck signatures on the inbound route.
- `BRIDGE_INBOUND`: `http` (deployed; the default when `FLY_APP_NAME` is set) or `cli` (development; inbound through `hookdeck listen`).
- `BRIDGE_PUBLIC_URL`: for `http` inbound, an optional override for the base URL Event Gateway delivers to. Unset, it comes from `FLY_APP_NAME` (`https://<app>.fly.dev`). `bridge setup` fails if `http` inbound has no `https` URL.
- `BRIDGE_PORT`.
- `BRIDGE_DEPLOYMENT`: names this bridge's inbound connections, notifications connection, issue triggers and CLI devices, so bridges sharing a project stay apart. Default: `local` with `cli` inbound, `public` with `http` inbound; `deployment` in `bridge.config.ts` takes precedence.
- `BRIDGE_MCP_SECRET`: the secret path segment of the MCP URL (see "Authentication").
- Provider credentials, under whatever names the config references, for example `RESEND_API_KEY`.
- Optional, stage 7: `CONTROL_PLANE_API_KEY` and `OPENAI_TUNNEL_ID`, for `tunnel-client` (Secure MCP Tunnel).
- `.env.example` lists them all.

## Security

- The inbound route accepts only Hookdeck-signed requests.
- The MCP endpoint is protected by the secret URL by default (see "Authentication"). The URL is a credential: it's redacted from the bridge's logs and can be rotated. OAuth tiers give per-request tokens instead. On a laptop the listener binds to `127.0.0.1`.
- Topic sources are `PUBLISH_API`, so only holders of the project API key can publish to them.
- Callbacks must be `https` and resolve only to public addresses, checked at subscribe, with the challenge sent over a pinned connection that never follows redirects. Event Gateway makes the deliveries. A host allowlist is planned.
- A local agent's tunnel URL only passes requests signed with its source's secret, which only the bridge holds; the agent's own secret reaches the bridge through `events/subscribe`, never a tool.
- Provider keys and signing secrets never pass through tool arguments or results.
- Event content is data, never instructions. Subscribe filters such as `from` limit who can trigger an agent.

## Spec conformance

Checked on 5 Oct 2026 against the MCP Events design sketch (`experimental-ext-triggers-events`, webhook delivery) and OpenAI's MCP Events requirements for ChatGPT. Rows marked "Designed" are implemented and covered by the e2e run unless noted. The rows marked "ported" reuse code from `mcp-events-outpost-demo`, which passed OpenAI's checklist with ChatGPT on 1 Oct.

Status: **Designed** (covered by the design), **Gap** (known not to conform), **Unknown** (depends on something not yet checked), **Event Gateway** (the requirement applies to delivery, which Event Gateway performs), **Not planned** (optional, or not used by ChatGPT, and out of scope for now).

### Catalog and discovery

| Requirement | Level | Status | Notes |
| --- | --- | --- | --- |
| `events` capability in `server/discover` | MUST | Designed (ported) | |
| `listChanged` and `notifications/events/list_changed` | MUST if advertised | Designed | Advertise `listChanged: false`: providers change through the config file and a restart, not at runtime |
| `events/list` with `name`, `delivery`, `inputSchema`, `payloadSchema`; `description` | MUST; SHOULD | Designed | From the provider definitions; `delivery: ["webhook"]` |
| `nextCursor` pagination | MAY | Not planned | Catalogs are small |
| Additive schema evolution; new name for incompatible payloads | SHOULD; MUST NOT reuse | Designed | A rule for provider authors; worth stating in the provider guide |

### Subscribe, refresh, unsubscribe

| Requirement | Level | Status | Notes |
| --- | --- | --- | --- |
| Authenticated principal; reject with `-32012` | MUST | **Partial** | Secret URL (default): a request without the secret is rejected, and every caller with it is the one owner principal. Built-in OAuth or an identity provider gives token-based principals (stage 7) |
| Principal authorized for the event and arguments | MUST | **Gap** | Single-tenant: any principal the deployment accepts can subscribe to any configured event. No per-resource access model |
| Re-check access during the subscription; stop on revocation | SHOULD (spec), required by OpenAI | **Gap** | Only "remove the principal's token". No revocation signal from providers |
| `https` callback URLs; reject others with `-32602` | MUST | Designed | ChatGPT callbacks are `https`; local agents use Hookdeck source URLs, which are `https`. The demo's `allowLocal` (`http` on localhost) is dev-only and doesn't conform |
| `whsec_` secret, 24 to 64 bytes | MUST | Designed (ported) | |
| Deterministic id; idempotent upsert on (principal, URL, name, canonical arguments) | MUST | Designed (ported) | |
| `refreshBefore`; no more than `ttlMs`; `null` only if `ttlMs: null` | MUST | Designed (ported) | ChatGPT sent no `ttlMs`, so the server default applies |
| Keep subscriptions for the granted lifetime, across restarts | MUST (for long TTLs) | Designed | Kept in Event Gateway (connection metadata, secrets in destination auth) and reloaded at startup; verified against the live API |
| Replace the secret on refresh; dual-sign during rotation | MUST; SHOULD | Designed (ported) | The new secret replaces the one in destination auth. The relay signs with both for the grace window; the previous secret is kept in memory, so a restart inside the window ends dual-signing early |
| `cursor` in the subscribe response (`null` if no replay) | MUST | Designed | Always `null`: no replay |
| `truncated` | MAY | Designed (ported) | `true` when a client supplies a cursor, since there's no replay |
| `deliveryStatus` | MAY | Designed | From Event Gateway delivery issues on the subscription's connection |
| `-32013` on limits | MUST when limited | Designed (ported) | Event Gateway has no documented limits on the number of sources, connections or destinations, so limits are the bridge's own |
| Unsubscribe by name, arguments and URL; stop delivery immediately | MUST | Designed (ported) | Deletes the connection and destination. In stage 3, deleting a connection canceled its scheduled retries |

### Endpoint verification and SSRF

| Requirement | Level | Status | Notes |
| --- | --- | --- | --- |
| Verify intent before delivering (challenge, allowlist, out-of-band or well-known) | MUST | Designed (ported) | Signed challenge sent by the bridge; `-32015` with `data.reason` on failure |
| Cache verification per (principal, URL) | MUST | Designed (ported) | |
| Validate callback URLs; reject non-global addresses | MUST; SHOULD | Designed | At subscribe, and for the challenge through `CallbackTransport` |
| Validate at **delivery** time with a pinned IP (DNS rebinding) | MUST | Event Gateway | Deliveries are made by Event Gateway, which is responsible for delivery-time validation. The bridge checks callbacks at subscribe (`https`, public addresses only); a host allowlist is planned |
| Don't follow redirects on delivery | MUST | Event Gateway | Redirect handling is performed by Event Gateway, which makes the deliveries |

### Delivery

| Requirement | Level | Status | Notes |
| --- | --- | --- | --- |
| Headers: `webhook-id` = `eventId`, `webhook-timestamp`, `webhook-signature` (`v1,`), `X-MCP-Subscription-Id`, `Content-Type: application/json` | MUST | Designed | Set by the relay; Event Gateway passes them through |
| Envelope: `eventId`, `name`, `timestamp`, `data`, `cursor` | MUST | Designed | `cursor: null` |
| `data` matches `payloadSchema`; minimal triage fields | MUST; SHOULD | Designed | Provider `summarize` |
| Body at most 256 KiB | SHOULD (spec), hard limit for ChatGPT | Designed | The relay checks size before publishing |
| **Each retry regenerates timestamp and signature** | MUST | **Gap** | Event Gateway redelivers the original headers. Mitigation: retries finish inside 5 minutes, the window inside which receivers SHOULD accept a timestamp. Inbound retries do re-sign, and so does the bridge's retry of a local agent's missed deliveries. Closes with Standard Webhooks destination signing |
| Exponential backoff, bounded attempts | SHOULD | Designed | Event Gateway retry rule, exponential, inside 5 minutes |
| Don't retry `410` or `413` | MUST | Designed | Retry rule `response_status_codes: [">=300", "!410", "!413"]`, verified in stage 3. Negations alone also retry `2xx` |
| Stable `eventId`, duplicates and out-of-order delivery tolerated | MUST | Designed | Provider event id; dedupe is best-effort, receivers dedupe on `webhook-id` |
| Event content treated as untrusted data | MUST | Designed | No instructions in payloads |

### Optional parts of the spec not covered

| Feature | Level | Status | Notes |
| --- | --- | --- | --- |
| `gap` and `terminated` control envelopes | MUST when used; `terminated` SHOULD on revocation or removed events | Not planned | ChatGPT doesn't support them. `bridge setup --prune` should send `terminated` if a client ever does |
| Poll mode (`events/poll`) | Optional mode | Later | For clients that can't receive webhooks, when one needs it; backed by Event Gateway's stored requests, so it also gives replay (`cursor`, `maxAgeMs`, `truncated`). Tools would wrap it for hosts without MCP Events support |
| Push mode (`events/stream`) | Optional mode | Not planned | Would bypass Event Gateway; only if a client needs it |
| Replay: non-null `cursor`, `maxAgeMs` | MAY | Not planned | Possible later: Event Gateway keeps every inbound request, so a cursor could be a position in that history |
| Asymmetric `v1a,` signatures and JWKS | MAY | Not planned | |

### Summary

- **Known gaps:** re-signing on every retry, per-principal authorization, and access re-checks. The first is a known limit of the relay and closes with Event Gateway destination signing. The other two come from single-tenant hosting and matter more for anything multi-tenant.
- **Delegated to Event Gateway:** the delivery-time SSRF and no-redirect rules apply to whoever makes the deliveries, which is Event Gateway.
- **Partial:** the authenticated principal. The secret URL authenticates one owner; OAuth tiers (stage 7) give token-based principals.
- **ChatGPT:** stage 5 was verified with ChatGPT on 6 Oct: it subscribed, answered the challenge and received an email event (see "Verified facts").

## Verified facts

Checked during design on 4 and 5 Oct 2026. If one turns out wrong, fix it here and note it in `SPIKES.md`.

**Event Gateway API** (base `https://api.hookdeck.com/2026-09-01`), as used by the fleet demo:

- `PUT /connections` upserts by name.
- `GET /requests?source_id=…&created_at[gte]=…` lists inbound requests.
- `GET /requests/{id}/events` and `GET /requests/{id}/ignored_events`. Don't use `GET /events?request_id=`: it's accepted and ignored, and returns unrelated events.
- `GET /events?webhook_id=<connection id>` does filter by connection, and `status` and `created_at[gte]` filter too; `GET /requests?ignored_count[gt]=0` (and `ignored_count=0`) filter by count. There's no listing of ignored events across requests (verified live, 7 Oct).
- `POST /requests/{id}/retry` with `webhook_ids: [<connection id>]` limits the retry to one connection. The field isn't in the public API reference; it's what `hookdeck gateway request retry --connection-ids` sends. For a request ignored as `CLI_DISCONNECTED`, the retry creates a new event delivered as attempt 1 with `x-hookdeck-attempt-trigger: INITIAL`, and the request's ignored event goes away (`ignored_count` 0) (7 Oct).
- `POST /events/{id}/retry` has no status guard, and a scheduled retry stays armed, so only retry events that have settled as `FAILED`.
- A request retry creates new Hookdeck event IDs.

**Publish API** ([docs](https://hookdeck.com/docs/api/publish.md)):

- `POST https://hkdk.events/v1/publish`, authenticated like the REST API (`Authorization: Bearer $HOOKDECK_API_KEY`).
- Pick the source with `X-Hookdeck-Source-Name` or `X-Hookdeck-Source-Id`. Headers, body, path and query pass through as is.
- A `PUBLISH_API` source accepts only Publish API requests. Published requests count as verified. No idempotency key is documented.

**Resource names and descriptions:** connection, source and destination names must match `^[A-Za-z0-9_-]+$` (no dots); descriptions are at most 500 characters. The mock destination type is `MOCK_API`. A connection listing includes each destination's `config.url` and `description`.

**ChatGPT** (stage 5, 6 Oct): with the app created as "No Authentication" and the secret MCP URL, a Work chat request ("I'd like to know about all inbound emails") subscribed to `email.received` with `arguments: {}`, no `ttlMs`, and `cursor: null`. The callback was `https://connectors.api.openai.com/webhook/mcp-events/<id>`, and it answered the challenge. A Resend email was delivered with `200` on the first attempt, and the task showed the sender, recipient and subject.

**MCP Events source type** (6 Oct, probed in production): a `MCP_EVENTS` source takes `config.auth.webhook_secret_key` (a `whsec_` secret). The bridge's challenge, signed with that secret, was answered on the first try straight after the source was created, so no wait for the secret to reach the edge; a challenge signed with another secret got a 4xx, and (from the request counts) was recorded as a request rejected as `VERIFICATION_FAILED`. A passing challenge creates no request. Deliveries get HTTP 200 whether or not the signature matches; matching ones are `verified: true`, others are rejected as `VERIFICATION_FAILED`. On 7 Oct: changing an existing source's secret took **61 seconds** to reach the edge (the old secret kept working until then; a new source's works at once). A challenge or delivery signed with two `v1,` entries, one of them the source's secret, is accepted in either order; signed with the other secret only, it's rejected (401 for the challenge).

**Path forwarding on an `MCP_EVENTS` source** (probed 7 Oct): a verification challenge posted to a sub-path of the source URL (`<url>/mcp/events/webhook/abc`) is answered at the edge like one at the root, and a delivery to a sub-path is forwarded through `hookdeck listen` with the sub-path appended to the CLI destination's path: `/base` gives `/base/mcp/events/webhook/abc`, and `/` gives `/mcp/events/webhook/abc` exactly. So one tunnel URL can serve a receiver that routes by path.

**Request search** (stage 5, measured live): `GET /requests` filters on request headers (`headers` as a JSON filter) and returns headers and body with `include=data`, so `get_event` finds an event by its provider id. A new request took about 6 seconds to become findable by header.

**Destination paths** (stage 5, found live): Event Gateway joins the destination path with the request's path, so a request to the source root arrives at `/inbound/hookdeck/` (trailing slash) for issue notifications. The bridge accepts both forms.

**Default issue triggers** (stage 5, found live): a project's default delivery trigger (`first_attempt`, all connections) opens the issue on a connection's first failure; since issues are one per connection and status, the bridge's `final_attempt` trigger then has nothing to open. So the bridge hears about a failing callback at its first failure. Acceptable: a refresh resets the recorded state, and a `410` isn't retried anyway.

**Concurrent upserts** (stage 5, found live): four `PUT /connections` at once, each creating the same new inline source, returned one `500 FATAL_ERROR`. The store serializes its writes, and the client retries idempotent calls (`GET`, `PUT`, `DELETE`) on 5xx; publishes aren't retried, since the relay returns 502 to Event Gateway instead.

**Request retry eligibility** (stage 5, found live): `POST /requests/{id}/retry` is refused (`400`) unless the request was rejected or has ignored events. To deliver a processed request again, retry its event (`POST /events/{id}/retry`).

**Connection upsert and existing sources** (stage 5, found live): naming an existing source inline in `PUT /connections` (`source: { name }`) updates it, resetting its type to `WEBHOOK` and replacing its config, which dropped a `RESEND` source's signing secret. Bind an existing source with `source_id` instead. `bridge setup` does, and re-registers the provider webhook if a source has lost its secret.

**Generic `WEBHOOK` source verification** (7 Oct 2026, verified live with `spike-*` sources; [sources](https://hookdeck.com/docs/sources#add-source-authentication), [authentication](https://hookdeck.com/docs/authentication)):

- Config is `config: { auth_type, auth }` on `PUT /sources`. The generic types (from the OpenAPI schema at `/2026-09-01/openapi`): `HMAC` with `auth: { algorithm: sha1|sha256|sha512|md5, encoding: base64|base64url|hex, header_key, webhook_secret_key }`, `BASIC_AUTH` with `{ username, password }`, `API_KEY` with `{ header_key, api_key }` (header only in the schema), and `STANDARD_WEBHOOKS` with `{ webhook_secret_key }`.
- A correctly signed request is stored `verified: true` and delivered. A wrong or missing signature or credential is stored `verified: false`, `rejection_cause: VERIFICATION_FAILED`, with no events. The sender gets `401` for HMAC (sha256 tried), Basic auth and API key, as the docs say, but `200` for Standard Webhooks.
- HMAC accepted a `sha256=` prefix on the header value, and upper-case hex. Header names are matched case-insensitively.
- `GET /sources/{id}` leaves `auth` out (only `auth_type`); `?include=config.auth` returns it. `PUT /sources` without `config` keeps the existing auth.
- Request headers are stored as sent, so Basic auth's `Authorization` and an API key header are kept with every request (signatures too, which are harmless).
- `x-hookdeck-verified` on delivery: `true` from an HMAC source for a verified request, `false` from a source without verification even when the sender sent `x-hookdeck-verified: true` (Event Gateway overwrites it).
- Applying a secret to an existing source took effect within about a second in one test (the next unsigned request got `401`); another test saw a secret change take about 61 seconds.

**Holding a source's delivery** (7 Oct 2026, verified live):

- No connection on the source: the sender gets `200`, and the request is stored and rejected as `NO_CONNECTION`.
- A disabled connection (`PUT /connections/{id}/disable`): the sender gets `200`, and the request is stored with an ignored event, cause `DISABLED`. After `enable`, a manual retry of that request (`POST /requests/{id}/retry`) was delivered. A `PUT /connections` upsert of a disabled connection enables it again.
- A paused connection (`PUT /connections/{id}/pause`): the event is created in `HOLD` and delivered on `unpause`, so pausing doesn't hold unverified requests back for good.

**Destination auth as credential storage** (stage 5, verified live): a `CUSTOM_SIGNATURE` destination stores `auth.signing_secret`; the value is masked (`auth: {}`) in create, get and list responses, and returned only by `GET /destinations/{id}?include=config.auth` (listings don't return it even with `include`). Event Gateway adds the configured header with an HMAC of the body to each delivery.

**Retry rules** (stage 3, [docs](https://hookdeck.com/docs/retries)): `response_status_codes` takes codes, ranges (`500-599`), comparisons (`>=500`) and negations (`!410`), evaluated last match wins. A list of negations alone (`["!410", "!413"]`) matches every other status, `2xx` included, so a successful attempt is retried again until the count runs out; use `[">=300", "!410", "!413"]`. Unset, any non-`2xx` is retried. The CLI's `--rule-retry-response-status-codes` accepts integers only.

**Publish API pass-through** (stage 3): published headers and body reach the destination unchanged on every attempt, including `webhook-id`, `webhook-timestamp` and `webhook-signature`. Between attempts only `x-hookdeck-attempt-count` and `x-hookdeck-attempt-trigger` change. Event Gateway adds `idempotency-key`, the `x-hookdeck-*` headers, and `sentry-trace` and `baggage` tracing headers.

**Connection deletion** (stage 3): deleting a connection after a failed attempt canceled its scheduled retries.

**Resource limits:** the [limits page](https://hookdeck.com/docs/limits) covers payload size, delivery timeout, retry attempts and throughput, with no limit on the number of sources, connections or destinations; "Each source supports an unlimited number of unique connections."

**Rules and ignored events:**

- Filters ([docs](https://hookdeck.com/docs/filters)) apply to body, headers, query and path. Operators: `$eq`, `$neq`, `$in`, `$nin`, `$startsWith`, `$endsWith`, `$gt`, `$gte`, `$lt`, `$lte`, `$exist`, `$and`, `$or`, `$not`, `$ref`. No regex. Verified in stage 4: `$in` on a string is a substring match; an array in a filter matches when the array contains all the values; string matching is case-sensitive.
- Dedupe ([docs](https://hookdeck.com/docs/deduplication)) is a connection rule with `include_fields` or `exclude_fields` (paths start with `headers`, `body`, `query` or `path`) and a window of 1 minute to 1 hour. Duplicates become ignored events. Best-effort. Rule order is configurable.
- Ignored event causes ([docs](https://hookdeck.com/docs/requests)): `DISABLED`, `FILTERED`, `TRANSFORMATION_FAILED`, `CLI_DISCONNECTED`, and `DUPLICATE` for a dedupe hit (stage 4; not in the docs' list). A non-matching filter records one per connection per request.
- Destination auth ([docs](https://hookdeck.com/docs/authentication)): Hookdeck Signature, Custom SHA-256, Basic, API key, Bearer. No Standard Webhooks.
- Transformations ([docs](https://hookdeck.com/docs/transformations)): no IO, no async, 1-second limit, 5 MB code, environment variables for secrets, can set headers, no built-in crypto.

**Issues and notifications** ([issue triggers](https://hookdeck.com/docs/issue-triggers), [issues](https://hookdeck.com/docs/issues)):

- Issue types: delivery (`strategy`: `first_attempt` or `final_attempt` in the API, scoped by `connections`), transformation (`log_level`: `warn`, `error`, `fatal`, scoped by `transformations`), backpressure (`delay`, default 600000 ms, scoped by `destinations`), request (`rejection_causes`, scoped by `sources`).
- Scope is `*`, ids, or name patterns with wildcards and exclusions (`prod-*`, `!staging-*`). The most specific matching trigger runs.
- Webhook notifications: topics `issue.opened`, `issue.updated`, `event.successful`, `deprecated.attempt-failed`, sent to a source in the project.

**Hookdeck CLI** (3.1.0 installed):

- Non-interactive login into a private config: `hookdeck ci --api-key $HOOKDECK_API_KEY --hookdeck-config <path>`.
- `hookdeck listen <port> <source> <connection> --output compact --device-name <name> --hookdeck-config <path>`, with the exact connection name. If that connection doesn't exist, `listen` creates a shared `cli-<source>` connection.
- "Connected" on stdout means the session is up; that's the recovery trigger. It's printed again after every websocket reconnect inside a running process ("Connection lost, reconnecting..." before it), from the CLI's source (`renderer_simple.go`, used for `--output compact`).
- A running `listen` session only covers the connections resolved at startup, even with `'*'`: a request to a CLI connection created later is ignored as `CLI_DISCONNECTED` until `listen` restarts (verified live and in the CLI's code, 7 Oct; [hookdeck-cli#467](https://github.com/hookdeck/hookdeck-cli/issues/467)).
- The CLI forwards each attempt to its local URL plus the destination's `cli_path`, with no filtering of its own.
- Relevant `gateway connection upsert` flags: `--source-type`, `--source-webhook-secret`, `--destination-type`, `--destination-cli-path`, `--destination-url`, `--rule-filter-headers`, `--rule-retry-strategy`, `--rule-retry-count`, `--rule-retry-interval`, `--rule-retry-response-status-codes`. The last accepts integers only, so negated codes have to be set through the API (stage 3).

**CLI destination behavior:**

- When no session is connected, the request is kept with an ignored event of cause `CLI_DISCONNECTED`, and no event is created.
- Within roughly 2 minutes of a session dropping, events are created and then fail (`CLI_UNAVAILABLE`).
- Every connected session on a destination gets a copy.

**MCP Events,** from the demo and OpenAI's plugin docs:

- The MCP TypeScript SDK has no MCP Events support. Register `events/list`, `events/subscribe` and `events/unsubscribe` by hand, and cast the `events` capability, as `src/server/mcp.ts` in the demo does.
- Subscribe sends a signed challenge to the callback and must check the echo; a failure returns `-32015`.
- Deliveries are Standard Webhooks with the subscriber's `whsec_` secret. The envelope's `eventId` stays the same across retries.
- Don't retry `410` or `413`. Keep payloads under 256 KiB.
- ChatGPT sent no `ttlMs` in the 1 Oct test.

**Resend:**

- Webhooks are Svix-signed, with `svix-id`, `svix-timestamp` and `svix-signature` headers.
- The create-webhook API returns a `signing_secret`.
- `email.received` carries metadata only: `type`, `created_at`, and `data` with `email_id`, `from`, `to`, `received_for`, `cc`, `bcc`, `subject`, `message_id`, `attachments`, `created_at` (stage 2).
- Every account gets a receiving domain, `<id>.resend.app`; mail to any address on it is received. No custom domain needed.
- Event Gateway passes `svix-*` headers through and rejects unsigned requests to a `RESEND` source as `VERIFICATION_FAILED` without forwarding them; the sender still gets `200` (stage 2).
- Event Gateway has a `RESEND` source type.
- Test emails are sent through Resend's API from a verified sending domain in the dedicated account.

## Plan

The staged build plan and its status are in [`PLAN.md`](PLAN.md); spike results are in [`SPIKES.md`](SPIKES.md).

## Decisions

- **5 Oct, hosted first.** Local agents and a local bridge come after, through the CLI.
- **5 Oct, the relay.** The bridge returns `2xx` only after every publish succeeds, so Event Gateway is the durable store on both sides; no outbox or event table.
- **5 Oct, topology.** One `PUBLISH_API` topic source per MCP event name; one connection and one destination per subscription.
- **5 Oct, configuration file.** `bridge.config.ts` with `defineConfig` is the source of truth for providers; no setup tools in the MCP server. Setup is done by whoever runs the bridge, or a coding agent, through the file and `bridge setup`.
- **5 Oct, poll mode.** The spec's `events/poll` replaces the custom pull tools as the pull interface; tools wrap it only for hosts without MCP Events support.
- **5 Oct, Smithery.** List the bridge on Smithery as an ordinary MCP server first; triggers support only if there's interest.
- **5 Oct, test email.** A verified sending domain in the dedicated Resend account; agents send test emails through Resend's API, so the end-to-end script runs unattended.
- **5 Oct, hosting.** The deliverable is a Docker image of the bridge. Fly.io is the reference host for stage 5 (a Machine; no volume, since Event Gateway is the store). The demo deployment, `mcp-events-bridge-dev` in `ams`, stays in Hookdeck's Fly organization. Deploy docs and automation for Railway and Render follow.
- **5 Oct, name.** GitHub `hookdeck/mcp-events-bridge`, npm `@hookdeck/mcp-events-bridge`, CLI `mcp-events-bridge`.
- **5 Oct, issue feedback.** Delivery, request and backpressure issue triggers are in stage 5; transformation issues come with the direct path.
- **5 Oct, secrets at rest.** Subscription secrets live in Event Gateway destination auth (masked credential storage); no bridge encryption key. Metadata is readable in connection descriptions, since the operator owns it.
- **5 Oct, ChatGPT plan.** Stage 5 is proven with ChatGPT Plus in Developer mode from a Work chat, as the Outpost demo was on 1 Oct. Dot testing waits for an upgraded plan.
- **5 Oct, development inbound.** The Hookdeck CLI (CLI destination plus `hookdeck listen`), not a public tunnel. cloudflared only when a synchronous response is needed (on 6 Oct, the MCP Events source type replaced it for the challenge).
- **5 Oct, authentication.** Tiers by friction: a secret URL by default, then built-in single-user OAuth, then bring-your-own identity provider. The OpenAI Secure MCP Tunnel is optional, for private networks. No extra service is required.
- **5 Oct, local delivery.** Local agents receive webhooks through Event Gateway's MCP Events source and the Hookdeck CLI, with recovery of events missed while offline. Poll from Event Gateway's history was the fallback (now later; see 7 Oct); push is not planned.
- **5 Oct, Outpost.** A future option for spec-conformant delivery, not the default: it adds a second service.
- **5 Oct, store.** Event Gateway is the store: subscriptions are connections with readable metadata in their descriptions and secrets in destination auth, indexed in memory at startup. No database, volume or encryption key (replaces an earlier SQLite store, then a sealed-description version).
- **5 Oct, `core/` boundary.** `node:crypto` allowed; callback sending behind `CallbackTransport` in `host/`.
- **6 Oct, MCP Events source.** Event Gateway's `MCP_EVENTS` source answers the challenge, so test subscribers and local agents receive through it and `hookdeck listen` instead of a cloudflared tunnel.
- **7 Oct, tunnel URLs per subscription.** One MCP Events source per subscription with a shared CLI destination per agent; the agent routes by `X-MCP-Subscription-Id`. Chosen over one source per agent for separate history and controls, accepting a `listen` restart per new subscription until hookdeck-cli#467.
- **7 Oct, dual signing.** The bridge signs deliveries to a tunnel URL with its source's secret and the agent's, rather than updating the source's secret (61 seconds to take effect) or passing secrets through tools.
- **7 Oct, retry, not replay.** Missed deliveries are re-sent by the bridge with a fresh signature; cursor replay is a separate, later feature.
- **7 Oct, event names.** MCP events are named `{instance id}.{provider event name}` (#15). Chosen over merging same-named events across instances with an `instance` argument: simpler, no schema merging, and the catalog shows each provider. Breaking, and accepted: 0.1.0 had no other users, so there's no migration. Resend's `email.received` became `resend.email.received`, configs use the provider's own event names (`issues`, not `github.issues`), and 0.1.0 subscriptions aren't carried over (the client subscribes again; the bridge logs subscriptions to events it doesn't offer). The name identifies the instance (ids have no dots), so subscriptions match on name alone. `get_event` takes the name as well as the id, since an event id is the provider's own and two instances can share one; `list_recent_events` became `list_events`.
- **7 Oct, deployment names.** `deployment` is optional: `BRIDGE_DEPLOYMENT`, else `local` (CLI inbound) or `public` (HTTP inbound). It was `dev` in the examples, which read as "not for real use" once a bridge on a laptop became the setup for local agents.
- **7 Oct, sources and secrets.** Every tunnel source has its own secret, generated by the bridge; a client's secret is never set on a source. A tunnel URL covers the paths under it, so a client with one base URL (Hermes) uses one tunnel URL for all its subscriptions.
- **7 Oct, local scope.** One bridge per machine, with one owner and its own Hookdeck project, running alongside the agent. The bridge runs `listen` and catches up by itself; the agent-facing tool becomes `create_tunnel_url`. Poll, push and cursor replay aren't local requirements and move to later (supersedes the 5 Oct poll fallback for local agents).
- **7 Oct, generic webhooks.** A built-in `webhook()` provider on a `WEBHOOK` source with required verification (HMAC, Standard Webhooks, Basic auth or API key), static mapping config, and equality filters on declared fields. Until its secret is set, the source exists without an inbound connection (not a disabled or paused one: an upsert re-enables a disabled connection, and a paused one delivers its held events), and the bridge relays only requests marked `x-hookdeck-verified: true`. `providers add webhook <id>` creates the source and the config entry; it edits `bridge.config.ts` only on request, and only shapes it can edit safely.

## Open questions

- [ ] Standard Webhooks destination auth in Event Gateway: not planned yet. Decides when the re-sign gap closes and publish-once can happen. Needs per-destination secret rotation as well as signing.
- [ ] Delivering straight from the provider source: the research questions in "Evolution".
- [ ] Adding a provider: gap 4 (thin webhooks) in "Adding a provider". Gaps 1 and 2 are solved by the generic webhook provider and `providers add webhook`; the manual paste in gap 1 remains.
- [ ] Deployments sharing a Hookdeck project: `local` and `fly` share the provider source (each gets its own inbound connection, so each email goes to both) and the subscription connections, which every running bridge loads. Decided for now: one Hookdeck project per bridge, documented in the README. An optional namespace is [#13](https://github.com/hookdeck/mcp-events-bridge/issues/13).
- [x] Tunnel URLs: one source per subscription, or one per agent with a path per subscription? Both: one per subscription by default, and paths under a tunnel URL for clients that use one base URL (Hermes). Every source keeps its own bridge-generated secret (7 Oct).
- [ ] A real local agent: Hermes Agent's receiver is the closest, once it follows the spec's subscribe shape. Lean: tell the PR's author what the bridge saw, with the maintainer's agreement.
- [ ] Multi-tenant hosting: encrypt connection descriptions? The format is versioned so a sealed variant can be added; bigger questions (a Hookdeck project per tenant, quotas, per-user OAuth) come first.
- [ ] Built-in OAuth: which maintained library supports CIMD and resource indicators (for example `oidc-provider`)?
- [ ] Smithery triggers (`ai.smithery/events/*`): an experiment after the listing, if there's interest.
- [x] Delivery issue notifications carry the failing response status, so the bridge deletes a subscription on `410` (stage 4).
- [x] Stage 3: bodies are byte-identical across attempts and match the publisher's, and the signature headers don't change between attempts (see `SPIKES.md`).
- [ ] What ChatGPT does when a refresh fails while the bridge is offline. Lean: long default lifetime until tested.
- [ ] Testing with a dot (needs a ChatGPT plan above Plus). Not needed for stage 5.
- [x] One `listen` for all sources: a comma-separated source list attaches to each source's existing CLI connection (verified live, stage 5). A running `listen` doesn't pick up sources created later (verified 7 Oct; hookdeck-cli#467), so local agents restart it and retry missed deliveries (stage 6).

## Prior art

Searched on 5 Oct 2026. No open-source project turned up that turns third-party webhooks into MCP Events subscriptions, but this was a handful of searches, not a survey.

| Project | What it does | Relation to the bridge |
| --- | --- | --- |
| [Smithery triggers](https://smithery.ai/docs/build/triggers) (preview) | A vendor-prefixed MCP Events profile (`ai.smithery/events/*`). Smithery passes subscribe through to the MCP server, which registers the upstream webhook and delivers signed events straight to the consumer | Closest on protocol. Leaves provider ingestion, signing and retries to each server author, which is what the bridge does. Complementary: the bridge could act as a Smithery trigger server |
| [Composio triggers](https://docs.composio.dev/docs/using-triggers) | Hosted. Provider webhooks (or polling) per connected account, fanned out to trigger instances and delivered to a subscriber URL with a rotatable secret | Closest on function, with its own envelope rather than MCP Events. Its trigger instance per connected account is the bridge's provider instance |
| [Pipedream Connect triggers](https://pipedream.com/docs/connect/components/triggers) | Hosted. Deploy a trigger with a `webhook_url` and get a signing key; or pull recent events from an API | Same shape as subscribe-with-callback plus `list_events`. Not MCP Events |
| Zapier SDK triggers ([docs](https://docs.zapier.com/sdk/index.md)) | Experimental: subscribe to app events in code, with Zapier holding subscription state and webhook reliability | Same idea, closed, not MCP Events |
| [mcp-webhook-events](https://pypi.org/project/mcp-webhook-events/0.2.0/) | Python library for an MCP server to emit MCP Events about its own app | First-party emitting; the bridge is the third-party case |
| [Hook0 MCP](https://www.hook0.com/webhooks-for-ai-agents) | MCP tools to manage the webhooks you send | Outbound management, a different direction |
| Webhook MCP servers ([Svix tutorial](https://www.svix.com/resources/tutorials/webhook-mcp-server/), [stripe-webhook-mcp](https://github.com/3598644/stripe-webhook-mcp)) | Capture webhooks and expose them as pull tools | Like the bridge's pull tools only; no subscriptions |
| MCP gateways ([Microsoft mcp-gateway](https://github.com/microsoft/mcp-gateway), [agentgateway](https://github.com/agentgateway/agentgateway), [rShetty/relay](https://github.com/rShetty/relay)) | Proxies and routing for MCP tool calls | Not events. They make "gateway" and "relay" crowded names |

What the hosted trigger platforms have that the bridge doesn't: years of per-provider trigger catalogs, polling for providers without webhooks (a possible answer to gap 1 in "Adding a provider"), and per-user connected accounts through OAuth.

Naming: the product is a bridge (two protocols, plus the control plane); the relay is one component of it, and a transitional one. "Triggers" is the market's word for an agent subscribing to app events and suits user-facing copy.

## References

- MCP Events design sketch: https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
- OpenAI, MCP Events for plugins: https://developers.openai.com/plugins/build/mcp-events
- OpenAI, Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://github.com/hookdeck/mcp-events-outpost-demo
- https://github.com/hookdeck/hookdeck-demos/tree/main/hookdeck/cli-fleet-fanout
- https://github.com/hookdeck/claude-channel-plugin
- https://github.com/hookdeck/webhook-skills
- openai/codex#50714: dot runs don't receive MCP event data
- hookdeck/hookdeck-cli#467: CLI sessions that pick up newly matching sources
- NousResearch/hermes-agent#132908: Hermes Agent's MCP Events receiver (draft)

Drafted with Claude on 4 and 5 Oct 2026.
