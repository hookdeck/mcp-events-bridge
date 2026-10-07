/** Built-in providers, for bridge.config.ts: `import { resend } from '@hookdeck/mcp-events-bridge/providers'`. */
import { defineProvider } from './core/config.js';
import { githubProvider } from './core/providers/github.js';
import { resendProvider } from './core/providers/resend.js';

export const resend = defineProvider(resendProvider);
export const github = defineProvider(githubProvider);
/** Generic webhooks from any HTTP sender, verified by Event Gateway (HMAC, Standard Webhooks, Basic auth or an API key). */
export { webhook, type WebhookOptions, type WebhookVerification } from './core/providers/webhook.js';
