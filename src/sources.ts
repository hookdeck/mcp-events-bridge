/** Sources, for bridge.config.ts: `import { github, resend, source } from '@hookdeck/mcp-events-bridge/sources'`. */
import { defineSource } from './core/config.js';
import { githubProvider } from './core/sources/github.js';
import { resendProvider } from './core/sources/resend.js';

/** Resend inbound email; registers its webhook through Resend's API. */
export const resend = defineSource(resendProvider);
/** GitHub repository or organization events; registers its webhooks through GitHub's API (or prints them, in manual mode). */
export const github = defineSource(githubProvider);
/** Any other sender, by Event Gateway source type (`stripe`, `slack`, ...), or `webhook` for any HTTP sender, verified as you configure. */
export {
  source,
  webhook,
  type SourceCommonOptions,
  type SourceEventOptions,
  type SourceOptions,
  type TypedSourceOptions,
  type ValueSource,
  type WebhookEventOptions,
  type WebhookOptions,
  type WebhookSourceOptions,
  type WebhookVerification,
} from './core/sources/source.js';
export type { SourceTypeCredentials, SourceTypeName } from './core/sources/source-types.generated.js';
