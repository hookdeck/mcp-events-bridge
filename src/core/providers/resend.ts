import { z } from 'zod';
import { normalizeAddress, type InboundRequest, type ProviderDefinition, type ProviderEvent } from './types.js';

/*
 * Resend. Field paths settled from a real delivery in stage 2
 * (test/fixtures/resend/email-received.json). Event Gateway's RESEND source
 * verifies the Svix signature, so the bridge only sees verified requests.
 */

export type ResendOptions = {
  apiKey: string;
};

const RESEND_API = 'https://api.resend.com';

const emailReceivedBody = z.object({
  type: z.literal('email.received'),
  created_at: z.string(),
  data: z.object({
    email_id: z.string(),
    created_at: z.string(),
    from: z.string(),
    to: z.array(z.string()),
    cc: z.array(z.string()).optional().default([]),
    subject: z.string().optional().default(''),
    message_id: z.string().optional(),
    attachments: z.array(z.unknown()).optional().default([]),
  }),
});

const emailReceivedArguments = z
  .object({
    from: z.string().min(3).describe('Only emails from this sender address. Recommended: it limits who can wake the agent.').optional(),
    to: z.string().min(3).describe('Only emails sent to this address.').optional(),
  })
  .strict();

const emailReceivedPayload = z.object({
  emailId: z.string().describe('Resend email id; read the full email with Resend\'s own tools.'),
  from: z.string(),
  fromAddress: z.string().describe('Sender address, lower-cased.'),
  to: z.array(z.string()),
  toAddresses: z.array(z.string()).describe('Recipient addresses, lower-cased.'),
  cc: z.array(z.string()),
  subject: z.string(),
  messageId: z.string().nullable(),
  attachmentCount: z.number().int(),
});

export type EmailReceivedArguments = z.infer<typeof emailReceivedArguments>;
export type EmailReceivedSummary = z.infer<typeof emailReceivedPayload>;

const SUBJECT_LIMIT = 500;

export const emailReceived: ProviderEvent<EmailReceivedArguments, EmailReceivedSummary> = {
  name: 'email.received',
  description:
    'An email arrived at a Resend receiving address. Carries metadata only (sender, recipients, subject); fetch the body with Resend\'s own tools. Filter by `from` to limit who can trigger the agent.',
  providerEvent: 'email.received',
  matches: (req) => (req.body as { type?: unknown } | null)?.type === 'email.received',
  eventId: (req) => {
    const id = req.headers['svix-id'];
    if (!id) throw new Error('Resend delivery has no svix-id header');
    return id;
  },
  occurredAt: (req) => new Date(emailReceivedBody.parse(req.body).data.created_at).toISOString(),
  summarize: (req: InboundRequest) => {
    const { data } = emailReceivedBody.parse(req.body);
    return {
      emailId: data.email_id,
      from: data.from,
      fromAddress: normalizeAddress(data.from),
      to: data.to,
      toAddresses: data.to.map(normalizeAddress),
      cc: data.cc,
      subject: data.subject.length > SUBJECT_LIMIT ? `${data.subject.slice(0, SUBJECT_LIMIT)}…` : data.subject,
      messageId: data.message_id ?? null,
      attachmentCount: data.attachments.length,
    };
  },
  inputSchema: z.toJSONSchema(emailReceivedArguments) as Record<string, unknown>,
  parseArguments: (args) => {
    const parsed = emailReceivedArguments.parse(args ?? {});
    return {
      ...(parsed.from !== undefined && { from: normalizeAddress(parsed.from) }),
      ...(parsed.to !== undefined && { to: normalizeAddress(parsed.to) }),
    };
  },
  accepts: (args, summary) =>
    (args.from === undefined || summary.fromAddress === args.from) && (args.to === undefined || summary.toAddresses.includes(args.to)),
  payloadSchema: z.toJSONSchema(emailReceivedPayload) as Record<string, unknown>,
};

async function resendApi(fetchFn: typeof fetch, apiKey: string, path: string, init: { method: string; body?: unknown }) {
  const res = await fetchFn(`${RESEND_API}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend ${init.method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

export const resendProvider: ProviderDefinition<ResendOptions> = {
  type: 'resend',
  displayName: 'Resend',
  sourceType: 'RESEND',
  inboundDedupeFields: ['headers.svix-id'],
  eventIdHeader: 'svix-id',
  events: [emailReceived],

  async register({ sourceUrl, providerEvents, options, fetch: fetchFn }) {
    const created = await resendApi(fetchFn, options.apiKey, '/webhooks', {
      method: 'POST',
      body: { endpoint: sourceUrl, events: providerEvents },
    });
    if (typeof created.id !== 'string' || typeof created.signing_secret !== 'string') {
      throw new Error('Resend did not return a webhook id and signing secret');
    }
    return { webhookId: created.id, signingSecret: created.signing_secret };
  },

  async unregister({ webhookId, options, fetch: fetchFn }) {
    await resendApi(fetchFn, options.apiKey, `/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' });
  },
};
