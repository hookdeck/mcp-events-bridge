// Development config for this repo. In your own project, import from '@hookdeck/mcp-events-bridge'.
import { defineConfig, env } from './src/index.js';
import { resend } from './src/providers.js';

export default defineConfig({
  // Names this deployment's Event Gateway resources: `dev` locally, `fly` on Fly.io (set in fly.toml).
  deployment: process.env.BRIDGE_DEPLOYMENT ?? 'dev',
  providers: [resend({ apiKey: env('RESEND_API_KEY'), events: ['email.received'] })],
});
