import type { ResolvedSource } from './config.js';
import { invalidParams } from './errors.js';
import type { EventRuntime, JsonSchema, SourceEvent } from './sources/types.js';
import { instantiateRuntime } from './transformation.js';

/**
 * The events the bridge offers: every enabled event of every configured provider instance, named
 * `{instance id}.{provider's event name}` (e.g. `resend.email.received`, `github.issues`, `fills.order.filled`), so
 * instances can't clash and the catalog says which provider each event comes from.
 */
export const mcpEventName = (providerId: string, eventName: string) => `${providerId}.${eventName}`;

/**
 * ChatGPT has been reported to leave out event types whose description is longer than about this, without saying
 * so. Not verified here; the built-in providers' longest description is 299 characters.
 */
export const LONG_DESCRIPTION = 400;

/** A warning for each event whose description is longer than LONG_DESCRIPTION, for `setup` and `serve` to print. */
export const descriptionWarnings = (catalog: Catalog) =>
  catalog
    .list()
    .filter((e) => e.description.length > LONG_DESCRIPTION)
    .map(
      (e) =>
        `${e.name}'s description is ${e.description.length} characters. ChatGPT has been reported to leave out events ` +
        `whose description is over about ${LONG_DESCRIPTION}, so shorten it if ChatGPT doesn't offer ${e.name}`,
    );

/** A JSON Schema's type in TypeScript's notation, which models read well: `string`, `string[]`, `string | number`. */
function schemaType(schema: unknown): string {
  if (typeof schema !== 'object' || schema === null) return 'unknown';
  const s = schema as Record<string, unknown>;
  const union = s.anyOf ?? s.oneOf;
  if (Array.isArray(union)) return union.map(schemaType).join(' | ');
  if (Array.isArray(s.enum)) return s.enum.map((value) => JSON.stringify(value)).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (s.type === 'array') {
    const item = schemaType(s.items);
    return item.includes(' ') ? `(${item})[]` : `${item}[]`;
  }
  return typeof s.type === 'string' ? s.type : 'unknown';
}

export interface ArgumentDescription {
  type: string;
  description?: string;
  required?: true;
}

/**
 * The arguments an event type takes, from its inputSchema: each one's type and description. For the error that
 * names a wrong argument, so an agent can correct the call.
 */
export function describeArguments(inputSchema: JsonSchema): Record<string, ArgumentDescription> {
  const properties = (inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(inputSchema.required) ? (inputSchema.required as string[]) : [];
  return Object.fromEntries(
    Object.entries(properties).map(([key, schema]) => [
      key,
      {
        type: schemaType(schema),
        ...(typeof schema.description === 'string' && { description: schema.description }),
        ...(required.includes(key) && { required: true as const }),
      },
    ]),
  );
}

/** What a parseArguments error says, in a line: zod's issues by field (an unknown key named as such), else its message. */
function describeArgumentsError(error: unknown): string {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return error instanceof Error ? error.message : String(error);
  return issues
    .map((issue: { code?: string; keys?: string[]; path?: PropertyKey[]; message?: string }) => {
      if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
        return `unknown argument${issue.keys.length === 1 ? '' : 's'} ${issue.keys.map((key) => JSON.stringify(key)).join(', ')}`;
      }
      const path = issue.path?.length ? issue.path.map(String).join('.') : 'arguments';
      return `${path}: ${issue.message ?? 'invalid'}`;
    })
    .join('; ');
}

/**
 * The InvalidParams error for arguments an event's parseArguments refused. `data.detail` names the bad or unknown
 * field and lists the arguments the event takes, so an agent can correct the call.
 */
export function argumentsError(name: string, event: Pick<SourceEvent, 'inputSchema'>, error: unknown) {
  const args = Object.entries(describeArguments(event.inputSchema));
  const takes = args.length ? `${name} takes ${args.map(([key, f]) => `${key} (${f.type})`).join(', ')}` : `${name} takes no arguments`;
  return invalidParams('arguments do not match the inputSchema', { detail: `${describeArgumentsError(error)}. ${takes}` });
}

export interface CatalogEntry {
  /** The MCP event name: `{instance id}.{event.name}`. */
  name: string;
  providerId: string;
  // Events have varying argument types.
  event: SourceEvent<any>;
  /** How the event is built from a request: the source runtime's entry for it, as the transformation runs it. */
  runtime: EventRuntime;
}

export class Catalog {
  private readonly byName = new Map<string, CatalogEntry>();

  constructor(providers: ResolvedSource[]) {
    for (const provider of providers) {
      const runtimes = instantiateRuntime(provider.definition);
      for (const event of provider.definition.events) {
        if (!provider.events.includes(event.name)) continue;
        const name = mcpEventName(provider.id, event.name);
        // Ids are unique and have no dots, so a name splits at its first dot and can't repeat: an assertion.
        if (this.byName.has(name)) throw new Error(`Two sources offer "${name}"`);
        const runtime = runtimes[event.name];
        if (!runtime) throw new Error(`Source ${provider.id}: its runtime has no entry for the event "${event.name}"`);
        this.byName.set(name, { name, providerId: provider.id, event, runtime });
      }
    }
  }

  get(name: string) {
    return this.byName.get(name);
  }

  /** Entries for one provider instance, for mapping its inbound requests. */
  forProvider(providerId: string) {
    return [...this.byName.values()].filter((entry) => entry.providerId === providerId);
  }

  /** The `events/list` response items. */
  list() {
    return [...this.byName.values()].map(({ name, event }) => ({
      name,
      description: event.description,
      delivery: ['webhook', 'poll'],
      inputSchema: event.inputSchema,
      payloadSchema: event.payloadSchema,
    }));
  }
}
