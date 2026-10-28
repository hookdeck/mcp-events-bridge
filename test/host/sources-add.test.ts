import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { env } from '../../src/core/config.js';
import { EMPTY_CONFIG, insertSource, missingEnvLines, referencedEnv, sourceSnippet, writeAtomically } from '../../src/host/sources-add.js';
import type { SourceOptions } from '../../src/core/sources/source.js';
import { loadConfig } from '../../src/host/load-config.js';

const options: SourceOptions = {
  id: 'fills',
  type: 'webhook',
  verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },
  events: ['order.filled'],
  eventId: { header: 'x-delivery-id' },
  filters: ['symbol', 'side'],
};
const snippet = sourceSnippet(options);

const readme = `import { defineConfig, env } from '@hookdeck/mcp-events-bridge';
import { github, resend } from '@hookdeck/mcp-events-bridge/sources';

export default defineConfig({
  // Names this deployment's Event Gateway resources.
  deployment: process.env.BRIDGE_DEPLOYMENT ?? 'dev',
  sources: [
    resend({ apiKey: env('RESEND_API_KEY') }),
    // Only setup uses the token.
    github({ token: env('GITHUB_TOKEN', { optional: true }), scope: { repos: ['your-org/your-repo'] } }),
  ],
});
`;

describe('sources add: snippet and .env', () => {
  it('writes the entry as a source({...}) call, id and type first, with env() references', () => {
    expect(snippet).toBe(
      [
        'source({',
        "  id: 'fills',",
        "  type: 'webhook',",
        "  verification: { type: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'x-signature', secret: env('FILLS_WEBHOOK_SECRET') },",
        "  events: ['order.filled'],",
        "  eventId: { header: 'x-delivery-id' },",
        "  filters: ['symbol', 'side'],",
        '})',
      ].join('\n'),
    );
    expect(sourceSnippet({ ...options, events: { 'order.filled': { value: "it's" } } })).toContain(`events: { 'order.filled': { value: 'it\\'s' } },`);
    expect(sourceSnippet({ id: 'stripe', type: 'stripe', secret: env('STRIPE_WEBHOOK_SECRET'), events: ['invoice.paid'] })).toBe(
      ['source({', "  id: 'stripe',", "  type: 'stripe',", "  secret: env('STRIPE_WEBHOOK_SECRET'),", "  events: ['invoice.paid'],", '})'].join('\n'),
    );
  });

  it("finds a webhook source's credentials in verification, and a service's at the top level", () => {
    expect(referencedEnv({ ...options, type: 'webhook', verification: { type: 'basic-auth', username: env('FILLS_USER'), password: env('FILLS_PASS') } })).toEqual([
      { name: 'FILLS_USER', field: 'username' },
      { name: 'FILLS_PASS', field: 'password' },
    ]);
    expect(referencedEnv({ type: 'postmark', username: env('POSTMARK_USERNAME'), password: env('POSTMARK_PASSWORD'), events: ['bounce'] })).toEqual([
      { name: 'POSTMARK_USERNAME', field: 'username' },
      { name: 'POSTMARK_PASSWORD', field: 'password' },
    ]);
  });

  it("appends only the variables the .env file doesn't mention, empty, and never touches existing lines", () => {
    const vars = [
      { name: 'FILLS_USER', field: 'username' },
      { name: 'FILLS_PASS', field: 'password' },
    ];
    const existing = 'HOOKDECK_API_KEY=abc\nexport FILLS_USER=bridge';
    const { text, added } = missingEnvLines(existing, 'fills', vars);
    expect(added).toEqual(['FILLS_PASS']);
    expect(text.startsWith('\n\n# Source "fills"')).toBe(true);
    expect(text).toContain('# FILLS_PASS: the Basic auth password');
    expect(text.endsWith('\nFILLS_PASS=\n')).toBe(true);
    expect(text).not.toContain('FILLS_USER=');

    const again = missingEnvLines(existing + text, 'fills', vars);
    expect(again).toEqual({ text: '', added: [] });
    expect(missingEnvLines('', 'fills', vars).text.startsWith('# Source')).toBe(true);
  });
});

