// Ported from mcp-events-outpost-demo (src/client/subscriber.ts) for tests and the end-to-end script.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Webhook } from 'standardwebhooks';
import * as z from 'zod';
import { generateWebhookSecret, isValidWebhookSecret } from '../../src/core/secret.js';
import { matchSignatures } from '../../src/core/sign.js';

/*
 * A test subscriber for MCP Events webhook delivery:
 *  - an MCP client that discovers, lists, subscribes, refreshes, and unsubscribes
 *  - an HTTP receiver that answers verification challenges and verifies
 *    deliveries with the `standardwebhooks` library
 */

export interface McpEvent {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: string | null;
}

export interface SubscriberOptions {
  serverUrl: string;
  token: string;
  eventName: string;
  arguments?: Record<string, unknown>;
  /** Suggested subscription lifetime. Omit for the server default. */
  ttlMs?: number;
  receiverPort?: number;
  /** Public base URL that reaches the receiver (a tunnel). Defaults to http://localhost:<receiverPort>. */
  publicCallbackUrl?: string;
  /**
   * Subscribe with this exact callback URL instead of one pointing at the receiver,
   * for example an Event Gateway source that answers the challenge and forwards
   * deliveries to the receiver (with `hookdeck listen`). The receiver then accepts
   * deliveries on any path.
   */
  callbackUrl?: string;
  /** Use this `whsec_` secret instead of generating one, for example the secret an Event Gateway source is configured with. */
  secret?: string;
  /** Reject deliveries whose webhook-timestamp is more than 5 minutes off. Default true. */
  checkTimestamps?: boolean;
  /** Generate a new secret on every refresh to exercise rotation. */
  rotateSecretOnRefresh?: boolean;
  /** Log each `webhook-signature` entry and which secret (current or previous) produced it. */
  debug?: boolean;
  onEvent?: (event: McpEvent, headers: http.IncomingHttpHeaders) => void;
  /** Tests: the status to answer a verified event delivery with (default 200), for example 410 or 500. Not recorded as received unless 2xx. */
  respondWith?: (event: McpEvent) => number;
  /** Called for every verified event delivery attempt, whatever the response. */
  onAttempt?: (event: McpEvent, status: number) => void;
  log?: (message: string) => void;
}

export interface SubscribeResponse {
  id: string;
  refreshBefore: string | null;
  cursor: string | null;
  truncated: boolean;
  deliveryStatus?: { active: boolean; lastDeliveryAt?: string | null; lastError?: string | null };
}

const anyResult = z.record(z.string(), z.unknown());
const MAX_BODY_BYTES = 256 * 1024;
const ROTATION_OVERLAP_MS = 15 * 60 * 1000;

