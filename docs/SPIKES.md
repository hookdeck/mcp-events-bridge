# Spikes

Results of the spike stages in [`PLAN.md`](PLAN.md). Raw captures stay in `spikes/raw/` (gitignored); redacted fixtures are committed under `test/fixtures/`.

## Stage 2: Resend inbound

Run on 5 Oct 2026. **Passed.**

### What we ran

1. Upserted connection `spike-resend`: source `spike-resend` (type `RESEND`), CLI destination `spike-resend-cli` at path `/`.
2. Created a Resend webhook through the API (`POST https://api.resend.com/webhooks`, events `["email.received"]`, endpoint the source URL). The response carried `id` and a `whsec_` `signing_secret`, which went straight onto the source with `--source-webhook-secret`. The source then reported `authenticated: true`.
3. Ran `hookdeck listen 4100 spike-resend spike-resend` to a local server that logs method, path, headers and raw body (`spikes/log-server.ts`).
4. Sent two emails through Resend's API from the verified sending domain to an address on the account's `<id>.resend.app` receiving domain. No custom domain or MX records were needed.
5. Sent one unsigned request straight to the source URL.
6. Deleted the Resend webhook.

### What we saw

- **Verified and delivered.** Each email produced one request with `verified: true`, one event on the connection, and one delivery to localhost with `x-hookdeck-verified: true`.
- **Latency.** The first email reached localhost about 2.5 minutes after Event Gateway ingested it: the event sat `QUEUED` with 0 attempts while the CLI session showed "Connected". The second email took 5 seconds end to end, from the send API call to localhost. The first delay is unexplained; it may be a new project or a fresh CLI session warming up. Worth watching in later spikes.
- **Headers.** Resend's `svix-id`, `svix-timestamp` and `svix-signature` pass through unchanged. Event Gateway adds `idempotency-key` (its event id), `x-hookdeck-attempt-count`, `x-hookdeck-attempt-trigger`, `x-hookdeck-connection-name`, `x-hookdeck-destination-name`, `x-hookdeck-event-url`, `x-hookdeck-eventid`, `x-hookdeck-original-ip`, `x-hookdeck-requestid`, `x-hookdeck-signature`, `x-hookdeck-source-name`, `x-hookdeck-verified` and `x-hookdeck-will-retry-after`. The user agent is Svix's.
- **Body** (467 bytes): top-level `type` (`email.received`) and `created_at`, and `data` with `email_id`, `from`, `to`, `received_for`, `cc`, `bcc`, `subject`, `message_id`, `attachments` and `created_at`. No message body, as expected.
- **`from` was a bare address** even though the email was sent with a display name. `to` and `received_for` were equal arrays.
- **Two timestamps.** Top-level `created_at` was `16:22:41.000Z` (second precision); `data.created_at` was `16:22:42.897Z`. The send API call was at `16:22:40.765Z`.
- **`svix-id` differed between the two emails.** Whether it stays the same across Resend's own retries wasn't observed (no retry happened); Svix's design keeps the message id across attempts.
- **Unsigned request.** The sender got `HTTP 200` with a Hookdeck "request handled" body. Event Gateway recorded the request with `verified: false` and `rejection_cause: VERIFICATION_FAILED`, created no events, and forwarded nothing.

### What it means for the design

Resend manifest paths, settled from the fixture (`test/fixtures/resend/email-received.json`):

