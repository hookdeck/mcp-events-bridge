import { CallbackUrlError, parseCallbackUrl, verifyEndpoint, type CallbackTransport, type VerificationResult, type VerifyEndpointOptions } from './callback.js';
import type { Catalog } from './catalog.js';
import type { SubscriptionSettings } from './config.js';
import { callbackEndpointError, forbidden, internalError, invalidParams, notFound, unsupported, type CallbackFailureReason } from './errors.js';
import { deriveSubscriptionId, verificationKey } from './identity.js';
import { isValidWebhookSecret } from './secret.js';
import { SubscriptionTooLargeError, healthyDelivery, type SubscriptionStore } from './store.js';

/*
 * MCP Events webhook subscriptions: subscribe (and refresh), unsubscribe,
 * and the expiry sweeper. Ported from mcp-events-outpost-demo, with Event
 * Gateway resources (through the store) in place of Outpost destinations.
 */

export interface DeliveryStatus {
  active: boolean;
  lastError: CallbackFailureReason | null;
  failedSince?: string;
}

export interface SubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: null;
  truncated: boolean;
  deliveryStatus?: DeliveryStatus;
}

export interface SubscriptionServiceDeps {
  settings: SubscriptionSettings;
  store: SubscriptionStore;
  catalog: Catalog;
  transport: CallbackTransport;
  verify?: (transport: CallbackTransport, options: VerifyEndpointOptions) => Promise<VerificationResult>;
  now?: () => Date;
  log?: (message: string) => void;
}

type Params = Record<string, unknown>;

/** Server-granted lifetime. Never null: the bridge doesn't grant no-expiry subscriptions. */
export function grantTtlMs(requested: unknown, settings: Pick<SubscriptionSettings, 'defaultTtlMs' | 'minTtlMs' | 'maxTtlMs'>): number {
  if (typeof requested !== 'number') return settings.defaultTtlMs; // omitted, or null (a no-expiry request we decline)
  return Math.min(Math.max(requested, settings.minTtlMs), settings.maxTtlMs);
}

/** Request params for the log, with the signing secret replaced by its shape. */
export function describeParams(params: Params): string {
  const delivery = params.delivery as Record<string, unknown> | undefined;
  if (!delivery || typeof delivery !== 'object' || !('secret' in delivery)) return JSON.stringify(params);
  const secret = delivery.secret;
  const shape = isValidWebhookSecret(secret) ? `whsec_ (${Buffer.from(secret.slice(6), 'base64').length} bytes)` : `invalid (${typeof secret})`;
  return JSON.stringify({ ...params, delivery: { ...delivery, secret: `<${shape}>` } });
}

