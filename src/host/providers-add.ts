import fs from 'node:fs';
import path from 'node:path';
import type { EnvRef } from '../core/config.js';
import type { WebhookOptions } from '../core/providers/webhook.js';

/*
 * `mcp-events-bridge providers add webhook <id>`: the pieces that touch the
 * user's files. Everything here works on strings, so it's testable without a
 * file system; the command in cli.ts does the reading and writing.
 *
 *   webhookSnippet       the webhook({...}) entry to paste into bridge.config.ts
 *   missingEnvLines      the .env lines to append for variables the entry references
 *   insertProvider       adds the entry to `providers: [...]`, or refuses with a reason
 */

const isEnvRef = (value: unknown): value is EnvRef => typeof value === 'object' && value !== null && (value as EnvRef).kind === 'env';
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A TypeScript literal for a config value, with env() references as calls. */
function literal(value: unknown): string {
  if (isEnvRef(value)) return `env(${literal(value.name)}${value.optional ? ', { optional: true }' : ''})`;
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, inner]) => inner !== undefined);
    if (!entries.length) return '{}';
    return `{ ${entries.map(([key, inner]) => `${IDENTIFIER.test(key) ? key : literal(key)}: ${literal(inner)}`).join(', ')} }`;
  }
  throw new Error(`can't write ${typeof value} into the config`);
}

/** The `webhook({...})` call for bridge.config.ts, one option per line. */
export function webhookSnippet(options: WebhookOptions): string {
  const lines = Object.entries(options)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `  ${key}: ${literal(value)},`);
  return `webhook({\n${lines.join('\n')}\n})`;
}

/** The env() variable names an options object references, with what each holds. */
export function referencedEnv(options: WebhookOptions): Array<{ name: string; field: string }> {
  return Object.entries(options.verification)
    .filter((entry): entry is [string, EnvRef] => isEnvRef(entry[1]))
    .map(([field, ref]) => ({ name: ref.name, field }));
}

/**
 * Lines to append to a .env file for variables it doesn't mention yet, empty
 * (never a value): a comment, then `NAME=` for each. Returns the names added.
 */
export function missingEnvLines(existing: string, id: string, vars: Array<{ name: string; field: string }>): { text: string; added: string[] } {
  const present = (name: string) => new RegExp(`^\\s*(export\\s+)?${name.replace(/[$]/g, '\\$')}\\s*=`, 'm').test(existing);
  const missing = vars.filter((v) => !present(v.name));
  if (!missing.length) return { text: '', added: [] };
  const lead = existing.length && !existing.endsWith('\n') ? '\n' : '';
  const gap = existing.trim().length ? '\n' : '';
  const block = [
    `# Generic webhook "${id}" (added by mcp-events-bridge providers add webhook). Leave empty until the sender gives you`,
    `# the value, then run setup again: Event Gateway verifies requests with it.`,
    ...missing.map((v) => `# ${v.name}: the ${v.field === 'secret' ? 'signing secret' : v.field === 'key' ? 'API key' : `Basic auth ${v.field}`}`),
    ...missing.map((v) => `${v.name}=`),
  ];
  return { text: `${lead}${gap}${block.join('\n')}\n`, added: missing.map((v) => v.name) };
}

export type InsertResult = { status: 'inserted'; code: string } | { status: 'exists' } | { status: 'refused'; reason: string };

type Node = { type: string; start: number; end: number; loc: { start: { line: number }; end: { line: number } }; [key: string]: any };

const lineIndent = (source: string, index: number) => /^[ \t]*/.exec(source.slice(source.lastIndexOf('\n', index - 1) + 1))![0];
const indentLines = (text: string, indent: string) => text.split('\n').join(`\n${indent}`);

/** The webhook({ id: '<id>' }) call among the array's elements, if there is one. */
const hasWebhook = (array: Node, id: string) =>
  array.elements.some(
    (el: Node | null) =>
      el?.type === 'CallExpression' &&
      el.callee?.type === 'Identifier' &&
      el.callee.name === 'webhook' &&
      el.arguments[0]?.type === 'ObjectExpression' &&
      el.arguments[0].properties.some(
        (p: Node) => p.type === 'ObjectProperty' && (p.key?.name === 'id' || p.key?.value === 'id') && p.value?.type === 'StringLiteral' && p.value.value === id,
      ),
  );

/**
 * Adds a webhook entry to the config's `providers` array, and the `webhook`
 * and `env` imports it needs. The array is edited as text at positions from
 * the parsed AST, so the rest of the file keeps its formatting; imports are
 * edited through magicast. Refuses (and the caller prints the snippet) when
 * the file isn't a shape it can edit safely: no `export default
 * defineConfig({ providers: [...] })` (or a plain object), providers built
 * with spreads or anything but an array literal, or imports it can't place.
 */
