# AGENTS.md

Instructions for coding agents working on this repo. Read [`docs/PLAN.md`](docs/PLAN.md) for the staged plan and its status, and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design and verified facts. This file covers how to work.

## Current scope

Stages 1 to 5 in `docs/PLAN.md` (1 to 4 are done). No local agents, Claude Code shim, OAuth tiers beyond the secret URL, or second provider yet.

## What the maintainer sets up first

You can't do these. Each is needed before the step that uses it.

| Needed for | What | Env var |
| --- | --- | --- |
| Everything | A dedicated Hookdeck project for this work (not a production project) and its Project API key | `HOOKDECK_API_KEY` |
| Stages 2 and 5 | A Resend account with a verified sending domain and a full-access API key. Inbound needs no domain: use any address on the account's `<id>.resend.app` receiving domain (Emails > Receiving > ... > Receiving address). The spikes create the `email.received` webhook through the API | `RESEND_API_KEY`, `RESEND_INBOUND_ADDRESS`, `RESEND_TEST_FROM` |
| Stage 5 | ChatGPT Plus or above with Developer mode (Work chats; dots aren't needed) | |
| Everything | Hookdeck CLI with `gateway connection upsert`, Node 22.13 or later (for `node:sqlite`) | |
| Stage 5 deploy | A Fly.io account and an API token for deploys | `FLY_API_TOKEN` |

Secrets go in `.env` (gitignored); `.env.example` lists every variable with a comment, grouped by the step that needs it. Never print keys or signing secrets in logs, test output, commit messages or chat.

## Ground rules

- **Work on a branch** and commit in small steps.
- **Events only.** Don't add tools that wrap provider APIs (sending email, reading email bodies). Vendors' own MCP servers do that.
- **Event Gateway resources:** prefix everything you create with `bridge-`, `mcp-sub-` or `spike-` so it's easy to find and clean up. List what you created in your summary. Don't touch resources you didn't create.
- **Provider resources:** the same for Resend webhooks. Delete spike webhooks when the spike is done.
- **Conventions,** as in `hookdeck/mcp-events-outpost-demo`: TypeScript ESM, Node 22.13+, `tsx`, `vitest`, `zod` v4, `@modelcontextprotocol/server` / `node` / `client` v2, `standardwebhooks`.
- **Public repo.** Never put Hookdeck-internal details (private repo paths, internal PR numbers, security findings) in tracked files. They belong in `internal/`, which is gitignored.
- **Local endpoints:** reach them through the Hookdeck CLI (`hookdeck listen`). Use a cloudflared quick tunnel only when the caller needs the local response synchronously (for example a receiver whose status code Event Gateway acts on), or for the MCP Events challenge until Event Gateway's MCP Events source type ships.
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
