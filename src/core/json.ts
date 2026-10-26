/*
 * Integers too large for a JavaScript number (above 2^53, such as int64 ids from Postmark, X or payment services)
 * are kept exact, as strings with every digit: `JSON.parse` would round 4323372036854775807 to 4323372036854776000.
 *
 * Event Gateway forwards a request's original bytes to the bridge when the connection has no transformation (verified
 * 26 Oct), so the relay parses deliveries with `parseJson` and the digits reach subscribers intact.
 */

/** `JSON.parse`, with each integer beyond 2^53 kept as a string of its digits. Needs Node 22's reviver `context.source`. */
export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && context?.source !== undefined && /^-?\d+$/.test(context.source) ? context.source : value,
  );
}