export async function insertProvider(source: string, id: string, snippet: string): Promise<InsertResult> {
  const { parseModule, generateCode } = await import('magicast');
  const refuse = (reason: string): InsertResult => ({ status: 'refused', reason });
  let mod;
  try {
    mod = parseModule(source);
  } catch (error) {
    return refuse(`couldn't parse it (${(error as Error).message})`);
  }

  const exported = mod.exports.default as any;
  const options = exported?.$type === 'function-call' && exported.$callee === 'defineConfig' ? exported.$args[0] : exported;
  if (!options || options.$type !== 'object') return refuse('its default export isn\'t `defineConfig({ ... })` or an object literal');
  const array = options.$ast.properties.find(
    (p: Node) => p.type === 'ObjectProperty' && !p.computed && (p.key?.name === 'providers' || p.key?.value === 'providers'),
  )?.value as Node | undefined;
  if (!array) return refuse('it has no `providers` property');
  if (array.type !== 'ArrayExpression') return refuse('`providers` isn\'t an array literal');
  if (array.elements.some((el: Node | null) => !el || el.type === 'SpreadElement')) {
    return refuse('`providers` is built with a spread (for example providers enabled conditionally)');
  }
  if (hasWebhook(array, id)) return { status: 'exists' };

  const imports = mod.imports.$items as Array<{ from: string; imported: string; local: string }>;
  const main = imports.find((i) => i.imported === 'defineConfig')?.from;
  if (!main) return refuse('it doesn\'t import defineConfig, so the module to import webhook and env from isn\'t known');
  // The package's providers entry point, or (working from source, as in this repo) the providers module already imported.
  const providersModule = /^[./]/.test(main)
    ? imports.find((i) => /\/providers(\.[cm]?[jt]s)?$/.test(i.from))?.from
    : `${main}/providers`;
  if (!providersModule) return refuse('the module to import webhook from isn\'t known');
  for (const [name, from] of [['webhook', providersModule], ['env', main]] as const) {
    const binding = imports.find((i) => i.local === name);
    if (binding && (binding.imported !== name || binding.from !== from)) return refuse(`\`${name}\` is already bound to something else`);
  }

  // 1. The entry, spliced into the array text.
  const elements = array.elements as Node[];
  let code: string;
  if (!elements.length) {
    const indent = lineIndent(source, array.start);
    code = `${source.slice(0, array.start)}[\n${indent}  ${indentLines(snippet, `${indent}  `)},\n${indent}]${source.slice(array.end)}`;
  } else {
    const last = elements.at(-1)!;
    const indent = lineIndent(source, last.start);
    const trailingComma = /^\s*,/.exec(source.slice(last.end, array.end));
    const multiline = array.loc.start.line !== array.loc.end.line;
    const at = trailingComma ? last.end + trailingComma[0].length : last.end;
    const entry = multiline ? `\n${indent}${indentLines(snippet, indent)}` : ` ${indentLines(snippet, indent)}`;
    code = `${source.slice(0, at)}${trailingComma ? '' : ','}${entry}${trailingComma && multiline ? ',' : ''}${source.slice(at)}`;
  }

  // 2. The imports, through magicast (only import declarations are reprinted).
  let edited;
  try {
    edited = parseModule(code);
  } catch (error) {
    return refuse(`the edit didn't parse (${(error as Error).message})`);
  }
  const have = new Set((edited.imports.$items as Array<{ local: string }>).map((i) => i.local));
  if (!have.has('webhook')) edited.imports.$append({ from: providersModule, imported: 'webhook' });
  if (!have.has('env')) edited.imports.$append({ from: main, imported: 'env' });
  code = generateCode(edited).code;
  // magicast puts a blank line before an import declaration it adds; keep the imports together, as they were.
  for (const line of code.split('\n').filter((l) => l.startsWith('import ') && !source.includes(l))) code = code.replace(`\n\n${line}`, `\n${line}`);
  if (source.endsWith('\n') && !code.endsWith('\n')) code += '\n';

  // 3. Check the result before anything is written.
  try {
    const check = parseModule(code);
    const checkOptions = (check.exports.default as any).$type === 'function-call' ? (check.exports.default as any).$args[0] : check.exports.default;
    const checkArray = (checkOptions as any).$ast.properties.find((p: Node) => p.key?.name === 'providers' || p.key?.value === 'providers').value as Node;
    const locals = new Set((check.imports.$items as Array<{ local: string }>).map((i) => i.local));
    if (!hasWebhook(checkArray, id) || !locals.has('webhook') || !locals.has('env')) return refuse('the edited file didn\'t check out');
  } catch (error) {
    return refuse(`the edited file didn't parse (${(error as Error).message})`);
  }
  return { status: 'inserted', code };
}

/** Writes a file through a temporary file and a rename, so it's never left half-written. */
export function writeAtomically(file: string, content: string) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}