describe('sources add: config edit', () => {
  it('inserts the entry and the imports, keeping the rest of the file as it was', async () => {
    const result = await insertSource(readme, 'fills', snippet);
    expect(result.status).toBe('inserted');
    const code = (result as { code: string }).code;
    expect(code).toContain("import { github, resend, source } from '@hookdeck/mcp-events-bridge/sources';");
    expect(code).toContain(
      [
        "    github({ token: env('GITHUB_TOKEN', { optional: true }), scope: { repos: ['your-org/your-repo'] } }),",
        '    source({',
        "      id: 'fills',",
      ].join('\n'),
    );
    expect(code).toContain("      filters: ['symbol', 'side'],\n    }),\n  ],\n});\n");
    // Everything outside the imports and the new entry is unchanged.
    expect(code.replace(/import[^\n]*\n/g, '').replace(/\n    source\(\{[\s\S]*?\n    \}\),/, '')).toBe(readme.replace(/import[^\n]*\n/g, ''));
    // And it's idempotent.
    expect(await insertSource(code, 'fills', snippet)).toEqual({ status: 'exists' });
  });

  it('produces a config that loads, with the instance waiting for its secret', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-add-'));
    try {
      const config = `import { defineConfig } from '${path.resolve('src/index.js')}';\nimport { resend } from '${path.resolve('src/sources.js')}';\n\nexport default defineConfig({\n  deployment: 'dev',\n  sources: [resend({ apiKey: 'x' })],\n});\n`;
      const result = await insertSource(config, 'fills', snippet);
      expect(result.status).toBe('inserted');
      writeAtomically(path.join(dir, 'bridge.config.ts'), (result as { code: string }).code);
      expect(fs.readdirSync(dir)).toEqual(['bridge.config.ts']);
      const loaded = await loadConfig({ cwd: dir, environment: { HOOKDECK_API_KEY: 'k', HOOKDECK_SIGNING_SECRET: 's' } });
      const fills = loaded.sources.find((p) => p.id === 'fills')!;
      expect(fills.events).toEqual(['order.filled']);
      expect(fills.definition.missingCredentials!(fills.options)).toEqual(['FILLS_WEBHOOK_SECRET']);
      expect(loaded.warnings).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles an empty array, a single-line array and a bare object export', async () => {
    const empty = await insertSource(`import { defineConfig } from '@hookdeck/mcp-events-bridge';\nexport default defineConfig({\n  deployment: 'dev',\n  sources: [],\n});\n`, 'fills', snippet);
    expect(empty.status).toBe('inserted');
    expect((empty as { code: string }).code).toContain("  sources: [\n    source({\n      id: 'fills',");
    expect((empty as { code: string }).code).toContain("import { defineConfig, env } from '@hookdeck/mcp-events-bridge';");
    expect((empty as { code: string }).code).toContain("import { source } from '@hookdeck/mcp-events-bridge/sources';");
    // The file --write-config starts when there's none (also the skill's start). An added import declaration
    // goes straight after the others, with no blank line between them.
    const skillStart = await insertSource(EMPTY_CONFIG, 'fills', snippet);
    expect((skillStart as { code: string }).code).toMatch(/^import \{ defineConfig, env \} from '@hookdeck\/mcp-events-bridge';\nimport \{ source \} from '@hookdeck\/mcp-events-bridge\/sources';\n\nexport default/);

    const oneLine = await insertSource(`import { defineConfig, env } from '@hookdeck/mcp-events-bridge';\nimport { resend } from '@hookdeck/mcp-events-bridge/sources';\nexport default defineConfig({ deployment: 'dev', sources: [resend({ apiKey: env('K') })] });\n`, 'fills', snippet);
    expect(oneLine.status).toBe('inserted');
    expect((oneLine as { code: string }).code).toContain("sources: [resend({ apiKey: env('K') }), source({");
  });

  it("refuses shapes it can't edit safely, leaving the caller to print the snippet", async () => {
    // This repo's own config: sources enabled conditionally with a spread.
    const repoConfig = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'bridge.config.ts'), 'utf8');
    expect(await insertSource(repoConfig, 'fills', snippet)).toEqual({ status: 'refused', reason: expect.stringMatching(/spread/) });
    const refused = async (source: string) => ((await insertSource(source, 'fills', snippet)) as { reason?: string }).reason;
    expect(await refused(`import { defineConfig } from '@hookdeck/mcp-events-bridge';\nconst config = defineConfig({ deployment: 'dev', sources: [] });\nexport default config;\n`)).toMatch(/default export/);
    expect(await refused(`import { defineConfig } from '@hookdeck/mcp-events-bridge';\nexport default defineConfig({ deployment: 'dev', sources: makeSources() });\n`)).toMatch(/array literal/);
    expect(await refused(`export default { deployment: 'dev', sources: [] };\n`)).toMatch(/defineConfig/);
    expect(await refused(`import { defineConfig } from '@hookdeck/mcp-events-bridge';\nimport { source } from './my-sources';\nexport default defineConfig({ deployment: 'dev', sources: [] });\n`)).toMatch(/source.*bound/);
    expect(await refused('export default defineConfig({ sources: [ }')).toMatch(/parse/);
  });
});
