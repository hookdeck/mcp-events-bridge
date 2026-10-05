import fs from 'node:fs';
import { Tunnel, bin, install } from 'cloudflared';

/*
 * Dev only: a Cloudflare quick tunnel (random https://*.trycloudflare.com URL,
 * no account) to a local port. Writes the URL to .tunnel-url.
 *
 *   npx tsx spikes/tunnel.ts 4200
 */
const port = Number(process.argv[2] ?? 4200);
if (!fs.existsSync(bin)) {
  console.log(`[tunnel] downloading the cloudflared binary to ${bin}`);
  await install(bin);
}
const tunnel = Tunnel.quick(`http://localhost:${port}`);
const url = await new Promise<string>((resolve) => tunnel.once('url', resolve));
fs.writeFileSync('.tunnel-url', `${url}\n`);
console.log(`[tunnel] ${url} -> http://localhost:${port}`);
const stop = () => {
  fs.rmSync('.tunnel-url', { force: true });
  tunnel.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
