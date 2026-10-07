// Development config for this repo. In your own project, import from '@hookdeck/mcp-events-bridge'.
import { defineConfig, env } from './src/index.js';
import { github, resend, webhook } from './src/providers.js';

// GitHub is opt-in here. GITHUB_REPOS=owner/name,owner/other registers webhooks with GITHUB_TOKEN (only `setup` uses
// the token). Or set GITHUB_WEBHOOK_SECRET instead, and add webhooks to any repositories yourself (manual mode).
const githubRepos = (process.env.GITHUB_REPOS ?? '').split(',').map((repo) => repo.trim()).filter(Boolean);
const githubProviders = githubRepos.length
  ? [github({ token: env('GITHUB_TOKEN', { optional: true }), scope: { repos: githubRepos } })]
  : process.env.GITHUB_WEBHOOK_SECRET
    ? [github({ webhookSecret: env('GITHUB_WEBHOOK_SECRET') })]
    : [];

// The generic webhook provider is opt-in too: FILLS_WEBHOOK_SECRET enables the README's example, order fills from
// a trading server you run yourself, signed with HMAC-SHA256 (E2E_WEBHOOK=1 npm run e2e plays the trading server).
const webhookProviders = process.env.FILLS_WEBHOOK_SECRET
  ? [
      webhook({
        id: 'fills',
        verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },
        events: { 'order.filled': { description: 'An order on my trading server filled.' } },
        eventId: { header: 'x-delivery-id' },
        occurredAt: { field: 'filled_at' },
        filters: ['symbol', 'side'],
      }),
    ]
  : [];

// The deployment name defaults to `local` here (CLI inbound) and comes from BRIDGE_DEPLOYMENT=fly on Fly.io (fly.toml).
export default defineConfig({
  providers: [
    resend({ apiKey: env('RESEND_API_KEY'), events: ['email.received'] }),
    ...githubProviders,
    ...webhookProviders,
  ],
});
