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

- Event Gateway, left in place (inert without the Resend webhook): connection `spike-resend`, source `spike-resend`, destination `spike-resend-cli`. Delete with the other spike resources once stages 2 to 5 are done.
- Resend webhook: deleted.
