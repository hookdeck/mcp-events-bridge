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
