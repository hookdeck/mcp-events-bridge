import { describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { matchSignatures, signStandardWebhook } from '../../src/core/sign.js';
import { generateWebhookSecret } from '../../src/core/secret.js';

describe('Standard Webhooks signing interop', () => {
  const body = JSON.stringify({ eventId: 'evt_1', name: 'order.created', timestamp: '2026-10-01T00:00:00Z', data: { total: 1 }, cursor: null });

  it('produces signatures the standardwebhooks library verifies', () => {
    const secret = generateWebhookSecret();
    const headers = signStandardWebhook([secret], 'evt_1', body);
    expect(headers['webhook-signature']).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(new Webhook(secret).verify(body, { ...headers })).toMatchObject({ eventId: 'evt_1' });
  });

  it('dual-signs during rotation so either secret verifies', () => {
    const [current, previous] = [generateWebhookSecret(), generateWebhookSecret()];
    const headers = signStandardWebhook([current, previous], 'evt_1', body);
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(() => new Webhook(current).verify(body, { ...headers })).not.toThrow();
    expect(() => new Webhook(previous).verify(body, { ...headers })).not.toThrow();
    expect(() => new Webhook(generateWebhookSecret()).verify(body, { ...headers })).toThrow();
  });

  it('matches each signature entry to the secret that produced it', () => {
    const [current, previous, other] = [generateWebhookSecret(), generateWebhookSecret(), generateWebhookSecret()];
    const dual = signStandardWebhook([current, previous], 'evt_1', body);
    expect(matchSignatures([current, previous], dual, body).map((m) => m.secretIndex)).toEqual([0, 1]);
    const single = signStandardWebhook([current], 'evt_1', body);
    expect(matchSignatures([current, previous], single, body).map((m) => m.secretIndex)).toEqual([0]);
    const foreign = signStandardWebhook([other], 'evt_1', body);
    expect(matchSignatures([current, previous], foreign, body).map((m) => m.secretIndex)).toEqual([-1]);
    expect(matchSignatures([current], dual, body.replace('"total":1', '"total":2')).map((m) => m.secretIndex)).toEqual([-1, -1]);
  });

  it('fails verification when the body, id, or timestamp is tampered with', () => {
    const secret = generateWebhookSecret();
    const headers = signStandardWebhook([secret], 'evt_1', body);
    const webhook = new Webhook(secret);
    expect(() => webhook.verify(body.replace('"total":1', '"total":2'), { ...headers })).toThrow();
    expect(() => webhook.verify(body, { ...headers, 'webhook-id': 'evt_2' })).toThrow();
    expect(() => webhook.verify(body, { ...headers, 'webhook-timestamp': String(Number(headers['webhook-timestamp']) - 1) })).toThrow();
  });

  it('is rejected by the library when the timestamp is older than 5 minutes', () => {
    const secret = generateWebhookSecret();
    const headers = signStandardWebhook([secret], 'evt_1', body, new Date(Date.now() - 6 * 60 * 1000));
    expect(() => new Webhook(secret).verify(body, { ...headers })).toThrow(/too old/);
  });
});
