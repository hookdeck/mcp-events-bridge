/*
 * Summarizes `mcp-trace` lines (BRIDGE_MCP_TRACE / BRIDGE_LIST_CHANGED_TEST) as one short line each, for the
 * list-changed test (docs/list-changed-test.md). Reads a bridge log on stdin; other lines (the bridge's own, such as
 * "list-changed test: ... bumped") pass through, marked with `--`.
 *
 *   fly logs -a mcp-events-bridge-dev --no-tail | npx tsx scripts/trace-summary.ts
 *   npx tsx scripts/trace-summary.ts < bridge.log
 *   npx tsx scripts/trace-summary.ts --from 120 < bridge.log    # from line 120 on
 */
import readline from 'node:readline';

const fromIndex = process.argv.indexOf('--from');
const from = fromIndex >= 0 ? Number(process.argv[fromIndex + 1]) : 1;

type Record = { [key: string]: any };
const pick = (object: Record | undefined, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => object?.[k] !== undefined).map((k) => [k, object![k]]));
const short = (value: unknown) => (value === undefined || (typeof value === 'object' && value !== null && Object.keys(value).length === 0) ? '' : JSON.stringify(value));

let lineNumber = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (++lineNumber < from) continue;
  const at = line.indexOf('mcp-trace {');
  if (at < 0) {
    if (line.includes('list-changed test:')) console.log(`-- ${line.slice(line.indexOf('list-changed test:'))}`);
    continue;
  }
  let r: Record;
  try {
    r = JSON.parse(line.slice(at + 'mcp-trace '.length));
  } catch {
    continue;
  }
  const time = String(r.t).slice(11, 23);
  if (r.dir === 'in') {
    const m: Record = r.rpc?.[0] ?? {};
    const client = m.clientInfo ? `${m.clientInfo.name}/${m.clientInfo.version}` : '';
    const rpc = r.rpc?.length > 1 ? `batch(${r.rpc.map((x: Record) => x.method).join(',')})` : (m.method ?? '');
    console.log(
      [time, `#${r.n}`, 'IN ', r.http, r.stream ? `[${r.stream}]` : '', rpc, short(pick(m, ['protocolVersion', 'name', 'notifications'])), client, `hdr=${r.mcpProtocolVersion ?? '-'}`, r.sessionId ? `sid=${r.sessionId}` : '', `ua=${r.userAgent ?? '-'}`]
        .filter(Boolean)
        .join(' '),
    );
  } else if (r.dir === 'out' || r.dir === 'stream-close') {
    const results = (r.results ?? []).map((x: Record) => short(pick(x, ['tools', 'events', 'error', 'protocolVersion', 'capabilities', 'ttlMs']))).filter(Boolean);
    console.log([time, `#${r.n}`, r.dir === 'out' ? 'OUT' : 'CLOSE', r.status, `${r.ms}ms`, r.finished === false ? '(client went away)' : '', ...results].filter((x) => x !== '').join(' '));
  } else if (r.dir === 'notify') {
    console.log([time, `#${r.n}`, 'NOTIFY', r.method, short(r.notifications)].filter(Boolean).join(' '));
  } else if (r.dir === 'stream-open') {
    console.log([time, `#${r.n}`, 'STREAM', r.status].join(' '));
  }
}