| Manifest field | Path |
| --- | --- |
| `matches` | `body.type === "email.received"` |
| `eventId` | header `svix-id` |
| `occurredAt` | `body.data.created_at` (millisecond precision, the received email's time); `body.created_at` is the event's own time at second precision |
| `summarize` | `emailId` from `data.email_id`, `from`, `to`, `cc`, `subject`, `messageId` from `data.message_id`, `attachmentCount` from `data.attachments.length`, plus normalized `fromAddress` and `toAddresses` |

- Keep the `Name <addr>` normalization even though Resend sent a bare address here: it costs little and other senders may differ.
- The `RESEND` source type works as designed: verification happens in Event Gateway, and the bridge never sees the Resend secret after `register()`.
- Unsigned or forged requests never reach the bridge, so the inbound route only needs to verify Hookdeck's own signature.
- The bridge must not rely on the `x-hookdeck-*` headers for identity: `idempotency-key` and `x-hookdeck-eventid` are Event Gateway's per-connection event id, not the provider's.

### Resources

- Event Gateway: connection `spike-resend`, source `spike-resend`, destination `spike-resend-cli`. Deleted at the end of stage 4.
- Resend webhook: deleted.

## Stage 3: Signed pass-through and retries

Run on 5 Oct 2026. **Passed, with one correction to the design's retry rule.**

### What we ran

1. A receiver (`spikes/passthrough-receiver.ts`) behind a cloudflared quick tunnel. It logs each attempt's headers and the SHA-256 of the raw body, verifies with `standardwebhooks`, and answers by an `x-spike-mode` header: `fail-once` (500 then 200), `gone` (410), `always-fail` (500).
2. Connection `spike-passthrough-a`: `PUBLISH_API` source `spike-passthrough`, HTTP destination at the receiver, filter on header `x-mcp-subscription-id` = `sub_a`, retry linear, 2 retries, 30 seconds.
3. A publisher (`spikes/publish.ts`) that builds an MCP Events envelope, signs it once with Standard Webhooks, and sends it through the Publish API, recording the body hash and headers it sent.
4. Retry status codes, first as `["!410", "!413"]`, then as `[">=300", "!410", "!413"]`.
5. Connection `spike-passthrough-del` (filter `sub_del`, same retry rule), deleted right after its first failed attempt.

### What we saw

- **Body.** Byte-identical on every attempt, and the same SHA-256 as the publisher's.
- **Signature headers.** `webhook-id`, `webhook-timestamp` and `webhook-signature` arrive exactly as published, on every attempt. Between attempts only `x-hookdeck-attempt-count` and `x-hookdeck-attempt-trigger` (`INITIAL`, then `AUTOMATIC`) change, plus the tunnel's own `cf-ray`.
- **Verification on retry.** Passed: the retry 30 seconds later was within the receiver's 5-minute timestamp tolerance.
- **Headers added.** Event Gateway adds `idempotency-key`, the `x-hookdeck-*` headers (including `x-hookdeck-will-retry-after`), and `sentry-trace` and `baggage`. Publisher headers such as `user-agent` pass through. Nothing published was dropped.
- **CLI.** `--rule-retry-response-status-codes '!410,!413'` is rejected ("must be an integer"). The API accepts negated codes, ranges and comparisons.
- **`["!410", "!413"]` retries successes.** With only negations, an event whose second attempt returned `200` got a third attempt 30 seconds later, also `200`. Event Gateway's docs say entries are evaluated last match wins, so a lone negation matches every other status, `2xx` included.
- **`[">=300", "!410", "!413"]` behaves as intended.** `fail-once`: 500, then 200, then no more attempts. `gone`: one attempt, 410, event `FAILED`, no retry.
- **Deleting a connection** after its first failed attempt canceled the scheduled retries: nothing arrived at +30 or +60 seconds.

### What it means for the design

- The relay's pass-through works: the bridge signs once, and every Event Gateway attempt carries the same verifiable request. Receivers accept retries while they're inside the 5-minute timestamp window, which confirms the cap on retry duration until Event Gateway can sign.
- Subscription connections use `response_status_codes: [">=300", "!410", "!413"]`, set through the API (the bridge uses the API anyway). Updated in `ARCHITECTURE.md`.
- Unsubscribe can rely on connection deletion to stop pending retries.

### Resources

- Event Gateway: source `spike-passthrough`, connection and destination `spike-passthrough-a` (reused in stage 4, then deleted). `spike-passthrough-del` was deleted during the test.

## Stage 4: Event Gateway topology and issue notifications

Run on 5 Oct 2026. **Passed.**

### What we ran

1. On the `PUBLISH_API` source `spike-passthrough`: connections `spike-passthrough-a` and `-b`, each with a header filter on its own subscription id (`sub_a`, `sub_b`), a dedupe rule on `headers.webhook-id` (1-hour window), and the corrected retry rule from stage 3.
2. One request published to each subscription, then the same `webhook-id` published twice to `sub_a`. The second copy had a different body (a new envelope timestamp), so the dedupe key was the header alone.
3. Filter checks on three more connections (`spike-filter-1` to `-3`), each matching a subscription header plus a body condition: `$in` on a string, an array value, and a mixed-case string.
4. Webhook notifications (`issue.opened`, `issue.updated`) to a `WEBHOOK` source, `spike-notifications`, delivered through the Hookdeck CLI to a local logger; a delivery issue trigger (`first_attempt`) on `spike-passthrough-*`; deliveries failed with `500` and `410`.

### What we saw

- **Routing.** Each request created exactly one event, on its own subscription's connection, and a `FILTERED` ignored event on the other.
- **Dedupe.** The repeated `webhook-id` became an ignored event with cause `DUPLICATE` on `sub_a` (and `FILTERED` on `sub_b`). Only one copy was delivered. `DUPLICATE` isn't in the docs' list of causes.
- **Filters.** `{"$in": "needle"}` matched `"haystack needle haystack"` and not `"nothing here"`: a substring match. `["b@example.com"]` matched `["a@example.com", "b@example.com"]` and not `["a@example.com"]`. `"Alice@Example.com"` didn't match `"alice@example.com"`: case-sensitive.
- **Issue trigger API.** The strategy values are `first_attempt` and `final_attempt`; the `*_failure` names from the docs page are rejected with `422`.
- **Default triggers.** The project already had default issue triggers. One had opened a request issue for the stage 2 unsigned request, and delivery issues from stage 3 were already open.
- **Aggregation.** Delivery issues are keyed by connection, response status and error code: the `500` and `410` failures were separate issues. While an issue was open, new failures with the same key sent no notification, which is why the first test produced nothing until the open issues were resolved.
- **Notifications.** Resolving two issues sent two `issue.updated`; the next `410` sent `issue.opened` within seconds. Payload: `topic`, `issue` (with `aggregation_keys.response_status`, `data.trigger_event`, `data.trigger_attempt` including `response_status`, and `reference`), `trigger`, and `trigger_webhook` (the connection, including its `name`). They arrive Hookdeck-signed (`x-hookdeck-signature`), like any delivery. Redacted fixture: `test/fixtures/hookdeck/issue-opened-delivery.json`.

### What it means for the design

- The topic-source topology works as designed: one connection per subscription, routed by header filter, with dedupe on `webhook-id`.
- Matching in Event Gateway later (after destination signing) has to filter on normalized, lowercased fields: string matching is case-sensitive.
- The bridge can act on `410`: `trigger_webhook.name` identifies the subscription and the attempt carries the status. Use `final_attempt` for delivery triggers, and resolve each issue after acting on it so the next failure notifies again. Updated in `ARCHITECTURE.md`.

### Resources

All stage 2 to 4 Event Gateway resources (`spike-*` connections, sources and destinations) and the `spike-delivery` issue trigger were deleted, and webhook notifications were disabled. The project's default issue triggers were left as they were.

## Poll mode: Event Gateway's request listing

Run on 8 Oct 2026, for [#26](https://github.com/hookdeck/mcp-events-bridge/issues/26). **Done; it changed the cursor design.**

### What we ran

1. A `WEBHOOK` source `spike-poll` with HMAC verification (sha256, hex, `x-signature`), and a connection to a `MOCK_API` destination with a dedupe rule on `headers.x-delivery-id` (1 hour), as the bridge sets up a generic webhook.
2. Three runs of 40 signed requests each, single and in bursts of 5 within a second. For each: the send time, its `created_at`, and when it first appeared in `GET /requests?source_id=...&created_at[gte]=...&order_by=created_at&dir=asc`, listed every 250 ms.
3. Three requests with a wrong signature and three duplicates (a repeated `x-delivery-id`), and the listing filters on them.
4. The oldest request still listed on `bridge-resend` and `bridge-github` (read only).

### What we saw

- **Appearance:** 0.6 to 3.8 s after `created_at` in runs 1 and 3 (median about 2 s); in run 2, the last six requests took 8 to 15 s.
- **Out of order:** 30 of 120 requests (25%) appeared after a request with a later `created_at` was already listed, with up to 1.4 s between their `created_at`s. The listing itself is always sorted by `created_at`, with no ties (microsecond precision).
- **`created_at` isn't the receipt time:** the source answered the sender in about 25 ms, and `created_at` was 84 to 454 ms after sending. `ingested_at` (millisecond precision) is the receipt time, and `order_by=ingested_at` and `ingested_at[gte]` work, but appearance is just as out of order by `ingested_at`.
- **Non-events:** a wrong signature gets `401` (no request id) and is listed with `status: rejected`, `verified: false`, `rejection_cause: VERIFICATION_FAILED`, no events. A duplicate gets `200` and is listed as accepted with `events_count: 0`, `ignored_count: 1`; its ignored event has cause `DUPLICATE` and `meta.duplicate_of_request_id`. An accepted request has `events_count: 1`.
- **Filters** that work: `status=accepted|rejected` (lowercase), `verified`, `rejection_cause`, `events_count[gt]=0`, `events_count=0`, `ignored_count[gt]=0`. Unknown parameters are ignored silently, so a misspelled filter returns everything.
- **Retention:** both sources' oldest requests were their first (2 and 3 days old), so the cutoff wasn't visible. Published: 3 days on Developer, 7 on Team, 30 on Growth ([pricing](https://hookdeck.com/pricing)).

### What it means for the design

- A cursor at the newest `created_at` seen would skip requests. The poll re-lists a window (60 seconds) behind the newest it has seen and carries the ids it has returned (`ARCHITECTURE.md`, "Poll mode").
- `status=accepted` drops verification failures; duplicates are recognized by their ignored events, not by `events_count`, so requests waiting on a disconnected local bridge aren't dropped too.
- Not covered: requests to a CLI connection (`cli_events_count`), left as an open question for building against a local bridge.

### Resources

The `spike-poll` connection, destination and source were deleted (confirmed gone). Nothing else was changed.

## Poll mode: acceptance

Run on 8 Oct 2026, for [#26](https://github.com/hookdeck/mcp-events-bridge/issues/26), against a local bridge (CLI inbound) in the development project, with the `fills` generic webhook provider and signed fills (no email). **Passed, after one fix it found.**

### What we ran

1. **pi-mcp-events** (0.1.1), a client that calls `events/poll` itself, driven through its own `scanServer` and `pollEvents`: discovery, a null cursor (with and without `maxAgeMs`), 3 fills sent and polled, a repeat poll, `maxEvents: 1`, an unknown name, arguments.
2. **A 10-minute soak:** 200 signed fills in 40 bursts of 5 (60% AAPL), plus 3 with a wrong signature and 3 duplicates, while 6 `events/poll` loops (5 unfiltered, 1 with `{ "symbol": "AAPL" }`) polled as the spec says (`nextPollMs`, or at once with `hasMore`), and the API's `X-RateLimit-Remaining` was sampled every 30 seconds.
3. **Claude Code** (2.1.294, `claude -p` with Haiku 4.5, the bridge as an HTTP MCP server) during the soak, told to call `wait_for_event` for `{ "symbol": "MSFT" }` 15 times, carrying the cursor.
4. **A local bridge that was down:** a cursor taken, the bridge stopped, 5 fills sent, 150 seconds waited (so they're recorded `CLI_DISCONNECTED`), the bridge started again, and the old cursor polled through the bridge's inbound recovery, carried forward as a client would for 30 seconds.

### What we saw

- **pi-mcp-events:** 8 of 8 checks passed. Two gaps in the client, not the bridge: it requires an `Authorization` header or OAuth sign-in for any HTTP server (so a URL that carries its own secret needs a placeholder header), and its transport (`@earendil-works/pi-mcp` 1.0.2) doesn't send the `Mcp-Method` header the 2026-07-28 HTTP transport requires, which the bridge's MCP SDK enforces (`-32020`). The run added the header in a `fetch` shim.
- **Soak:** every loop got every fill it should (200, or the 120 AAPL), with none missing, none extra, no repeats and no errors, in 247 polls each. The wrong signatures were refused (`401`) and the duplicates never appeared. Each loop was served 4 fills after a later one had been returned, all of them: the late-and-out-of-order case the cursor exists for (fewer than the spike's 25%, since a 2-second poll sees most reordering inside one listing). The API's remaining allowance stayed between 211 and 238 of 240 a minute with 7 pollers, including the sampler and the bridge's own recovery.
- **Claude Code:** 15 calls, no errors; 27 MSFT fills, none missing between the first and last it received, and nothing else. The longest call took 13.1 seconds, well inside the timeouts.
- **Bridge down:** while the bridge was stopped, the 5 requests were accepted with no events and one `CLI_DISCONNECTED` ignored event each (this answers the open question about CLI connections). The first run returned only 1 of the 5: while the inbound recovery retries a request, it shows no events and no ignored events, and the cursor passed over unrouted requests older than the look-back. Fixed (unrouted requests older than the look-back are returned; see "Poll mode" in `ARCHITECTURE.md`), with a regression test; the rerun returned all 5, once each, over 9 polls straddling the recovery.

### What it means for the design

- Poll mode works with a native `events/poll` client and with Claude Code through the tools, and the shared listing keeps 7 pollers well inside the API's rate limit.
- An unrouted request isn't always new: the rule for them changed (above).
- The interop gaps in pi-mcp-events are worth reporting upstream.

### Resources

No Event Gateway resources were created: the fills went to the existing `bridge-fills` source. The test scripts and logs are in the session scratchpad, not the repo.

## GitHub provider: live

Run on 9 Oct 2026 against a local bridge (CLI inbound) in the development project, with automatic registration on five `hookdeck/*` repositories (`hookdeck-demos`, `website`, `mcp-events-bridge`, `webhook-skills`, `agent-skills`). Until then the GitHub provider had only unit tests. **Passed, after one fix it found.**

### What we ran

1. **`setup`** with a token allowed to manage the repositories' webhooks. The dev project's `bridge-github` source was still in manual mode from 6 Oct, so this also switched modes.
2. **Real events in `hookdeck-demos`:** an issue opened, commented on and closed, and a draft pull request opened and closed. Cursors were taken first through `events/poll` for `github.issues`, `github.issue_comment` and `github.pull_request`, filtered to `{ "repository": "hookdeck/hookdeck-demos" }`, plus one filtered to another repository.
3. **`list_events` and `get_event`** for the issue.
4. **A redelivery** of the "issue opened" webhook from GitHub's API, and **two forged requests** to the source URL: one with a wrong `X-Hub-Signature-256`, one with none.
5. **Claude Code** (2.1.295, `claude -p` with Haiku 4.5, the bridge as an HTTP MCP server) told to call `wait_for_event` for `github.issue_comment` on `hookdeck-demos`, while a comment was posted 25 seconds later.

### What we saw

- **`setup`:** the first run reported the webhook "updated", but no webhooks existed afterward. Switching from manual mode changed the registration id, so `setup` unregistered the old one, and GitHub's `unregister` deletes webhooks by source URL: the five it had just created. Fixed in [#39](https://github.com/hookdeck/mcp-events-bridge/pull/39), with a regression test. After the fix: five webhooks, active, with the 7 default event types, and each `ping` answered `200`.
- **`setup` trusts the source's description:** after the bug, the description said the webhooks were registered, and a rerun skipped them ([#41](https://github.com/hookdeck/mcp-events-bridge/issues/41)).
- **A token GitHub refused:** a fine-grained token with "Public repositories" access and the organization Webhooks permission gets `403` on every repository's hooks (it needs the repository Webhooks permission, which only appears once repositories are selected), and `403` on the organization's hooks for an organization member (organization webhooks need an owner). `setup` printed GitHub's raw error ([#38](https://github.com/hookdeck/mcp-events-bridge/issues/38)).
- **Events:** every event arrived once, with the expected summary: 2 issue events (opened, closed), 1 comment (with its text), 2 pull request events (opened as a draft, closed unmerged, with branches). The filter for another repository got none. `list_events` and `get_event` returned the issue events.
- **GitHub's payload is a snapshot:** the "opened" event for an issue closed within a second already said `"state": "closed"`. That's GitHub's payload, not the bridge.
- **Redelivery:** accepted, verified, with no events and one ignored event (Event Gateway's dedupe on `X-GitHub-Delivery`); the bridge relayed nothing and no poll returned it again.
- **Forged requests:** both answered `401` and recorded as `VERIFICATION_FAILED`; the bridge's issue trigger notified it.
- **Real traffic:** pushes, pull requests and workflow runs from merges on `mcp-events-bridge` arrived alongside, including those sent while the bridge was stopped, recovered when it started.
- **Claude Code:** one `wait_for_event` call waited inside the call and returned the comment (event id, sender, issue number and text) about 15 seconds in.

### ChatGPT, on Fly

Run the same day against the Fly deployment (0.3.0, HTTP inbound, its own `bridge-github-fly` connection on the same source), with the local bridge stopped.

- **ChatGPT's stale event list:** ChatGPT listed the seven `github.*` events (a live call to the bridge) but could only subscribe to `email.received`, the 0.1.0 name: it keeps the subscribable events from when the plugin was added. Refreshing the plugin fixed it; the README now says so ([#43](https://github.com/hookdeck/mcp-events-bridge/pull/43)).
- **Subscriptions:** ChatGPT subscribed to all seven events, unfiltered, through one "GitHub event notifications" monitoring task. Each callback verified and each subscription was accepted for 30 days.
- **Events:** opening and merging #43 and a comment on `hookdeck-demos#25` sent pull request, push (including the branch deletion), workflow run and comment events. The bridge published each once (`1/1`), and Event Gateway delivered each to ChatGPT with a `200` on the first attempt.
- **One task run:** ChatGPT reported 11 events together as a numbered list, each with a link.
- **Comment summaries:** for the comment, ChatGPT quoted the issue's title rather than the comment's text. The event has both (`title` is the parent issue's, `comment` the text); the agent chose `title`.

### What it means for the design

- The GitHub provider works end to end with automatic registration, locally and on Fly, to Claude Code by polling and to ChatGPT by webhook. Its summaries are what an agent needs, and Event Gateway's verification and dedupe behave as designed.
- `setup` needs to say which permission a token lacks (#38), and to check webhooks at the provider rather than trust its own record (#41).

### Resources

Webhooks on the five repositories deliver to the development project's `bridge-github` source, kept for dogfooding. The test issue (`hookdeck-demos#25`) and draft pull request (`hookdeck-demos#26`) are closed; the pull request's branch is deleted.
