# AGENTS.md

Instructions for coding agents working on this repo. Read [`docs/PLAN.md`](docs/PLAN.md) for the staged plan and its status, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and verified facts. This file covers how to work.

## Current scope

Stages 1 to 5 in `docs/PLAN.md` are done; stage 7 has started (the GitHub provider and the npm package). Stage 6 is in progress: local agents receive through tunnel URLs, with the bridge running `listen` and catching up by itself; next is testing a real agent (Hermes) locally (see the stage 6 steps). Not yet: the Claude Code channel, OAuth tiers beyond the secret URL, `doctor` and `setup --prune`. Poll and push modes are later, only if a client needs them.

## What the maintainer sets up first

You can't do these. Each is needed before the step that uses it.

| Needed for | What | Env var |
| --- | --- | --- |
| The bridge | A dedicated Hookdeck project for this work (not a production project), its Project API key and signing secret | `HOOKDECK_API_KEY`, `HOOKDECK_SIGNING_SECRET` |
| Resend provider | A Resend account and an API key that can create webhooks. Inbound needs no domain: use any address on the account's `<id>.resend.app` receiving domain (Emails > Receiving > ... > Receiving address) | `RESEND_API_KEY` |
| GitHub provider (optional) | A fine-grained token with the Webhooks permission on the repositories, or a webhook secret for manual mode | `GITHUB_REPOS`, `GITHUB_TOKEN`, `GITHUB_WEBHOOK_SECRET` |
| The e2e tests | A verified Resend sending domain, and a key that can send email | `RESEND_INBOUND_ADDRESS`, `RESEND_TEST_FROM` |
| The Hermes Agent test (optional) | An Anthropic API key with a spending limit, for the model Hermes runs | `HERMES_ANTHROPIC_API_KEY`, `HERMES_MODEL` |
| ChatGPT | ChatGPT Plus or above with Developer mode (Work chats; dots aren't needed) | |
| Everything | Hookdeck CLI with `gateway connection upsert`, Node 22.12 or later | |
| The reference deployment | A Fly.io account and an API token for deploys | `FLY_API_TOKEN` |

Secrets go in `.env` (gitignored); `.env.example` lists every variable with a comment, grouped as in the README's Configuration section (the bridge, then each webhook provider), then the e2e tests and the reference deployment. Never print keys or signing secrets in logs, test output, commit messages or chat.

## Ground rules

- **Work on a branch** and commit in small steps.
- **Events only.** Don't add tools that wrap provider APIs (sending email, reading email bodies). Vendors' own MCP servers do that.
- **Event Gateway resources:** prefix everything you create with `bridge-`, `mcp-sub-`, `agent-` (the bridge's callback URLs for local agents) or `spike-` so it's easy to find and clean up. List what you created in your summary. Don't touch resources you didn't create.
- **Provider resources:** the same for Resend webhooks. Delete spike webhooks when the spike is done.
- **Conventions,** as in `hookdeck/mcp-events-outpost-demo`: TypeScript ESM, Node 22+, `tsx`, `vitest`, `zod` v4, `@modelcontextprotocol/server` / `node` / `client` v2, `standardwebhooks`.
- **Public repo.** Never put Hookdeck-internal details (private repo paths, internal PR numbers, security findings) in tracked files. They belong in `internal/`, which is gitignored.
- **Local endpoints:** reach them through the Hookdeck CLI (`hookdeck listen`). Use an Event Gateway MCP Events source (`MCP_EVENTS`) for a subscriber's callback; it answers the challenge. Use a cloudflared quick tunnel only when the caller needs the local response synchronously (for example a receiver whose status code Event Gateway acts on).
- **Docs and comments:** American English, no em dashes. Check Mermaid diagrams render before committing.
- **Keep the docs true.** If what you learn contradicts `docs/ARCHITECTURE.md`, update it and say so in `docs/SPIKES.md` or your summary. Tick off open questions the work answers, and add new ones. Update the status table in `docs/PLAN.md` when a stage starts or finishes.

## Spike stages

Record each spike stage in `docs/SPIKES.md`, under a heading matching its name in `docs/PLAN.md`: what you ran, what you saw, and what it means for the design. Raw captures go in `spikes/raw/` (gitignored); commit only redacted fixtures, under `test/fixtures/`.

## Ask the maintainer first

- Creating a GitHub repo or pushing anywhere.
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
