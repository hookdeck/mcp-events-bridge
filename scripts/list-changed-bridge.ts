/*
 * A bridge for the list-changed test (docs/list-changed-test.md) on this machine, against a fake Event Gateway: no
 * Hookdeck project, source or listen. Only the MCP side is real, which is all the test looks at: the capabilities,
 * the notification streams, events/list and tools/list, and the trigger that changes them.
 *
 *   BRIDGE_MCP_SECRET=<any URL-safe value> npx tsx scripts/list-changed-bridge.ts [port]
 *
 * BRIDGE_LIST_CHANGED_SESSION_ID=1 also answers a 2025-era initialize with an Mcp-Session-Id.
 *
 * Then point the client at http://127.0.0.1:<port>/mcp (Authorization: Bearer <secret>) or /mcp/<secret>, and change
 * a list with: curl -X POST -H "Authorization: Bearer $BRIDGE_MCP_SECRET" http://127.0.0.1:<port>/debug/list-changed?lists=both
 */
import { defineConfig, resolveConfig } from '../src/core/config.js';
import { HookdeckClient } from '../src/core/hookdeck.js';
import { MemoryStore } from '../src/core/memory-store.js';
import { createBridgeServer } from '../src/host/server.js';
import { resend } from '../src/sources.js';
import { FakeEventGateway } from '../test/support/fake-event-gateway.js';

const secret = process.env.BRIDGE_MCP_SECRET;
if (!secret) throw new Error('Set BRIDGE_MCP_SECRET (any URL-safe value)');
const port = Number(process.argv[2] ?? 8090);

const gateway = new FakeEventGateway();
gateway.sources.set('src_resend', { id: 'src_resend', name: 'bridge-resend', type: 'RESEND', url: 'https://hkdk.events/src_resend' });
const config = resolveConfig(defineConfig({ deployment: 'list-changed-test', port, inbound: 'cli', sources: [resend({ apiKey: 'unused' })] }), {
  HOOKDECK_API_KEY: 'unused',
  HOOKDECK_SIGNING_SECRET: 'unused',
  BRIDGE_MCP_SECRET: secret,
});
const bridge = await createBridgeServer(config, {
  hookdeck: new HookdeckClient({ apiKey: 'unused', fetch: gateway.fetch }),
  store: new MemoryStore(),
  listChangedTest: true,
  listChangedSessionId: process.env.BRIDGE_LIST_CHANGED_SESSION_ID === '1',
  // cli inbound binds 127.0.0.1; no callback URL tools, which need a real hookdeck listen.
  localAgents: false,
  version: 'list-changed-test',
  log: (message) => console.log(`[bridge] ${message}`),
});
await bridge.listen();
console.log(`[bridge] list-changed test bridge on http://127.0.0.1:${port}/mcp (fake Event Gateway)`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void bridge.close().then(() => process.exit(0)));
