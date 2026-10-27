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

## Claude Code: watch and the plugin

Run on 9 Oct 2026 with Claude Code 2.1.295 (interactive, Opus 5.5) against the Fly deployment, with GitHub events from `hookdeck/hookdeck-demos` ([#26](https://github.com/hookdeck/mcp-events-bridge/issues/26)). Question: can Claude Code hear about events between prompts, without MCP Events support? **Yes, through a background command that prints each event.**

### What we ran

1. **`wait_for_event` in a turn:** asked to watch for three comments, while three were posted 20 seconds apart.
2. **`watch` with the Monitor tool** ([#45](https://github.com/hookdeck/mcp-events-bridge/pull/45)): asked to watch issues and comments "in the background", then asked something else, while an issue was opened, commented on twice and closed.
3. **A Fly restart** under a running `watch`, with a comment before and one after.
4. **A plugin monitor** (a minimal plugin with `--plugin-dir`): a comment while the session had never had a prompt.
5. **The plugin** ([#47](https://github.com/hookdeck/mcp-events-bridge/pull/47)), first with `--plugin-dir`, then installed from the marketplace on the branch (`--scope local`, in a throwaway project), the MCP URL set with `claude plugin configure --values-stdin` and not in the environment: "watch hookdeck/hookdeck-demos for new issues and comments", a comment, a reopen, then a comment posted while no session was open.

### What we saw

- **`wait_for_event`:** each comment reported within seconds, with progress notifications ("waiting for events") while it waited. The turn is held throughout.
- **Monitor tool:** each of four events woke the idle session as a "Monitor event", and Claude reported each; the session answered another question in between. Claude chose a 30-minute timeout, the Monitor tool's maximum, and offered to re-arm it.
- **Long lines are shortened:** a notification's line was cut at around 500 characters, so a comment near the end of the JSON arrived cut off. The bridge's own limit (500 characters per text field) wasn't the cause. Lines start with `eventId`, so `get_event` reads the rest; the skill says so.
- **stderr woke Claude too:** Claude merged stderr into the Monitor command, and `watch`'s startup line woke it with nothing to report. `watch` now prints it only to a terminal.
- **Fly restart:** no failed poll and nothing lost. The bridge's MCP is stateless (one server per request), so there's no session to lose.
- **Plugin monitor:** started with the session ("1 monitor") before any prompt, woke a session that had never had a prompt, and stopped with the session.
- **The plugin, installed:** the required option was reported unset at install; the `SessionStart` hook wrote `mcp-url` (mode 0600); the plugin's MCP server answered `list_providers`; the skill added two watches, choosing `actions` filters (`opened`, `created`) for "new"; a comment woke the session and the reopen was filtered out; the comment posted while the session was closed arrived when the next one started.
- **A review found, and we fixed before release:** the secret in `{ problem }` lines (a 404 page that echoes the path), two parallel `watches add` losing one (reproduced against Fly; a re-read wasn't enough, a lock file is), one failing watch reported every 30 s as "can't reach the bridge", and a rejected saved cursor stopping a watch every session.

### What it means for the design

- Claude Code gets events between prompts today, with no MCP Events support: the bridge's poll mode plus a plugin monitor. Push isn't needed for it.
- Notifications are text lines with a length limit, so events need an id up front and a way to fetch the rest (`get_event`).
- Plugin monitors can't read the plugin's user config, so the secret reaches `watch` through a file the session-start hook writes. A Claude Code feature to pass user config to monitors would remove that copy.

### Resources

Test issues `hookdeck-demos#27`, `#28` and `#29` (closed). The test plugin install and its data were removed. Screenshots: `docs/images/claude-code-wait-for-event.png` and `docs/images/claude-code-watch.png`.

## Stage 8: Event Gateway delivers

Run on 22 Oct 2026, in production, after Event Gateway shipped Standard Webhooks destination auth. **Passed:** Event Gateway can deliver every MCP Event itself, signed on every attempt, straight from the provider's source.

### What we ran

1. **Standard Webhooks destination auth.** An `MCP_EVENTS` source with secret A stood in for a subscriber, since it verifies signatures and records headers. A `PUBLISH_API` source fanned out to two HTTP destinations at its URL, one with `STANDARD_WEBHOOKS` auth and secret A, one with secret B. Publishes carried a `webhook-id`, or none, or one containing a period, and every publish also carried an old `webhook-timestamp` and a bogus `webhook-signature`, as the relay's would. One event was retried by hand. A CLI destination with the same auth was created, and so was one with a 16-byte secret. Requests straight to the `MCP_EVENTS` source: a delivery signed 10 minutes earlier with A, a delivery signed with B, and a challenge signed now and one signed 10 minutes earlier.
2. **Delivering straight from a provider's source.** A `WEBHOOK` source with two subscription connections sharing one transformation, which built the envelope from a Resend-shaped request and set `X-MCP-Subscription-Id` from `context.connection.name`. One subscription filtered on `to` (an array containing an address), the other on `from` with `$or` over two addresses; both deduped on `headers.webhook-id` and signed with `STANDARD_WEBHOOKS` to an `MCP_EVENTS` source. Four requests were sent, then the first again.
3. **A request retry re-running the transformation.** A request was filtered out, the filter was widened, and the request was retried for that connection (`POST /requests/{id}/retry` with `webhook_ids`).
4. **Example connections for review** (`spike-demo-*`, left in the project). `RESEND` and `GITHUB` sources, with test requests signed as Resend (Svix) and GitHub sign them; one transformation per provider, ported from `src/core/providers/resend.ts` and `github.ts`, adding `x-mcp-skip` for anything undeliverable, with every filter requiring it absent. Three subscriptions: a ChatGPT-like one with a callback URL on `mock.hookdeck.com`, and two for a Hermes-like agent whose callback URL was its own `MCP_EVENTS` source, holding the agent's secret, connected to a CLI destination that signed again with that secret.
5. **Recovering missed deliveries.** Events were sent with no `listen` running. Then `listen` was started, forwarding to a local receiver that verified each request with the agent's secret and a 5-minute timestamp window, as a Standard Webhooks library does, and the bridge's `InboundRecovery`, unchanged, was run against the agent's connection. A second connection went from the provider's source straight to a CLI destination, a shape we then rejected (see "Not taken" in `ARCHITECTURE.md`); it showed how a CLI connection's rules interact with `CLI_DISCONNECTED`.
6. **`listen` to a forwarding URL with a path:** `hookdeck listen http://127.0.0.1:<port>/base/ <source>`, with requests to the source URL and to a path under it.

### What we saw

- **Signing.** Every attempt carried `webhook-id`, a fresh `webhook-timestamp` and one `webhook-signature`, replacing the published ones, and the `MCP_EVENTS` source verified each one signed with its own secret. `webhook-id` was the published one when present, else Event Gateway's event id. An id containing a period failed with `DESTINATION_AUTH_FAILED` and nothing was sent. The manual retry kept the id, with a timestamp 18 seconds later. The CLI destination was accepted; the 16-byte secret was refused with `422`.
- **The `MCP_EVENTS` source** answered the delivery signed with B with `401`, and recorded it as `VERIFICATION_FAILED`: the sender now sees a bad signature, where on 6 Oct it got `200`. The delivery signed 10 minutes earlier was accepted and verified; the challenge signed 10 minutes earlier got `401`. The window applies to challenges only.
- **Straight from the provider's source.** Each subscription got its own `X-MCP-Subscription-Id` from the one transformation. The envelope arrived as `{ eventId, name, timestamp, data, cursor }`, with addresses normalized (`Alice <Alice@Example.com>` became `alice@example.com`). The filters did what the bridge's `accepts()` does: one email reached both subscriptions, one each, one neither, and the repeated request was ignored as `DUPLICATE` on both.
- **Request retry.** The retried request was transformed again and delivered, with the right subscription id, and verified.
- **The example connections** behaved the same with real provider signatures. The period-containing id was dropped as `FILTERED` by `$exist: false` on `x-mcp-skip`. GitHub's `ping`, an `issues` event and a `pull_request` labeled event were filtered; `pull_request` opened was delivered.
- **Recovery.** `InboundRecovery` retried 11 requests. Every recovered delivery passed the receiver's checks, with one signature and a timestamp 0 to 1 seconds old, so the CLI destination signed each retry afresh. On the CLI connection with a filter, every request sent while `listen` was down had been ignored as `CLI_DISCONNECTED`, including ones its filter would drop; when retried, the filter and dedupe dropped those.
- **`listen` with a URL** sent to `/base//webhook` and `/base//webhook/mcp/events/webhook/abc`: the URL's path is kept, the CLI destination's path and the path under the source URL are appended, and a trailing slash gives `//`. The startup output said `http://127.0.0.1:<port>/webhook`, leaving the URL's path out.

### What it means for the design

- The retry gap (conformance row 56) can close: Event Gateway signs each attempt itself.
- The relay can go. A transformation on the provider's source, shared by every subscription, plus filters and dedupe, does what the relay does. That's stage 8 in `PLAN.md`, designed in `ARCHITECTURE.md`, "Next: Event Gateway delivers" (now "Delivery: Event Gateway delivers"). Publishing once per topic, the earlier plan, keeps the relay for no gain, so it's dropped.
- A destination signs with one key, so a callback URL the bridge creates has to hold the client's own secret: `create_callback_url` takes it, from the client's code. Rotating it means a new URL until destinations take a second key, because changing a source's secret still takes about a minute.
- Recovery for local agents needs no new code: `InboundRecovery` works on a callback URL's connection, and the bridge's own re-sending goes.
- A mis-signed delivery to an `MCP_EVENTS` source is now a delivery failure the bridge hears about, not a silent `200`.
- `ARCHITECTURE.md` is updated: a "Mental model" section, the stage 8 design, the corrected `MCP_EVENTS` behavior, and new verified facts.

### Resources

The `spike-sw-*` and `spike-direct-*` sources, connections, destinations and transformations were deleted (none left, checked). The `spike-demo-*` resources were left in the project for review, minus the straight-to-CLI connection, which was deleted. Filed [hookdeck-cli#475](https://github.com/hookdeck/hookdeck-cli/issues/475) (the `//`) and [hookdeck-cli#476](https://github.com/hookdeck/hookdeck-cli/issues/476) (the startup output, the interactive view and `--help` leave out the forwarding URL's path). No Resend or GitHub webhooks were created: the provider requests were signed locally.

### Build probes (27 Oct)

Run while building stage 8, in the dedicated project.

**What we ran:**

1. Each source's generated transformation (Resend, GitHub with `issues`, `issue_comment`, `push` and `workflow_run`, and a webhook source) through `POST /transformations/run`, against the fixtures, and a throwaway transformation (`spike-txprobe`) to list what its runtime offers.
2. `POST /events/{id}/retry` on an event that had already succeeded (`spike-demo-sub-hermes-alice`, delivering to the `spike-demo-hermes` `MCP_EVENTS` source).
3. `GET /events?webhook_id=<subscription connection>&headers={"webhook-id":"<id>"}` (and a `body` filter on `eventId`) on the `spike-demo-sub-*` connections, and the headers of the requests those connections' deliveries made at `spike-demo-hermes`.
4. A source `spike-type-probe` created as `MCP_EVENTS` with a secret, then upserted by name as `WEBHOOK` with `config: {}`, with an unsigned `POST` to its URL every 10 seconds.
5. The first live e2e on 0.8.0 (signed fills to the `fills` webhook source, deployment `e2e080`), whose replay step failed; then request retries (scoped with `webhook_ids`, and unscoped) of a request that arrived before a connection existed, for that connection.
6. A second connection given an existing destination by `destination_id`, then the destination deleted.

**What we saw:**

- **Transformations:** each bundle's output equaled the bridge's own runtime's (only the timestamp differed, for events without one), including a SHA-256 of a body with non-ASCII characters. The runtime has `Buffer`, `btoa`, `TextEncoder` and `crypto.subtle` (async), but no synchronous hash, so the bundle carries its own SHA-256. `context` has only `connection` (with its name, description, rules, source and destination): no request id and no time the request arrived.
- **Retrying a succeeded event** works: `200`, a new attempt with trigger `MANUAL`, delivered (`SUCCESSFUL`, `200`).
- **Finding a subscription's event by `webhook-id`:** the `headers` filter (and a `body` filter on `eventId`) on `GET /events?webhook_id=` returned exactly that event, and nothing for an unknown id. An event's `data.headers` hold what the destination sent, including `X-Hookdeck-EventID`; the request those deliveries made at an `MCP_EVENTS` source carried no `x-hookdeck-*` headers.
- **The first e2e on 0.8.0** passed 8 of 9 checks: a signed fill was delivered about a second after it was sent, with `webhook-id` equal to the sender's id, `get_event` found it, the filter kept another symbol's fill out, unsubscribe deleted the connection, and deliveries carried a cursor. Replay failed: nothing reached the new subscription.
- **A request retry reaches only the connections the request was routed to when it arrived.** For a connection created after the request, both a retry scoped to it (`webhook_ids`) and a full retry created no event.
- **Connections can share a destination:** a second connection created with `destination_id` used the existing destination, and deleting the destination deleted both connections.
- **Changing a source's type in place:** the upsert kept the source's id and URL, set the type to `WEBHOOK` and cleared the auth. The URL answered `401` to unsigned requests for about 61 seconds, then `200`.

**What it means for the design:**

- A `source()` without `eventId` can't default to Event Gateway's request id (the transformation can't see it), so it defaults to a hash of the body. A live event with no time of its own gets the time the transformation runs, moments after the request arrived.
- Replay can't retry stored requests into a new subscription's connection. Instead, while a replay runs, a temporary connection (`bridge-replay-<subscription id>`) from a `PUBLISH_API` source (`bridge-replay`) to the subscription's own destination carries envelopes the bridge builds with the source's runtime and publishes; the destination signs every attempt with the subscriber's secret, and the bridge deletes the connection once the replayed events settle. `ARCHITECTURE.md`, "Webhook cursors and replay", is updated.
- A delivery a local agent missed is retried by retrying the subscription's own event, found by `webhook-id` on its connection: Event Gateway signs the retry afresh, so it works for pass-through callback URLs too, which hold no secret to sign a retry at the CLI destination. (A request retry on the subscription's connection would be dropped by its dedupe rule.)
- The migration from 0.7 turns a callback URL into a pass-through one in place, keeping its URL; deliveries refused during the minute it takes are retried by the subscription's connection.
- The connection description's 500 characters fit the cursor fields the transformation reads only as short keys (`ca`, `rp`).

**Resources:** `spike-txprobe` and `spike-type-probe` were deleted. The retry added one `MANUAL` attempt to an event on `spike-demo-sub-hermes-alice`, delivered to `spike-demo-hermes` (no `listen` was running, so nothing reached a receiver). `spike-replay-probe` and the `spike-dest-probe-*` resources were deleted.

### Verification (27 Oct)

Run on the built 0.8.0 branch, in the dedicated project, under deployment names of their own (`e2e080`, `mig07`), so nothing another deployment uses was changed.

**What we ran:**

1. The e2e with signed fills (`BRIDGE_DEPLOYMENT=e2e080 E2E_SOURCE=webhook npm run e2e`), after the replay change.
2. An upgrade test with real 0.7 data: the published 0.7.0 ran setup and serve under deployment `mig07`, a subscriber subscribed through an `MCP_EVENTS` callback holding its secret, and `create_tunnel_url` made a 0.7 tunnel URL; a fill was delivered by the relay. Then, with 0.7.0 stopped: 0.8.0 `serve` with no terminal, 0.8.0 `setup --migrate`, and a fill with no bridge running.
3. The e2e with the local agent and the extended checks (`E2E_LOCAL=1 E2E_EXTENDED=1`, signed fills): a callback URL holding the agent's secret, and a pass-through one with the subscription at a path under it, as Hermes uses; `listen` stopped and started; a duplicate service delivery; callbacks answering `410` and `500`.
4. Hermes Agent v0.22.5 with a local 0.8.0 bridge: `mcp-events-bridge callback-url create --agent hermes --name base --port 8644 --path /` (no secret), Hermes's webhook listener's `public_url` set to it, a subscription to `fills.order.filled` approved in chat, a signed fill, then unsubscribing in chat.

**What we saw:**

- **The e2e passed 9 of 9**, replay included: the fill sent while nothing was subscribed reached the new subscription made with the last cursor, through `bridge-replay-<id>`.
- **The upgrade:** 0.8.0 found 1 subscription, 1 callback URL, the topic source and `mig07`'s three inbound connections. `serve` with no terminal refused and named `setup` and `--migrate`. `setup --migrate` printed the plain-language notice and migrated them: the subscription kept its id on `bridge-fills` (version 2 metadata), the tunnel URL became a `WEBHOOK` source with the same URL, and nothing was left to migrate. A fill then reached the same subscriber, signed with its secret, with no bridge running.
- **Local agent and extended checks:** 22 of 24 passed first. A duplicate service delivery (the stored request retried for every connection) reached the subscriber once, the subscription's dedupe dropping it; a `410` wasn't retried and kept the subscription healthy; a callback answering `500` showed in `deliveryStatus` (`http_5xx`), and all 28 of its attempts, over 13 minutes, passed the subscriber's 5-minute timestamp check. Both failures were the pass-through subscription: its deliveries were stored at the callback source as `CLI_DISCONNECTED` (it was subscribed before `listen` covered the new URL, then `listen` was stopped), and recovery never retried them. A pass-through source verifies nothing, so its requests are all `verified: false` (with no `rejection_cause`), and recovery skipped unverified requests as rejected. Recovery also logged that Event Gateway "no longer has" the event for a delivery missed seconds earlier: `GET /events?headers=` hadn't indexed it yet. Fixed: only a request with a `rejection_cause` is skipped, and an event not found yet counts as pending for 10 minutes. The rerun with the local agent passed 19 of 19.
- **Hermes:** the challenge was skipped for the pass-through URL, with the warning in the bridge's log; Hermes subscribed at `<base>/webhooks/mcp-events-bridge-<id>`; the bridge started `listen` for port 8644 by itself; the fill arrived (`202`), Hermes verified it with the subscription's secret and ran the agent ("AAPL buy 100"); unsubscribing deleted the subscription.

**What it means for the design:** pass-through callback URLs work for a client with a secret per subscription under one base URL, and the migration keeps subscribers' subscriptions and URLs working without a bridge in the data path.

**Resources:** the `mig07` subscription, callback URL, subscriber callback and notifications connection were deleted by the test (its issue triggers, `bridge-*-mig07`, remain). The Hermes subscription was unsubscribed and its callback URL, `agent-hermes-base`, deleted. `e2e080`'s notifications connection and issue triggers are kept for further e2e runs.
