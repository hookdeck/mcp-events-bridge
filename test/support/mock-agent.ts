import http from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Webhook } from 'standardwebhooks';
import * as z from 'zod';
import { generateWebhookSecret } from '../../src/core/secret.js';

/*
 * A mock local agent: stands in for an agent host that supports MCP Events
 * itself and runs on a laptop. It asks the bridge for a callback URL per
 * subscription, subscribes with a secret it generates, and receives every
 * delivery on one local port and path, routing each by X-MCP-Subscription-Id
 * (which the spec requires so a receiver can pick the right secret) and
 * verifying it with that subscription's secret, the way a standard verifier
 * would: signature and a 5-minute timestamp window. It dedupes by webhook-id,
 * as the spec asks (delivery is at least once), and counts duplicates.
 */

const anyResult = z.record(z.string(), z.unknown());

export interface AgentDelivery {
  subscriptionId: string;
  eventId: string;
  path: string;
  verified: boolean;
  body: Record<string, unknown>;
}

export interface Callback {
  name: string;
  url: string;
  listen: { commands: string[] };
}

export class MockAgent {
  readonly deliveries: AgentDelivery[] = [];
  /** Deliveries whose webhook-id this subscription had already received. */
  readonly duplicates: AgentDelivery[] = [];
  /** Requests the receiver couldn't attribute or verify. */
  readonly rejected: Array<{ path: string; reason: string }> = [];
  private readonly client = new Client({ name: 'mock-agent', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  private readonly secrets = new Map<string, string>();
  private readonly subscriptions = new Map<string, { name: string; arguments: Record<string, unknown>; url: string }>();
  private server?: http.Server;

  constructor(
    private readonly options: { serverUrl: string; agent: string; port: number; path?: string; log?: (message: string) => void },
  ) {}

  private log(message: string) {
    this.options.log?.(message);
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const path = req.url ?? '';
        const subscriptionId = req.headers['x-mcp-subscription-id'] as string | undefined;
        const secret = subscriptionId ? this.secrets.get(subscriptionId) : undefined;
        if (!subscriptionId || !secret) {
          this.rejected.push({ path, reason: `unknown subscription ${subscriptionId ?? '(none)'}` });
          return res.writeHead(410).end();
        }
        try {
          // A standard verifier: any matching v1 entry, and the timestamp within 5 minutes.
          new Webhook(secret).verify(body, req.headers as Record<string, string>);
        } catch (error) {
          this.rejected.push({ path, reason: (error as Error).message });
          return res.writeHead(401).end();
        }
        const delivery: AgentDelivery = { subscriptionId, eventId: String(req.headers['webhook-id']), path, verified: true, body: JSON.parse(body) as Record<string, unknown> };
        const seen = this.deliveries.some((d) => d.subscriptionId === subscriptionId && d.eventId === delivery.eventId);
        (seen ? this.duplicates : this.deliveries).push(delivery);
        this.log(`${seen ? 'duplicate' : 'delivery'} ${delivery.eventId} for ${subscriptionId} on ${path}`);
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.options.port, '127.0.0.1', resolve));
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.options.serverUrl)));
  }

  private async tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.client.callTool({ name, arguments: args })) as { structuredContent?: T; isError?: boolean; content: Array<{ text?: string }> };
    if (result.isError || !result.structuredContent) throw new Error(`${name} failed: ${result.content.map((c) => c.text).join(' ')}`);
    return result.structuredContent;
  }

  createCallback(name: string): Promise<Callback> {
    return this.tool<Callback>('create_callback_url', { agent: this.options.agent, name, port: this.options.port, path: this.options.path ?? '/events' });
  }

  listCallbacks(): Promise<{ callbacks: Array<{ name: string; url: string }>; listen: { commands: string[] } }> {
    return this.tool('list_callback_urls', { agent: this.options.agent, port: this.options.port });
  }

  retryMissed(): Promise<{ resent: number; pending: number; rejectedByAgent: number; upToDate: boolean }> {
    return this.tool('retry_missed_deliveries', { agent: this.options.agent });
  }

  /** events/subscribe with the callback URL and a secret this agent generates. Returns the subscription id. */
  async subscribe(url: string, name: string, args: Record<string, unknown> = {}): Promise<string> {
    const secret = generateWebhookSecret();
    const result = await this.client.request(
      { method: 'events/subscribe', params: { name, arguments: args, delivery: { mode: 'webhook', url, secret } } } as never,
      anyResult,
    );
    const id = String(result.id);
    this.secrets.set(id, secret);
    this.subscriptions.set(id, { name, arguments: args, url });
    this.log(`subscribed ${id} to ${name} at ${url}`);
    return id;
  }

  async unsubscribe(id: string) {
    const sub = this.subscriptions.get(id);
    if (!sub) return;
    await this.client.request(
      { method: 'events/unsubscribe', params: { name: sub.name, arguments: sub.arguments, delivery: { mode: 'webhook', url: sub.url } } } as never,
      anyResult,
    );
    this.subscriptions.delete(id);
  }

  async close({ unsubscribe = true } = {}) {
    if (unsubscribe) for (const id of [...this.subscriptions.keys()]) await this.unsubscribe(id).catch(() => {});
    await this.client.close().catch(() => {});
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