export class Subscriber {
  readonly client = new Client({ name: 'mcp-events-test-subscriber', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  readonly events: McpEvent[] = [];
  readonly verificationsAnswered: string[] = [];
  subscription?: SubscribeResponse;
  callbackUrl?: string;

  private receiver?: http.Server;
  private secret: string;
  /** Secrets the receiver accepts: the current one plus a recently rotated-out one. */
  private accepted: Array<{ secret: string; until: number }> = [];
  private readonly seenIds = new Set<string>();
  private refreshTimer?: NodeJS.Timeout;
  private readonly callbackPath = `/mcp-events/${randomBytes(8).toString('hex')}`;
  private readonly log: (message: string) => void;

  constructor(private readonly options: SubscriberOptions) {
    this.log = options.log ?? ((message) => console.log(`[client] ${message}`));
    if (options.secret && !isValidWebhookSecret(options.secret)) throw new Error('secret must be whsec_ followed by base64 of 24 to 64 bytes');
    if (options.secret && options.rotateSecretOnRefresh) throw new Error('secret and rotateSecretOnRefresh cannot be combined');
    this.secret = options.secret ?? generateWebhookSecret();
    this.accepted.push({ secret: this.secret, until: Infinity });
  }

  get currentSecret() {
    return this.secret;
  }

  /** Starts the receiver, connects, checks the events capability, and subscribes. */
  async start(): Promise<SubscribeResponse> {
    const port = await this.startReceiver(this.options.receiverPort ?? 0);
    const base = (this.options.publicCallbackUrl || `http://localhost:${port}`).replace(/\/$/, '');
    this.callbackUrl = this.options.callbackUrl ?? `${base}${this.callbackPath}`;
    this.log(`receiver listening on :${port}, callback URL ${this.callbackUrl}`);

    const transport = new StreamableHTTPClientTransport(new URL(this.options.serverUrl), {
      requestInit: { headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {} },
    });
    await this.client.connect(transport);
    this.log(`connected, protocol ${this.client.getNegotiatedProtocolVersion?.() ?? 'unknown'}`);

    // The SDK's typed capabilities drop unknown keys like `events`, so read server/discover directly.
    const discover = await this.client.request({ method: 'server/discover', params: {} }, anyResult);
    const capabilities = discover.capabilities as Record<string, unknown> | undefined;
    if (!capabilities?.events) throw new Error('Server does not declare the events capability');

    const list = await this.client.request({ method: 'events/list', params: {} } as never, anyResult);
    const event = (list.events as Array<{ name: string; delivery: string[] }>).find((e) => e.name === this.options.eventName);
    if (!event) throw new Error(`Server does not offer ${this.options.eventName}`);
    if (!event.delivery.includes('webhook')) throw new Error(`${this.options.eventName} does not support webhook delivery`);
    this.log(`events/list offers: ${(list.events as Array<{ name: string }>).map((e) => e.name).join(', ')}`);

    return this.subscribe();
  }

  /** Calls events/subscribe (first subscribe and every refresh use the same key). */
  async subscribe(): Promise<SubscribeResponse> {
    const result = (await this.client.request(
      {
        method: 'events/subscribe',
        params: {
          name: this.options.eventName,
          arguments: this.options.arguments ?? {},
          delivery: { mode: 'webhook', url: this.callbackUrl, secret: this.secret },
          cursor: this.subscription?.cursor ?? null,
          ...(this.options.ttlMs !== undefined && { ttlMs: this.options.ttlMs }),
        },
      } as never,
      anyResult,
    )) as unknown as SubscribeResponse;
    this.subscription = result;
    this.log(`subscribed ${result.id}, refreshBefore ${result.refreshBefore}` +
      (result.deliveryStatus ? `, deliveryStatus ${JSON.stringify(result.deliveryStatus)}` : ''));
    this.scheduleRefresh();
    return result;
  }

  /** Refreshes the subscription, optionally rotating the signing secret. */
  async refresh({ rotateSecret = this.options.rotateSecretOnRefresh ?? false } = {}): Promise<SubscribeResponse> {
    if (rotateSecret) {
      const next = generateWebhookSecret();
      // Accept the new secret before telling the server, and keep the old one for in-flight deliveries.
      this.accepted = [{ secret: next, until: Infinity }, { secret: this.secret, until: Date.now() + ROTATION_OVERLAP_MS }];
      this.secret = next;
      this.log('rotating signing secret');
    }
    return this.subscribe();
  }

  private scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    if (!this.subscription?.refreshBefore) return;
    const remaining = Date.parse(this.subscription.refreshBefore) - Date.now();
    const margin = Math.min(Math.max(remaining * 0.2, 5000), 5 * 60 * 1000);
    // setTimeout overflows past about 24.8 days (and then fires after 1 ms), so long grants wake up early and reschedule.
    const delay = Math.max(remaining - margin, 1000);
    const MAX_TIMEOUT = 2_000_000_000;
    this.refreshTimer = setTimeout(() => {
      if (delay > MAX_TIMEOUT) return this.scheduleRefresh();
      this.refresh().catch((error) => this.log(`refresh failed: ${(error as Error).message}`));
    }, Math.min(delay, MAX_TIMEOUT));
    this.refreshTimer.unref();
  }

  /** Stops refreshing, optionally unsubscribes, and shuts the receiver. */
  async stop({ unsubscribe = true } = {}): Promise<void> {
    clearTimeout(this.refreshTimer);
    if (unsubscribe && this.subscription) {
      await this.client.request(
        {
          method: 'events/unsubscribe',
          params: {
            name: this.options.eventName,
            arguments: this.options.arguments ?? {},
            delivery: { mode: 'webhook', url: this.callbackUrl },
          },
        } as never,
        anyResult,
      );
      this.log(`unsubscribed ${this.subscription.id}`);
      this.subscription = undefined;
    }
    await this.client.close();
    await new Promise<void>((resolve) => {
      this.receiver?.closeAllConnections();
      this.receiver ? this.receiver.close(() => resolve()) : resolve();
    });
  }

  private verifySignature(raw: string, headers: http.IncomingHttpHeaders): boolean {
    const now = Date.now();
    this.accepted = this.accepted.filter((entry) => entry.until > now);
    const flat = {
      'webhook-id': String(headers['webhook-id'] ?? ''),
      'webhook-timestamp': String(headers['webhook-timestamp'] ?? ''),
      'webhook-signature': String(headers['webhook-signature'] ?? ''),
    };
    for (const { secret } of this.accepted) {
      const webhook = new Webhook(secret);
      if (this.options.checkTimestamps === false) {
        // Opt-out for debugging replays: skip the library's 5-minute freshness window, still verify the HMAC.
        (webhook as unknown as { verifyTimestamp: (h: string) => Date }).verifyTimestamp = (h) => new Date(Number(h) * 1000);
      }
      try {
        webhook.verify(raw, flat);
        return true;
      } catch {
        // try the next accepted secret
      }
    }
    return false;
  }

  /** Debug: shows every signature entry, so dual-signing during rotation is visible (a verifier stops at the first match). */
  private logSignatures(raw: string, headers: http.IncomingHttpHeaders) {
    const now = Date.now();
    const previous = this.accepted.filter((entry) => entry.secret !== this.secret && entry.until > now).map((entry) => entry.secret);
    const labels = ['current', ...previous.map(() => 'previous')];
    const matches = matchSignatures(
      [this.secret, ...previous],
      {
        'webhook-id': String(headers['webhook-id'] ?? ''),
        'webhook-timestamp': String(headers['webhook-timestamp'] ?? ''),
        'webhook-signature': String(headers['webhook-signature'] ?? ''),
      },
      raw,
    );
    const summary = matches.map(({ secretIndex }, i) => `#${i + 1} ${secretIndex === -1 ? 'no match' : labels[secretIndex]}`).join(', ');
    const age = Math.round(Date.now() / 1000 - Number(headers['webhook-timestamp']));
    this.log(`debug ${headers['webhook-id']}: ${matches.length} signature(s): ${summary || 'none'}; timestamp age ${age}s`);
  }

  private startReceiver(port: number): Promise<number> {
    this.receiver = http.createServer((req, res) => this.handle(req, res));
    return new Promise((resolve) => this.receiver!.listen(port, () => resolve((this.receiver!.address() as { port: number }).port)));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const send = (status: number, body?: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));

    if (req.method !== 'POST') return send(405);
    // With an external callback URL (a forwarding gateway), deliveries arrive on whatever path the forwarder uses.
    if (!this.options.callbackUrl && new URL(req.url ?? '/', 'http://localhost').pathname !== this.callbackPath) return send(404);

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) return send(413);
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (this.options.debug) this.logSignatures(raw, req.headers);

