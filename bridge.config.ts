// Development config for this repo. In your own project, import from '@hookdeck/mcp-events-bridge'.
import { defineConfig, env } from './src/index.js';
import { github, resend, source } from './src/sources.js';

// GitHub is opt-in here. GITHUB_REPOS=owner/name,owner/other registers webhooks with GITHUB_TOKEN (only `setup` uses
// the token). Or set GITHUB_WEBHOOK_SECRET instead, and add webhooks to any repositories yourself (manual mode).
const githubRepos = (process.env.GITHUB_REPOS ?? '').split(',').map((repo) => repo.trim()).filter(Boolean);
const githubSources = githubRepos.length
  ? [github({ token: env('GITHUB_TOKEN', { optional: true }), scope: { repos: githubRepos } })]
  : process.env.GITHUB_WEBHOOK_SECRET
    ? [github({ webhookSecret: env('GITHUB_WEBHOOK_SECRET') })]
    : [];

// A webhook source is opt-in too: FILLS_WEBHOOK_SECRET enables the README's example, order fills from a trading
// server you run yourself, signed with HMAC-SHA256 (E2E_SOURCE=webhook npm run e2e plays the trading server).
const webhookSources = process.env.FILLS_WEBHOOK_SECRET
  ? [
      source({
        id: 'fills',
        type: 'webhook',
        verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },
        events: { 'order.filled': { description: 'An order on my trading server filled.' } },
        eventId: { header: 'x-delivery-id' },
        occurredAt: { field: 'filled_at' },
        filters: ['symbol', 'side'],
      }),
    ]
  : [];

// And a Stripe source, the README's example of an Event Gateway source type: STRIPE_WEBHOOK_SECRET (the endpoint's
// signing secret, whsec_...) enables it. Event Gateway checks Stripe's signatures.
const stripeSources = process.env.STRIPE_WEBHOOK_SECRET
  ? [
      source({
        type: 'stripe',
        secret: env('STRIPE_WEBHOOK_SECRET'),
        events: {
          'invoice.paid': { description: 'A Stripe invoice was paid.' },
          'customer.subscription.deleted': { description: 'A Stripe subscription ended.' },
        },
        eventType: { field: 'type' },
        eventId: { field: 'id' },
        occurredAt: { field: 'created' },
      }),
    ]
  : [];

// The deployment name defaults to `local` here (CLI inbound) and comes from BRIDGE_DEPLOYMENT=fly on Fly.io (fly.toml).
export default defineConfig({
  sources: [resend({ apiKey: env('RESEND_API_KEY'), events: ['email.received'] }), ...githubSources, ...webhookSources, ...stripeSources],
});
