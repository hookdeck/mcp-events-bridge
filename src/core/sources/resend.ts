import { z } from 'zod';
import { normalizeAddress, type EventRuntime, type SourceDefinition, type SourceEvent } from './types.js';

/*
 * Resend. Field paths settled from a real delivery in stage 2
 * (test/fixtures/resend/email-received.json). Event Gateway's RESEND source
 * verifies the Svix signature, so only verified requests reach the runtime.
 */

export type ResendOptions = {
  apiKey: string;
};

const RESEND_API = 'https://api.resend.com';

/** Resend's runtime: self-contained, since it also runs inside Event Gateway (see SourceRuntime). */
export function resendRuntime(): Record<string, EventRuntime> {
  const SUBJECT_LIMIT = 500;
  const address = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('Resend email has a non-string address');
    const angle = /<([^<>]+)>\s*$/.exec(value);
    return (angle ? angle[1]! : value).trim().toLowerCase();
  };
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  const dataOf = (body: unknown) => {
    const data = (body as { data?: unknown } | null)?.data;
    if (typeof data !== 'object' || data === null) throw new Error('Resend email.received has no data');
    return data as Record<string, unknown>;
  };
  return {
    'email.received': {
      matches: (req) => (req.body as { type?: unknown } | null)?.type === 'email.received',
      eventId: (req) => {
        const id = req.headers['svix-id'];
        if (!id) throw new Error('Resend delivery has no svix-id header');
        return id;
      },
      occurredAt: (req) => {
        const at = Date.parse(String(dataOf(req.body).created_at));
        if (Number.isNaN(at)) throw new Error('Resend email.received has no created_at');
        return new Date(at).toISOString();
      },
      summarize: (req) => {
        const data = dataOf(req.body);
        const to = strings(data.to);
        const subject = typeof data.subject === 'string' ? data.subject : '';
        return {
          emailId: String(data.email_id),
          from: String(data.from),
          fromAddress: address(data.from),
          to,
          toAddresses: to.map(address),
          cc: strings(data.cc),
          subject: subject.length > SUBJECT_LIMIT ? `${subject.slice(0, SUBJECT_LIMIT)}…` : subject,
          messageId: typeof data.message_id === 'string' ? data.message_id : null,
          attachmentCount: Array.isArray(data.attachments) ? data.attachments.length : 0,
        };
      },
    },
  };
}

const emailReceivedArguments = z
  .object({
    from: z.string().min(3).describe('Only emails from this sender address. Recommended: it narrows what wakes the agent (sender addresses can be forged, so don\'t rely on it alone).').optional(),
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

export const emailReceived: SourceEvent<EmailReceivedArguments> = {
  name: 'email.received',
  description:
    'An email arrived at a Resend receiving address. Carries metadata only (sender, recipients, subject); fetch the body with Resend\'s own tools. Filter by `from` to limit who can trigger the agent.',
  providerEvent: 'email.received',
  inputSchema: z.toJSONSchema(emailReceivedArguments) as Record<string, unknown>,
  parseArguments: (args) => {
    const parsed = emailReceivedArguments.parse(args ?? {});
    return {
      ...(parsed.from !== undefined && { from: normalizeAddress(parsed.from) }),
      ...(parsed.to !== undefined && { to: normalizeAddress(parsed.to) }),
    };
  },
  // `toAddresses` is an array: a one-item array filter matches arrays that contain the address.
  filter: (args) => ({
    ...(args.from !== undefined && { fromAddress: args.from }),
    ...(args.to !== undefined && { toAddresses: [args.to] }),
  }),
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

export const resendProvider: SourceDefinition<ResendOptions> = {
  type: 'resend',
  displayName: 'Resend',
  sourceType: 'RESEND',
  eventIdHeader: 'svix-id',
  events: [emailReceived],
  runtime: resendRuntime,

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