    if (!this.verifySignature(raw, req.headers)) {
      this.log(`rejected delivery ${req.headers['webhook-id']}: bad signature or stale timestamp`);
      return send(401, { error: 'invalid signature' });
    }

    const subscriptionId = req.headers['x-mcp-subscription-id'];
    if (this.subscription && subscriptionId !== this.subscription.id) {
      this.log(`rejected delivery for unknown subscription ${subscriptionId}`);
      return send(404, { error: 'unknown subscription' });
    }

    const body = JSON.parse(raw) as Record<string, unknown>;

    // Control envelopes carry a top-level `type`.
    if (typeof body.type === 'string') {
      if (body.type === 'verification') {
        this.verificationsAnswered.push(String(req.headers['webhook-id']));
        this.log(`answered verification challenge (${req.headers['webhook-id']})`);
        return send(200, { challenge: body.challenge });
      }
      this.log(`control envelope: ${raw}`);
      return send(200);
    }

    const webhookId = String(req.headers['webhook-id']);
    const status = this.options.respondWith?.(body as unknown as McpEvent) ?? 200;
    this.options.onAttempt?.(body as unknown as McpEvent, status);
    if (status < 200 || status >= 300) {
      this.log(`answered ${webhookId} with ${status}`);
      return send(status);
    }
    if (this.seenIds.has(webhookId)) {
      this.log(`duplicate delivery ${webhookId} ignored`);
      return send(200, { duplicate: true });
    }
    this.seenIds.add(webhookId);

    const event = body as unknown as McpEvent;
    if (event.eventId !== webhookId) this.log(`warning: eventId ${event.eventId} does not match webhook-id ${webhookId}`);
    this.events.push(event);
    this.log(`event ${event.name} ${event.eventId}: ${JSON.stringify(event.data)}`);
    this.options.onEvent?.(event, req.headers);
    send(200);
  }
}