export class SubscriptionService {
  private readonly verifiedUntil = new Map<string, number>();
  private readonly verify: NonNullable<SubscriptionServiceDeps['verify']>;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: SubscriptionServiceDeps) {
    this.verify = deps.verify ?? verifyEndpoint;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  private parseKey(params: Params) {
    if (typeof params.name !== 'string') throw invalidParams('name is required');
    const entry = this.deps.catalog.get(params.name);
    if (!entry) throw notFound('event', `Unknown event: ${params.name}`);

    const delivery = params.delivery as Params | undefined;
    if (!delivery || typeof delivery !== 'object') throw invalidParams('delivery is required');
    if (delivery.mode !== undefined && delivery.mode !== 'webhook') throw unsupported('deliveryMode', delivery.mode);

    let url: URL;
    try {
      url = parseCallbackUrl(delivery.url);
    } catch (error) {
      if (error instanceof CallbackUrlError) throw invalidParams(error.message, { field: 'delivery.url', reason: error.reason });
      throw error;
    }

    const rawArgs = params.arguments ?? {};
    if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) throw invalidParams('arguments must be an object');
    return { event: entry.event, url, rawArgs: rawArgs as Record<string, unknown>, delivery };
  }

  async subscribe(principal: string | undefined, params: Params): Promise<SubscribeResult> {
    this.log(`events/subscribe from ${principal ?? '(none)'}: ${describeParams(params)}`);
    if (!principal) throw forbidden();
    const { settings, store, transport } = this.deps;
    const { event, url, rawArgs, delivery } = this.parseKey(params);

    let args: Record<string, unknown>;
    try {
      args = event.parseArguments(rawArgs);
    } catch (error) {
      throw invalidParams('arguments do not match the inputSchema', { detail: (error as Error).message });
    }
    if (!isValidWebhookSecret(delivery.secret)) {
      throw invalidParams('delivery.secret must be whsec_ followed by base64 of 24 to 64 bytes', { field: 'delivery.secret' });
    }
    const secret = delivery.secret;
    if (params.ttlMs !== undefined && params.ttlMs !== null && (typeof params.ttlMs !== 'number' || params.ttlMs < 0)) {
      throw invalidParams('ttlMs must be a non-negative number or null', { field: 'ttlMs' });
    }

    try {
      await transport.assertPublicHost(url);
    } catch (error) {
      if (error instanceof CallbackUrlError) throw invalidParams(error.message, { field: 'delivery.url', reason: error.reason });
      throw callbackEndpointError('connection_refused'); // DNS failure
    }

    const href = url.href;
    // The key uses the caller's exact arguments, so unsubscribe with the same arguments finds it.
    const id = deriveSubscriptionId(principal, href, event.name, rawArgs);
    const now = this.now();

    // Endpoint verification, cached per (principal, url).
    const vKey = verificationKey(principal, href);
    if ((this.verifiedUntil.get(vKey) ?? 0) <= now.getTime()) {
      const result = await this.verify(transport, { url, secret, subscriptionId: id, timeoutMs: settings.verificationTimeoutMs });
      if (!result.ok) {
        this.log(`verification failed for ${id}: ${result.reason}`);
        throw callbackEndpointError(result.reason);
      }
      this.verifiedUntil.set(vKey, now.getTime() + settings.verificationCacheTtlMs);
      this.log(`verified callback for ${principal} -> ${href}`);
    }

    const existing = store.get(id);
    const rotated = existing && existing.secret !== secret;
    const expiresAt = new Date(now.getTime() + grantTtlMs(params.ttlMs, settings));
    try {
      await store.put({
        id,
        principal,
        name: event.name,
        arguments: args,
        url: href,
        secret,
        previousSecret: rotated ? existing.secret : (existing?.previousSecret ?? null),
        previousSecretExpiresAt: rotated
          ? new Date(now.getTime() + settings.secretRotationGraceMs).toISOString()
          : (existing?.previousSecretExpiresAt ?? null),
        // A refresh is the subscriber's liveness signal: delivery is active again.
        delivery: healthyDelivery(),
        expiresAt: expiresAt.toISOString(),
        createdAt: existing?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      });
    } catch (error) {
      if (error instanceof SubscriptionTooLargeError) throw invalidParams('arguments are too large', { field: 'arguments' });
      this.log(`Event Gateway error for ${id}: ${(error as Error).message}`);
      throw internalError('Failed to configure delivery');
    }
    if (rotated) this.log(`rotated secret for ${id}`);
    this.log(`${existing ? 'refreshed' : 'subscribed'} ${id} until ${expiresAt.toISOString()}`);

    return {
      id,
      refreshBefore: expiresAt.toISOString(),
      cursor: null, // no replay yet
      truncated: params.cursor !== undefined && params.cursor !== null, // a client cursor can't be resumed
      ...(existing && {
        deliveryStatus: {
          active: true,
          lastError: existing.delivery.lastError,
          ...(existing.delivery.failedSince && { failedSince: existing.delivery.failedSince }),
        },
      }),
    };
  }

  /** Idempotent: unknown subscriptions return an empty result (OpenAI's guidance) rather than NotFound. */
  async unsubscribe(principal: string | undefined, params: Params): Promise<Record<string, never>> {
    this.log(`events/unsubscribe from ${principal ?? '(none)'}: ${describeParams(params)}`);
    if (!principal) throw forbidden();
    const { url, rawArgs, event } = this.parseKey(params);
    const id = deriveSubscriptionId(principal, url.href, event.name, rawArgs);
    try {
      await this.deps.store.delete(id);
    } catch (error) {
      this.log(`Event Gateway error deleting ${id}: ${(error as Error).message}`);
      throw internalError('Failed to remove delivery');
    }
    this.log(`unsubscribed ${id}`);
    return {};
  }

  /** Deletes subscriptions whose grant has lapsed. */
  async sweep(): Promise<string[]> {
    const removed: string[] = [];
    for (const record of this.deps.store.listExpired(this.now())) {
      try {
        await this.deps.store.delete(record.id);
        removed.push(record.id);
        this.log(`expired ${record.id}`);
      } catch (error) {
        this.log(`sweep failed for ${record.id}, will retry: ${(error as Error).message}`);
      }
    }
    return removed;
  }
}
