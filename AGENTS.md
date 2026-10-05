# AGENTS.md

Instructions for coding agents working on this repo. Read `ARCHITECTURE.md` first: it holds the design, the verified facts and the build plan. This file covers how to work.

## Current scope

Step 0 (the spikes) and slice 1, as described in `ARCHITECTURE.md`. No local agents, Claude Code shim, OAuth or second provider yet.

## What the maintainer sets up first

You can't do these. Each is needed before the step that uses it.

| Needed for | What | Env var |
| --- | --- | --- |
| Everything | A dedicated Hookdeck project for this work (not a production project) and its Project API key | `HOOKDECK_API_KEY` |
| Spike 3, slice 1 | A Resend account with a verified sending domain and a full-access API key. Inbound needs no domain: use any address on the account's `<id>.resend.app` receiving domain (Emails > Receiving > ... > Receiving address). The spikes create the `email.received` webhook through the API | `RESEND_API_KEY`, `RESEND_INBOUND_ADDRESS`, `RESEND_TEST_FROM` |
| Spike 1, slice 1 | ChatGPT Plus or above with Developer mode (Work chats; dots aren't needed for slice 1); an OpenAI Platform tunnel and runtime API key per OpenAI's Secure MCP Tunnel guide; `tunnel-client` installed | `CONTROL_PLANE_API_KEY`, `OPENAI_TUNNEL_ID` |
| Everything | Hookdeck CLI with `gateway connection upsert`, Node 22 or later | |
| Slice 1 deploy | A Fly.io account and an API token for deploys | `FLY_API_TOKEN` |

Secrets go in `.env` (gitignored); `.env.example` lists every variable with a comment, grouped by the step that needs it. Never print keys or signing secrets in logs, test output, commit messages or chat.

## Ground rules

- **Work on a branch** and commit in small steps.
- **Events only.** Don't add tools that wrap provider APIs (sending email, reading email bodies). Vendors' own MCP servers do that.
- **Event Gateway resources:** prefix everything you create with `bridge-`, `mcp-sub-` or `spike-` so it's easy to find and clean up. List what you created in your summary. Don't touch resources you didn't create.
- **Provider resources:** the same for Resend webhooks. Delete spike webhooks when the spike is done.
- **Conventions,** as in `hookdeck/mcp-events-outpost-demo`: TypeScript ESM, Node 22+, `tsx`, `vitest`, `zod` v4, `@modelcontextprotocol/server` / `node` / `client` v2, `standardwebhooks`.
- **Public repo.** Never put Hookdeck-internal details (private repo paths, internal PR numbers, security findings) in tracked files. They belong in `internal/`, which is gitignored.
- **Docs and comments:** American English, no em dashes. Check Mermaid diagrams render before committing.
- **Keep `ARCHITECTURE.md` true.** If what you learn contradicts it, update it and say so in `SPIKES.md` or your summary. Tick off open questions the work answers, and add new ones.

## Spikes

Record each spike in `SPIKES.md`: what you ran, what you saw, and what it means for the design. Raw captures go in `spikes/` with personal data redacted.

## Ask the maintainer first

- Creating a GitHub repo or pushing anywhere.
- Anything that needs the ChatGPT or OpenAI Platform UI.
- Sending email from a real mailbox (sending through Resend's API to the test address is fine).
- Changing the public interface: MCP tools, manifest shape, event envelope.
- Any spike result that changes slice 1's scope.

## What to hand back

A short summary covering:

1. Spike results, with links to `SPIKES.md` sections.
2. What works, and how to run it.
3. Changes to `ARCHITECTURE.md`, and why.
4. Event Gateway and Resend resources created, and whether they were cleaned up.
5. Open questions, each with a lean.
