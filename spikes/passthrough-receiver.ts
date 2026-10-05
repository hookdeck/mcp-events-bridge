import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Webhook } from 'standardwebhooks';
import { readSpikeSecret } from './spike-secret.js';

/*
 * Stage 3 receiver. Logs every attempt (headers, SHA-256 of the raw body,
 * Standard Webhooks verification) to spikes/raw/receiver.jsonl and answers by
 * the `x-spike-mode` header the publisher sets:
 *   fail-once    500 on the first attempt for a webhook-id, 200 after
 *   gone         410 every time
 *   always-fail  500 every time
 *   ok           200
 */
const port = Number(process.argv[2] ?? 4200);
const log = path.join(import.meta.dirname, 'raw', 'receiver.jsonl');
fs.mkdirSync(path.dirname(log), { recursive: true });
const webhook = new Webhook(readSpikeSecret());
const seen = new Map<string, number>();

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString('utf8');
      const headers = req.headers as Record<string, string>;
      const id = headers['webhook-id'] ?? '';
      const attempt = (seen.get(id) ?? 0) + 1;
      seen.set(id, attempt);

      let verified = true;
      let verifyError: string | undefined;
      try {
        webhook.verify(body, headers);
      } catch (error) {
        verified = false;
        verifyError = (error as Error).message;
      }

      const mode = headers['x-spike-mode'] ?? 'ok';
      const status =
        mode === 'gone' ? 410 : mode === 'always-fail' ? 500 : mode === 'fail-once' && attempt === 1 ? 500 : 200;

      const entry = {
        at: new Date().toISOString(),
        mode,
        webhookId: id,
        receiverAttempt: attempt,
        hookdeckAttempt: headers['x-hookdeck-attempt-count'],
        sha256: crypto.createHash('sha256').update(raw).digest('hex'),
        verified,
        verifyError,
        status,
        headers,
      };
      fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
      console.log(`[receiver] ${mode} ${id} attempt ${attempt} verified=${verified} -> ${status}`);
      res.writeHead(status, { 'content-type': 'application/json' }).end('{}');
    });
  })
  .listen(port, () => console.log(`[receiver] listening on ${port}`));
