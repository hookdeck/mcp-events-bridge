import type { DataFilter } from './sources/types.js';

/*
 * Subscription filters. A source event's `filter(args)` gives one for a subscription's arguments; Event Gateway applies
 * it on the subscription's connection, and the bridge applies the same one itself for poll mode, so a subscription
 * and a poll with the same arguments get the same events. Only the subset sources produce is supported: equal
 * values, nested objects, arrays that contain every listed item, and `$or` at the top level.
 */

/** Whether `value` (an event's `data`) matches a source's filter, as Event Gateway would decide. */
export function matchesFilter(filter: DataFilter, value: unknown): boolean {
  return Object.entries(filter).every(([key, want]) => {
    if (key === '$or') return Array.isArray(want) && want.some((alternative) => matchesFilter(alternative as DataFilter, value));
    const field = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
    return matchesValue(want, field);
  });
}

function matchesValue(want: unknown, field: unknown): boolean {
  if (Array.isArray(want)) return Array.isArray(field) && want.every((item) => field.some((candidate) => matchesValue(item, candidate)));
  if (typeof want === 'object' && want !== null) return matchesFilter(want as DataFilter, field);
  return field === want;
}

/**
 * The filter rule for a subscription's connection: the event's MCP name, the arguments' filter on `data`, and no
 * `x-mcp-skip` header (the transformation sets it on anything it can't deliver). `$or` is lifted to the top of the
 * body, the shape verified against Event Gateway.
 */
export function connectionFilterRule(name: string, filter: DataFilter) {
  const { $or, ...rest } = filter;
  const body: Record<string, unknown> = { name, ...(Object.keys(rest).length > 0 && { data: rest }) };
  if (Array.isArray($or)) body.$or = $or.map((alternative) => ({ data: alternative }));
  return { type: 'filter' as const, headers: { 'x-mcp-skip': { $exist: false } }, body };
}
