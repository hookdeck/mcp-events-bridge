# AGENTS.md

Instructions for coding agents working on this repo. Read [`docs/PLAN.md`](docs/PLAN.md) for the staged plan and its status, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and verified facts. This file covers how to work.

## Current scope

Stages 1 to 5 in `docs/PLAN.md` are done; stage 7 has started (the GitHub source, `source({ type })` for webhook senders and Event Gateway source types, and the npm package). Stage 6 is in progress: local agents receive through callback URLs the bridge creates, with the bridge running `listen` and catching up by itself, and Hermes Agent v0.22.5, the first release with MCP Events, works with the bridge (experimental in Hermes; see the stage 6 steps). Poll mode (`events/poll` and the poll tools), the `watch` and `watches` commands, and the Claude Code plugin (`plugins/mcp-events-bridge`, [#26](https://github.com/hookdeck/mcp-events-bridge/issues/26)) are built. Not yet: OAuth tiers beyond the secret URL, `doctor` and `setup --prune`. Push mode is later, only if a client needs it. Stage 8 (Event Gateway delivers each event straight from the service's source, and the bridge leaves the data path) is built for 0.8.0 and being verified: each subscription is a connection on its service's source with a generated transformation, callback URLs take the client's secret or are pass-through, and setup migrates 0.7 data after asking (`docs/UPGRADING.md`). Read "Mental model" and "Delivery: Event Gateway delivers" in `docs/ARCHITECTURE.md` before changing delivery, subscriptions or callback URLs.

## What the maintainer sets up first

You can't do these. Each is needed before the step that uses it.

| Needed for | What | Env var |
| --- | --- | --- |
| The bridge | A dedicated Hookdeck project for this work (not a production project), its Project API key and signing secret | `HOOKDECK_API_KEY`, `HOOKDECK_SIGNING_SECRET` |
| Resend source | A Resend account and an API key that can create webhooks. Inbound needs no domain: use any address on the account's `<id>.resend.app` receiving domain (Emails > Receiving > ... > Receiving address) | `RESEND_API_KEY` |
| GitHub source (optional) | A fine-grained token with the Webhooks permission on the repositories, or a webhook secret for manual mode | `GITHUB_REPOS`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` |
| Webhook source (optional) | A secret for the README's `fills` example, which this repo's config enables and `E2E_SOURCE=webhook` uses (any random value) | `FILLS_WEBHOOK_SECRET` |
| Stripe source (optional) | A Stripe endpoint's signing secret, or any `whsec_` value to test with requests you sign yourself | `STRIPE_WEBHOOK_SECRET` |
| The e2e tests | A verified Resend sending domain, and a key that can send email; or, with `E2E_SOURCE=webhook`, the `fills` secret instead (no email sent) | `RESEND_INBOUND_ADDRESS`, `RESEND_TEST_FROM` (or `FILLS_WEBHOOK_SECRET`) |
| The Hermes Agent test (optional) | An Anthropic API key with a spending limit, for the model Hermes runs | `HERMES_ANTHROPIC_API_KEY`, `HERMES_MODEL` |
| ChatGPT | ChatGPT Plus or above with Developer mode (Work chats; dots aren't needed) | |
| Claude Code (optional) | Claude Code 2.1.275 or later, interactive (plugin monitors don't run with `claude -p`) | |
| Everything | Hookdeck CLI with `gateway connection upsert`, Node 22.12 or later | |
| The reference deployment | A Fly.io account and an API token for deploys | `FLY_API_TOKEN` |

Secrets go in `.env` (gitignored); `.env.example` lists every variable with a comment, grouped as in the README's Configuration section (the bridge, then each source), then the e2e tests and the reference deployment. Never print keys or signing secrets in logs, test output, commit messages or chat.

## Ground rules

- **Work on a branch** and commit in small steps.
- **Use [Conventional Commits](https://www.conventionalcommits.org/)** for commit messages and pull request titles: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, with an optional scope (`feat(webhook): ...`). Mark a breaking change with `!` (`feat!: ...`) and a `BREAKING CHANGE:` footer.
- **Events only.** Don't add tools that wrap services' APIs (sending email, reading email bodies). Vendors' own MCP servers do that.
- **Event Gateway resources:** prefix everything you create with `bridge-`, `mcp-sub-`, `agent-` (the bridge's callback URLs for local agents) or `spike-` so it's easy to find and clean up. List what you created in your summary. Don't touch resources you didn't create.
- **Services' resources:** the same for Resend webhooks. Delete spike webhooks when the spike is done.
- **Conventions,** as in `hookdeck/mcp-events-outpost-demo`: TypeScript ESM, Node 22+, `tsx`, `vitest`, `zod` v4, `@modelcontextprotocol/server` / `node` / `client` v2, `standardwebhooks`.
- **Public repo.** Never put Hookdeck-internal details (private repo paths, internal PR numbers, security findings) in tracked files. They belong in `internal/`, which is gitignored.
- **Local endpoints:** reach them through the Hookdeck CLI (`hookdeck listen`). Use an Event Gateway MCP Events source (`MCP_EVENTS`) for a subscriber's callback; it answers the challenge. Use a cloudflared quick tunnel only when the caller needs the local response synchronously (for example a receiver whose status code Event Gateway acts on).
- **Docs and comments:** American English, no em dashes. Check Mermaid diagrams render before committing.
- **Terminology:** don't write "app" or "apps". MCP Events is implemented by an **MCP server**; the product that sends webhooks is a **service** (Resend, GitHub, Stripe), which the bridge models as a **source** (`sources` in the config, `source()`, `defineSource`; "provider" is the pre-0.6.0 name, and its aliases were removed in 0.8.0); what a user adds in ChatGPT is a **plugin**. Names keep their own wording: quote ChatGPT UI labels exactly, even when they say "App", and keep product names and hostnames such as GitHub App and `resend.app`. Avoid vague placeholders such as "things" or "behind an MCP server": name the event, server, or service. The bridge is the MCP server. The URL a client subscribes with is a **callback URL** (the spec's term) in everything users and agents see; keep the other Event Gateway terms (connection, destination) for `docs/ARCHITECTURE.md`. "Source" is in the config and CLI because a bridge source is exactly one Event Gateway source, `bridge-<id>`. A callback URL the bridge creates for a client without one (`create_callback_url`) is an Event Gateway source's public URL (`MCP_EVENTS` with the client's secret, or a pass-through `WEBHOOK` source), connected to a CLI destination: don't call it a tunnel (its 0.7 name was `create_tunnel_url`).
- **Keep the docs true.** If what you learn contradicts `docs/ARCHITECTURE.md`, update it and say so in `docs/SPIKES.md` or your summary. Tick off open questions the work answers, and add new ones.
- **Keep the skill and changelog in step.** A change users or agents see (a command, a log line, a tool's arguments, an event name) also updates `skills/mcp-events-bridge/` (the procedure and its references quote commands and log lines) and `CHANGELOG.md`. Update the status table in `docs/PLAN.md` when a stage starts or finishes.

## Releasing

Follow the [`mcp-events-bridge-release`](.claude/skills/mcp-events-bridge-release/SKILL.md) skill, with the maintainer approving at each gate. A release is published by creating a GitHub Release (`gh release create`), which runs `.github/workflows/release.yml` to publish to npm. Never push a `v*` tag or run `npm publish` by hand.

## Spike stages

Record each spike stage in `docs/SPIKES.md`, under a heading matching its name in `docs/PLAN.md`: what you ran, what you saw, and what it means for the design. Raw captures go in `spikes/raw/` (gitignored); commit only redacted fixtures, under `test/fixtures/`.

## Ask the maintainer first

- Creating a GitHub repo or pushing anywhere.
- Creating a GitHub Release (it publishes to npm).
- Anything that needs the ChatGPT or OpenAI Platform UI.
- Sending email from a real mailbox (sending through Resend's API to the test address is fine).
- Changing the public interface: MCP tools, manifest shape, event envelope.
- Any result that changes the scope of the current stage.

## What to hand back

A short summary covering:

1. Spike results, with links to `docs/SPIKES.md` sections.
2. What works, and how to run it.
3. Changes to `docs/ARCHITECTURE.md`, and why.
4. Event Gateway and Resend resources created, and whether they were cleaned up.
5. Open questions, each with a lean.
