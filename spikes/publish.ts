import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Webhook } from 'standardwebhooks';
import { readSpikeSecret } from './spike-secret.js';

/*
 * Stage 3 and 4 publisher: builds an MCP Events envelope, signs it once with
 * Standard Webhooks (as the relay would), and sends it through the Hookdeck
 * Publish API. Logs what it sent to spikes/raw/published.jsonl.
 *
 *   npx tsx spikes/publish.ts --source spike-passthrough --sub sub_a --mode fail-once [--id evt_...]
 */
try {
  process.loadEnvFile();
} catch {
  // rely on the environment
}

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: 'spike-passthrough' },
    sub: { type: 'string', default: 'sub_a' },
    mode: { type: 'string', default: 'ok' },
    id: { type: 'string' },
  },
});

const eventId = values.id ?? `evt_spike_${crypto.randomBytes(6).toString('hex')}`;
const body = JSON.stringify({
  eventId,
  name: 'email.received',
  timestamp: new Date().toISOString(),
  data: { emailId: 'spike', subject: `stage spike (${values.mode})` },
  cursor: null,
});
const now = new Date();
const signature = new Webhook(readSpikeSecret()).sign(eventId, now, body);
const headers = {
  'content-type': 'application/json',
  'webhook-id': eventId,
  'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
  'webhook-signature': signature,
  'x-mcp-subscription-id': values.sub!,
  'x-spike-mode': values.mode!,
};

const res = await fetch('https://hkdk.events/v1/publish', {
  method: 'POST',
  headers: {
    ...headers,
    authorization: `Bearer ${process.env.HOOKDECK_API_KEY}`,
    'x-hookdeck-source-name': values.source!,
  },
  body,
});
const sha256 = crypto.createHash('sha256').update(body).digest('hex');
const entry = { at: now.toISOString(), source: values.source, status: res.status, response: await res.text(), sha256, headers };
fs.mkdirSync(path.join(import.meta.dirname, 'raw'), { recursive: true });
fs.appendFileSync(path.join(import.meta.dirname, 'raw', 'published.jsonl'), `${JSON.stringify(entry)}\n`);
console.log(`[publish] ${eventId} sub=${values.sub} mode=${values.mode} -> HTTP ${res.status} sha256=${sha256.slice(0, 12)}`);
