import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { env } from '../../src/core/config.js';
import { insertProvider, missingEnvLines, referencedEnv, webhookSnippet, writeAtomically } from '../../src/host/providers-add.js';
import type { WebhookOptions } from '../../src/core/providers/webhook.js';
import { loadConfig } from '../../src/host/load-config.js';

const options: WebhookOptions = {
  id: 'fills',
  verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },
  events: ['order.filled'],
  eventId: { header: 'x-delivery-id' },
  filters: ['symbol', 'side'],
};
const snippet = webhookSnippet(options);

const readme = `import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
import { github, resend } from '@hookdeck/mcp-events-bridge/providers';

export default defineConfig({
  // Names this deployment's Event Gateway resources.
  deployment: process.env.BRIDGE_DEPLOYMENT ?? 'dev',
  providers: [
    resend({ apiKey: env('RESEND_API_KEY') }),
    // Only setup uses the token.
    github({ token: env('GITHUB_TOKEN', { optional: true }), scope: { repos: ['your-org/your-repo'] } }),
  ],
});
`;

describe('providers add webhook: snippet and .env', () => {
  it('writes the entry as a webhook({...}) call with env() references', () => {
    expect(snippet).toBe(
      [
        'webhook({',
        "  id: 'fills',",
        "  verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },",
        "  events: ['order.filled'],",
        "  eventId: { header: 'x-delivery-id' },",
        "  filters: ['symbol', 'side'],",
        '})',
      ].join('\n'),
    );
    expect(webhookSnippet({ ...options, events: { 'order.filled': { value: "it's" } } })).toContain(`events: { 'order.filled': { value: 'it\\'s' } },`);
  });

  it('appends only the variables the .env file doesn\'t mention, empty, and never touches existing lines', () => {
    const vars = referencedEnv({ ...options, verification: { type: 'basic-auth', username: env('FILLS_USER'), password: env('FILLS_PASS') } });
    expect(vars).toEqual([{ name: 'FILLS_USER', field: 'username' }, { name: 'FILLS_PASS', field: 'password' }]);

    const existing = 'HOOKDECK_API_KEY=abc\nexport FILLS_USER=bridge';
    const { text, added } = missingEnvLines(existing, 'fills', vars);
    expect(added).toEqual(['FILLS_PASS']);
    expect(text.startsWith('\n\n# Generic webhook "fills"')).toBe(true);
    expect(text.endsWith('\nFILLS_PASS=\n')).toBe(true);
    expect(text).not.toContain('FILLS_USER=');

    const again = missingEnvLines(existing + text, 'fills', vars);
    expect(again).toEqual({ text: '', added: [] });
    expect(missingEnvLines('', 'fills', vars).text.startsWith('# Generic webhook')).toBe(true);
  });
});

describe('providers add webhook: config edit', () => {
  it('inserts the entry and the imports, keeping the rest of the file as it was', async () => {
    const result = await insertProvider(readme, 'fills', snippet);
    expect(result.status).toBe('inserted');
    const code = (result as { code: string }).code;
    expect(code).toContain("import { github, resend, webhook } from '@hookdeck/mcp-events-bridge/providers';");
    expect(code).toContain(
      [
        "    github({ token: env('GITHUB_TOKEN', { optional: true }), scope: { repos: ['your-org/your-repo'] } }),",
        '    webhook({',
        "      id: 'fills',",
      ].join('\n'),
    );
    expect(code).toContain("      filters: ['symbol', 'side'],\n    }),\n  ],\n});\n");
    // Everything outside the imports and the new entry is unchanged.
    expect(code.replace(/import[^\n]*\n/g, '').replace(/\n    webhook\(\{[\s\S]*?\n    \}\),/, '')).toBe(readme.replace(/import[^\n]*\n/g, ''));
    // And it's idempotent.
    expect(await insertProvider(code, 'fills', snippet)).toEqual({ status: 'exists' });
  });

  it('produces a config that loads, with the instance waiting for its secret', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-add-'));
    try {
      const source = `import { defineConfig } from '${path.resolve('src/index.js')}';\nimport { resend } from '${path.resolve('src/providers.js')}';\n\nexport default defineConfig({\n  deployment: 'dev',\n  providers: [resend({ apiKey: 'x' })],\n});\n`;
      const result = await insertProvider(source, 'fills', snippet);
      expect(result.status).toBe('inserted');
      writeAtomically(path.join(dir, 'bridge.config.ts'), (result as { code: string }).code);
      expect(fs.readdirSync(dir)).toEqual(['bridge.config.ts']);
      const config = await loadConfig({ cwd: dir, environment: { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' } });
      const fills = config.providers.find((p) => p.id === 'fills')!;
      expect(fills.events).toEqual(['order.filled']);
      expect(fills.definition.missingCredentials!(fills.options)).toEqual(['FILLS_WEBHOOK_SECRET']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles an empty array, a single-line array and a bare object export', async () => {
    const empty = await insertProvider(`import { defineConfig } from '@hookdeck/mcp-events-bridge';\nexport default defineConfig({\n  deployment: 'dev',\n  providers: [],\n});\n`, 'fills', snippet);
    expect(empty.status).toBe('inserted');
    expect((empty as { code: string }).code).toContain("  providers: [\n    webhook({\n      id: 'fills',");
    expect((empty as { code: string }).code).toContain("import { defineConfig, env } from '@hookdeck/mcp-events-bridge';");
    expect((empty as { code: string }).code).toContain("import { webhook } from '@hookdeck/mcp-events-bridge/providers';");

    const oneLine = await insertProvider(`import { defineConfig, env } from '@hookdeck/mcp-events-bridge';\nimport { resend } from '@hookdeck/mcp-events-bridge/providers';\nexport default defineConfig({ deployment: 'dev', providers: [resend({ apiKey: env('K') })] });\n`, 'fills', snippet);
    expect(oneLine.status).toBe('inserted');
    expect((oneLine as { code: string }).code).toContain("providers: [resend({ apiKey: env('K') }), webhook({");
  });

  it('refuses shapes it can\'t edit safely, leaving the caller to print the snippet', async () => {
    // This repo's own config: providers enabled conditionally with a spread.
    const repoConfig = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'bridge.config.ts'), 'utf8');
    expect(await insertProvider(repoConfig, 'fills', snippet)).toEqual({ status: 'refused', reason: expect.stringMatching(/spread/) });
    const refused = async (source: string) => ((await insertProvider(source, 'fills', snippet)) as { reason?: string }).reason;
    expect(await refused(`import { defineConfig } from '@hookdeck/mcp-events-bridge';\nconst config = defineConfig({ deployment: 'dev', providers: [] });\nexport default config;\n`)).toMatch(/default export/);
    expect(await refused(`import { defineConfig } from '@hookdeck/mcp-events-bridge';\nexport default defineConfig({ deployment: 'dev', providers: makeProviders() });\n`)).toMatch(/array literal/);
    expect(await refused(`export default { deployment: 'dev', providers: [] };\n`)).toMatch(/defineConfig/);
    expect(await refused(`import { defineConfig } from '@hookdeck/mcp-events-bridge';\nimport { webhook } from './my-webhooks';\nexport default defineConfig({ deployment: 'dev', providers: [] });\n`)).toMatch(/webhook.*bound/);
    expect(await refused('export default defineConfig({ providers: [ }')).toMatch(/parse/);
  });
});
