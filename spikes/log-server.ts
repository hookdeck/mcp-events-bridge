import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/*
 * Spike helper: logs every request's method, path, headers and raw body to
 * spikes/raw/<n>.json (gitignored; may contain personal data) and returns 200.
 */
const port = Number(process.argv[2] ?? 4100);
const dir = path.join(import.meta.dirname, 'raw');
fs.mkdirSync(dir, { recursive: true });
let n = 0;

http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const file = path.join(dir, `${Date.now()}-${++n}.json`);
      fs.writeFileSync(file, JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }, null, 2));
      console.log(`[log-server] ${req.method} ${req.url} ${body.length} bytes -> ${path.basename(file)}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  })
  .listen(port, () => console.log(`[log-server] listening on ${port}`));
