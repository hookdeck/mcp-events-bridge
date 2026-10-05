import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigError, resolveConfig, type BridgeConfig, type ResolvedConfig } from '../core/config.js';

/*
 * Loads bridge.config.ts (or .js/.mjs) from the working directory. The CLI
 * runs under tsx, so a TypeScript config imports directly.
 */
export const CONFIG_FILES = ['bridge.config.ts', 'bridge.config.mts', 'bridge.config.js', 'bridge.config.mjs'];

export async function loadConfig(
  { cwd = process.cwd(), file, environment = process.env }: { cwd?: string; file?: string; environment?: Record<string, string | undefined> } = {},
): Promise<ResolvedConfig> {
  const found = file ? path.resolve(cwd, file) : CONFIG_FILES.map((name) => path.join(cwd, name)).find((candidate) => fs.existsSync(candidate));
  if (!found || !fs.existsSync(found)) throw new ConfigError(`No config file found (looked for ${CONFIG_FILES.join(', ')} in ${cwd})`);
  const module = (await import(pathToFileURL(found).href)) as { default?: BridgeConfig };
  if (!module.default) throw new ConfigError(`${path.basename(found)} has no default export; export default defineConfig({ ... })`);
  return resolveConfig(module.default, environment);
}
