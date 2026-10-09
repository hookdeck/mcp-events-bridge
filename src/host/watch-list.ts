import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../core/canonical-json.js';
import type { PastEvent } from '../core/event-history.js';
import { writeAtomically } from './providers-add.js';
import { abortableSleep, runWatch, type Poll, type WatchDeps } from './watch.js';

/*
 * `watch --list <file>`: watches from a file that changes while it runs, for a process that's
 * started once and kept running (a Claude Code plugin monitor), while `watches add|remove` edits
 * the list. Each watch's cursor is saved to a state file, so the next run resumes where this one
 * left off instead of starting from now.
 */

/** One watch: an event name and its arguments (filters), as events/poll takes them. */
export interface Watch {
  name: string;
  arguments: Record<string, unknown>;
}

export interface WatchListFile {
  watches: Watch[];
}

interface SavedCursor {
  cursor: string;
  savedAt: string;
}

/** Identifies a watch: the same name and arguments (in any key order) are the same watch. */
export const watchKey = (watch: Watch) => `${watch.name} ${canonicalJson(watch.arguments)}`;

/** A project's watch list and state files, in a store directory (a Claude Code plugin's data directory). */
export function projectPaths(store: string, project: string) {
  const resolved = path.resolve(project);
  const slug = `${path.basename(resolved).replace(/[^A-Za-z0-9_-]/g, '-')}-${createHash('sha256').update(resolved).digest('hex').slice(0, 10)}`;
  const dir = path.join(store, 'projects', slug);
  return { dir, list: path.join(dir, 'watches.json'), state: path.join(dir, 'state.json') };
}

export const statePathFor = (list: string) => path.join(path.dirname(list), `${path.basename(list, '.json')}.state.json`);

/** Reads a watch list; a missing file is an empty list. Throws on a file that isn't a list. */
export function readWatchList(file: string): Watch[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseWatchList(text);
}

export function parseWatchList(text: string): Watch[] {
  const parsed = JSON.parse(text) as Partial<WatchListFile>;
  if (!Array.isArray(parsed?.watches)) throw new Error('expected { "watches": [...] }');
  return parsed.watches.map((w, i) => {
    if (typeof w?.name !== 'string' || !w.name) throw new Error(`watches[${i}] has no name`);
    const args = w.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) throw new Error(`watches[${i}].arguments must be an object`);
    return { name: w.name, arguments: args };
  });
}

export function writeWatchList(file: string, watches: Watch[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomically(file, `${JSON.stringify({ watches } satisfies WatchListFile, null, 2)}\n`);
}

/** Adds a watch (no-op if it's there); returns false if it was already there. */
export function addWatch(watches: Watch[], watch: Watch): boolean {
  if (watches.some((w) => watchKey(w) === watchKey(watch))) return false;
  watches.push(watch);
  return true;
}

/** Removes watches for `name`: with `args`, only that watch; without, every watch for the name. Returns how many. */
export function removeWatches(watches: Watch[], name: string, args?: Record<string, unknown>): number {
  const before = watches.length;
  const keep = watches.filter((w) => (args ? watchKey(w) !== watchKey({ name, arguments: args }) : w.name !== name));
  watches.splice(0, watches.length, ...keep);
  return before - keep.length;
}

function readState(file: string): Record<string, SavedCursor> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, SavedCursor>;
  } catch {
    return {};
  }
}

export interface WatchListDeps {
  list: string;
  state: string;
  poll: Poll;
  onEvent: (event: PastEvent) => void;
  /** Something the agent should know about, printed with the events: a watch that can't run, a bridge that can't be reached. */
  onProblem: (problem: { problem: string; watch?: Watch }) => void;
  onError: WatchDeps['onError'];
  signal: AbortSignal;
  /** How often to check the list for changes (default 2 s). */
  reloadMs?: number;
  /** Resume from a saved cursor no older than this, skipping older events (default 24 hours). */
  resumeMaxAgeMs?: number;
  /** Consecutive failed polls before `onProblem` reports the bridge unreachable (default 5, about 30 s). */
  failuresToReport?: number;
  /** Save cursors at most this often (default 10 s). */
  saveEveryMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Runs the watches in `list`, following its changes, until `signal` aborts. */
export async function watchList(deps: WatchListDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const reloadMs = deps.reloadMs ?? 2000;
  const resumeMaxAgeMs = deps.resumeMaxAgeMs ?? 24 * 60 * 60 * 1000;
  const failuresToReport = deps.failuresToReport ?? 5;
  const saveEveryMs = deps.saveEveryMs ?? 10_000;

  const running = new Map<string, { watch: Watch; controller: AbortController; done: Promise<void> }>();
  const cursors = readState(deps.state);
  let dirty = false;
  let lastSave = 0;
  const save = (force = false) => {
    if (!dirty || (!force && now() - lastSave < saveEveryMs)) return;
    try {
      fs.mkdirSync(path.dirname(deps.state), { recursive: true });
      writeAtomically(deps.state, `${JSON.stringify(cursors, null, 2)}\n`);
      dirty = false;
      lastSave = now();
    } catch {
      // try again at the next save
    }
  };
  let unreachable = false;

  const start = (watch: Watch) => {
    const key = watchKey(watch);
    const controller = new AbortController();
    const saved = cursors[key];
    const fresh = saved && now() - Date.parse(saved.savedAt) <= resumeMaxAgeMs;
    const done = runWatch({
      ...watch,
      cursor: fresh ? saved.cursor : null,
      maxAgeMs: resumeMaxAgeMs,
      poll: deps.poll,
      onEvent: deps.onEvent,
      onCursor: (cursor) => {
        unreachable = false;
        cursors[key] = { cursor, savedAt: new Date(now()).toISOString() };
        dirty = true;
        save();
      },
      onError: (name, error, retryMs, failures) => {
        deps.onError(name, error, retryMs, failures);
        if (failures >= failuresToReport && !unreachable) {
          unreachable = true;
          deps.onProblem({ problem: `can't reach the bridge, still retrying: ${String((error as Error)?.message ?? error)}` });
        }
      },
      signal: controller.signal,
      sleep: deps.sleep,
    }).catch((error: unknown) => deps.onProblem({ problem: `stopped watching: ${String((error as Error)?.message ?? error)}`, watch }));
    running.set(key, { watch, controller, done });
  };

  let lastText: string | undefined;
  while (!deps.signal.aborted) {
    let text: string;
    try {
      text = fs.readFileSync(deps.list, 'utf8');
    } catch {
      text = '{"watches":[]}';
    }
    if (text !== lastText) {
      lastText = text;
      let watches: Watch[] | undefined;
      try {
        watches = parseWatchList(text);
      } catch (error) {
        deps.onProblem({ problem: `can't read the watch list ${deps.list}: ${(error as Error).message}` });
      }
      if (watches) {
        const wanted = new Map(watches.map((w) => [watchKey(w), w]));
        for (const [key, run] of running) {
          if (wanted.has(key)) continue;
          run.controller.abort();
          running.delete(key);
          delete cursors[key];
          dirty = true;
        }
        for (const [key, watch] of wanted) if (!running.has(key)) start(watch);
      }
    }
    save();
    await sleep(reloadMs, deps.signal);
  }
  for (const run of running.values()) run.controller.abort();
  await Promise.all([...running.values()].map((run) => run.done));
  save(true);
}
