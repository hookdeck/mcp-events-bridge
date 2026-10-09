import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internalError, invalidParams, notFound } from '../../src/core/errors.js';
import type { PastEvent } from '../../src/core/event-history.js';
import { addWatch, parseWatchList, projectPaths, pruneState, readWatchList, removeWatches, updateWatchList, watchKey, watchList, writeWatchList, type Watch } from '../../src/host/watch-list.js';
import type { PollRequest } from '../../src/host/watch.js';

const comments: Watch = { name: 'github.issue_comment', arguments: { repository: 'hookdeck/hookdeck-demos' } };
const issues: Watch = { name: 'github.issues', arguments: { repository: 'hookdeck/hookdeck-demos' } };
const event = (eventId: string, name = comments.name): PastEvent => ({ eventId, name, timestamp: '2026-10-09T13:00:00.000Z', data: {} });

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-list-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('watch list file', () => {
  it('reads a missing file as empty, and round-trips', () => {
    const file = path.join(tempDir(), 'sub', 'watches.json');
    expect(readWatchList(file)).toEqual([]);
    writeWatchList(file, [comments]);
    expect(readWatchList(file)).toEqual([comments]);
  });

  it('rejects a file that isn\'t a watch list', () => {
    expect(() => parseWatchList('[]')).toThrow('expected { "watches": [...] }');
    expect(() => parseWatchList('{"watches":[{"arguments":{}}]}')).toThrow('has no name');
    expect(parseWatchList('{"watches":[{"name":"x"}]}')).toEqual([{ name: 'x', arguments: {} }]);
  });

  it('adds once, whatever the key order, and removes by name or by watch', () => {
    const watches: Watch[] = [];
    expect(addWatch(watches, comments)).toBe(true);
    expect(addWatch(watches, { name: comments.name, arguments: { ...comments.arguments } })).toBe(false);
    addWatch(watches, { name: comments.name, arguments: { repository: 'hookdeck/website' } });
    addWatch(watches, issues);
    expect(removeWatches(watches, comments.name, { repository: 'hookdeck/website' })).toBe(1);
    expect(removeWatches(watches, comments.name)).toBe(1);
    expect(watches).toEqual([issues]);
    expect(watchKey({ name: 'a', arguments: { b: 1, a: 2 } })).toBe(watchKey({ name: 'a', arguments: { a: 2, b: 1 } }));
  });

  it('waits for another process\'s lock, and takes over a stale one', async () => {
    const file = path.join(tempDir(), 'watches.json');
    const lock = `${file}.lock`;
    fs.writeFileSync(lock, '');
    await expect(updateWatchList(file, (w) => addWatch(w, comments), { waitMs: 50 })).rejects.toThrow('the watch list is locked');
    setTimeout(() => fs.rmSync(lock, { force: true }), 30);
    await updateWatchList(file, (w) => addWatch(w, comments), { waitMs: 2000 });
    expect(readWatchList(file)).toEqual([comments]);
    fs.writeFileSync(lock, '');
    fs.utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await updateWatchList(file, (w) => addWatch(w, issues));
    expect(readWatchList(file)).toEqual([comments, issues]);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('gives each project its own files in the store', () => {
    const a = projectPaths('/store', '/Users/me/git/repo');
    const b = projectPaths('/store', '/Users/me/other/repo');
    expect(a.list).toMatch(/^\/store\/projects\/repo-[0-9a-f]{10}\/watches\.json$/);
    expect(a.state).toBe(path.join(a.dir, 'state.json'));
    expect(a.dir).not.toBe(b.dir);
  });
});

/** Runs watchList against a scripted bridge: each watch's polls return its queued events, then nothing. */
function harness(options: { list: string; state: string; now?: () => number; failing?: boolean; fatal?: string[]; bridgeError?: string[]; rejectCursor?: string; describe?: (e: unknown) => string }) {
  const controller = new AbortController();
  const requests: PollRequest[] = [];
  const queued = new Map<string, PastEvent[]>();
  const printed: PastEvent[] = [];
  const problems: Array<{ problem: string; watch?: Watch }> = [];
  let n = 0;
  const done = watchList({
    list: options.list,
    state: options.state,
    signal: controller.signal,
    reloadMs: 5,
    saveEveryMs: 0,
    failuresToReport: 2,
    now: options.now,
    describe: options.describe,
    sleep: (ms, signal) => new Promise((resolve) => (signal.aborted ? resolve() : setTimeout(resolve, Math.min(ms, 5)))),
    poll: async (request) => {
      requests.push(request);
      if (options.fatal?.includes(request.name)) throw notFound('event', `Unknown event: ${request.name}`);
      if (options.failing) throw new Error('fetch failed');
      if (options.bridgeError?.includes(request.name)) throw internalError('No Event Gateway source for github: run setup');
      if (options.rejectCursor !== undefined && request.cursor === options.rejectCursor) throw invalidParams('cursor is not a cursor this bridge returned', { field: 'cursor' });
      const events = queued.get(request.name)?.splice(0) ?? [];
      return { events, cursor: `${request.name}#${++n}`, hasMore: false, nextPollMs: 5 };
    },
    onEvent: (e) => printed.push(e),
    onProblem: (p) => problems.push(p),
    onError: () => {},
  });
  return {
    requests,
    printed,
    problems,
    queue: (name: string, ...events: PastEvent[]) => queued.set(name, [...(queued.get(name) ?? []), ...events]),
    stop: async () => {
      controller.abort();
      await done;
    },
  };
}

describe('watchList', () => {
  it('follows the list as it changes: starts added watches, stops removed ones', async () => {
    const dir = tempDir();
    const list = path.join(dir, 'watches.json');
    const h = harness({ list, state: path.join(dir, 'state.json') });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.requests).toEqual([]); // no list yet: nothing to watch, no connection

    writeWatchList(list, [comments]);
    await vi.waitFor(() => expect(h.requests.some((r) => r.name === comments.name)).toBe(true));
    expect(h.requests[0]).toMatchObject({ ...comments, cursor: null });
    h.queue(comments.name, event('e1'));
    await vi.waitFor(() => expect(h.printed.map((e) => e.eventId)).toEqual(['e1']));

    writeWatchList(list, [issues]);
    await vi.waitFor(() => expect(h.requests.some((r) => r.name === issues.name)).toBe(true));
    const commentPolls = h.requests.filter((r) => r.name === comments.name).length;
    await new Promise((r) => setTimeout(r, 30));
    expect(h.requests.filter((r) => r.name === comments.name).length).toBeLessThanOrEqual(commentPolls + 1);
    await h.stop();
  });

  it('saves cursors, and the next run resumes from them with maxAgeMs', async () => {
    const dir = tempDir();
    const list = path.join(dir, 'watches.json');
    const state = path.join(dir, 'state.json');
    writeWatchList(list, [comments]);
    const first = harness({ list, state });
    await vi.waitFor(() => expect(first.requests.length).toBeGreaterThan(1));
    await first.stop();
    const saved = JSON.parse(fs.readFileSync(state, 'utf8'))[watchKey(comments)];
    expect(saved.cursor).toMatch(/^github\.issue_comment#\d+$/);

    const second = harness({ list, state });
    await vi.waitFor(() => expect(second.requests.length).toBeGreaterThan(0));
    expect(second.requests[0]).toMatchObject({ cursor: saved.cursor, maxAgeMs: 24 * 60 * 60 * 1000 });
    await second.stop();
  });

  it('resumes from an old saved cursor too, skipping events older than a day', async () => {
    const dir = tempDir();
    const list = path.join(dir, 'watches.json');
    const state = path.join(dir, 'state.json');
    writeWatchList(list, [comments]);
    fs.writeFileSync(state, JSON.stringify({ [watchKey(comments)]: { cursor: 'old', savedAt: '2026-10-01T00:00:00.000Z' } }));
    const h = harness({ list, state });
    await vi.waitFor(() => expect(h.requests.length).toBeGreaterThan(0));
    expect(h.requests[0]).toMatchObject({ cursor: 'old', maxAgeMs: 24 * 60 * 60 * 1000 });
    await h.stop();
  });

  it('starts from now when the bridge rejects a saved cursor', async () => {
    const dir = tempDir();
    const list = path.join(dir, 'watches.json');
    const state = path.join(dir, 'state.json');
    writeWatchList(list, [comments]);
    fs.writeFileSync(state, JSON.stringify({ [watchKey(comments)]: { cursor: 'v0', savedAt: new Date().toISOString() } }));
    const h = harness({ list, state, rejectCursor: 'v0' });
    await vi.waitFor(() => expect(h.requests.length).toBeGreaterThan(2));
    expect(h.requests.slice(0, 2).map((r) => r.cursor)).toEqual(['v0', null]);
    expect(h.problems).toEqual([]);
    await h.stop();
  });

  it('drops cursors of watches not in the list, at start and when removed, but not while the file is missing', async () => {
    const dir = tempDir();
    const list = path.join(dir, 'watches.json');
    const state = path.join(dir, 'state.json');
    writeWatchList(list, [comments]);
    fs.writeFileSync(state, JSON.stringify({ [watchKey(issues)]: { cursor: 'gone', savedAt: new Date().toISOString() } }));
    const h = harness({ list, state });
    await vi.waitFor(() => expect(Object.keys(JSON.parse(fs.readFileSync(state, 'utf8')))).toEqual([watchKey(comments)]));

    fs.rmSync(list); // an editor deleting and rewriting the file
    await new Promise((r) => setTimeout(r, 30));
    expect(Object.keys(JSON.parse(fs.readFileSync(state, 'utf8')))).toEqual([watchKey(comments)]);
    writeWatchList(list, [comments]);
    const before = h.requests.length;
    await vi.waitFor(() => expect(h.requests.length).toBeGreaterThan(before));
    expect(h.requests.at(-1)!.cursor).not.toBeNull();

    writeWatchList(list, []);
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(state, 'utf8'))).toEqual({}));
    await h.stop();
  });

  it('pruneState removes saved cursors for watches not in a list', () => {
    const state = path.join(tempDir(), 'state.json');
    fs.writeFileSync(state, JSON.stringify({ [watchKey(comments)]: { cursor: 'a', savedAt: 'x' }, [watchKey(issues)]: { cursor: 'b', savedAt: 'x' } }));
    pruneState(state, [issues]);
    expect(Object.keys(JSON.parse(fs.readFileSync(state, 'utf8')))).toEqual([watchKey(issues)]);
  });

  it('reports one failing watch as that watch, not the bridge, and with the error described', async () => {
    const dir = tempDir();
    const list = path.join(dir, 'watches.json');
    writeWatchList(list, [issues, comments]);
    const h = harness({ list, state: path.join(dir, 'state.json'), bridgeError: [issues.name], describe: (e) => `described: ${(e as Error).message}` });
    await vi.waitFor(() => expect(h.problems.length).toBe(1), { timeout: 5000 });
    expect(h.problems[0]).toEqual({ problem: 'this watch keeps failing, still retrying: described: No Event Gateway source for github: run setup', watch: issues });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.problems.length).toBe(1);
    await h.stop();
  });

  it('reports a watch that can\'t run, and keeps the others', async () => {
    const dir = tempDir();
    const list = path.join(dir, 'watches.json');
    writeWatchList(list, [{ name: 'github.nope', arguments: {} }, comments]);
    const h = harness({ list, state: path.join(dir, 'state.json'), fatal: ['github.nope'] });
    await vi.waitFor(() => expect(h.problems).toEqual([{ problem: 'stopped watching: Unknown event: github.nope', watch: { name: 'github.nope', arguments: {} } }]));
    h.queue(comments.name, event('e1'));
    await vi.waitFor(() => expect(h.printed.map((e) => e.eventId)).toEqual(['e1']));
    await h.stop();
  });

  it('reports an unreachable bridge once, and a list it can\'t read', async () => {
    const dir = tempDir();
    const list = path.join(dir, 'watches.json');
    writeWatchList(list, [comments]);
    const h = harness({ list, state: path.join(dir, 'state.json'), failing: true });
    await vi.waitFor(() => expect(h.problems.length).toBe(1), { timeout: 5000 });
    expect(h.problems[0]!.problem).toBe("can't reach the bridge, still retrying: fetch failed");
    fs.writeFileSync(list, 'not json');
    await vi.waitFor(() => expect(h.problems.length).toBe(2));
    expect(h.problems[1]!.problem).toMatch(/^can't read the watch list/);
    await h.stop();
  });
});
