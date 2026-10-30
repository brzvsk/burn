import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { buildReport, type EntryLike, forkedAt, slimEntry, type UsageReport } from "../../../src/report.js";

const NEWLINE = 0x0a;
const CHUNK_BYTES = 1024 * 1024;
const FILES_MAX = 1000;
/** Entries kept per log; a longer session is read from its newest entries, as opencode's reader caps its messages. */
const ENTRIES_FILE_MAX = 50_000;
/** Entries kept across every log, so a host with many long sessions stays bounded; an evicted log is read again when asked for. */
const ENTRIES_TOTAL_MAX = 200_000;
/** A line with no newline this long is dropped instead of held, so one corrupt write cannot grow the buffer without bound. */
const CARRY_MAX_BYTES = 4 * 1024 * 1024;
const EXTENSION = ".jsonl";

/**
 * Where bb's pi bridge keeps each pi session on this machine (provider-pi's
 * resolvePiBridgeSessionDir). The bridge also honours BB_PI_BRIDGE_SESSION_DIR,
 * but host workers never see the daemon's BB_* variables.
 */
export function sessionDir(home = homedir()): string {
  return join(home, ".bb", "pi-bridge-sessions");
}

/** The file name stem bb's pi bridge uses for a session id (provider-pi's sanitizeSessionKey). */
export const sessionStem = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, "_");

export const sessionFile = (dir: string, id: string): string => join(dir, `${sessionStem(id)}${EXTENSION}`);

/** What has been read of one log: `offset` bytes, of which `carry` is a line pi has not finished writing. */
interface FileState {
  offset: number;
  mtimeMs: number;
  carry: Buffer;
  firstLine: string | null;
  header: unknown;
  entries: EntryLike[];
}

export interface PiSessions {
  /** The report of a thread's sessions on this machine; null when none has a file. */
  reportOf(sessionIds: readonly string[], timeZone: string): Promise<{ report: UsageReport; at: number } | null>;
  /** The session a changed path belongs to, or null when it is not a session log. */
  sessionIdOf(path: string): string | null;
}

const fresh = (): FileState => ({ offset: 0, mtimeMs: 0, carry: Buffer.alloc(0), firstLine: null, header: null, entries: [] });

function consumeLine(state: FileState, line: string): void {
  if (line.trim() === "") return;
  const first = state.firstLine === null;
  if (first) state.firstLine = line;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (first && (value as { type?: unknown } | null)?.type === "session") {
    state.header = value;
    return;
  }
  const entry = slimEntry(value);
  if (entry) state.entries.push(entry);
}

/** Drops the oldest entries past the per-file cap; the newest matter most for a live chip. */
function trim(state: FileState, max: number): void {
  const excess = state.entries.length - max;
  if (excess > 0) state.entries.splice(0, excess);
}

function consume(state: FileState, bytes: Buffer, carryMax: number): void {
  // Split on the newline byte, never inside a character: UTF-8 never uses 0x0a within one.
  const buf = state.carry.length > 0 ? Buffer.concat([state.carry, bytes]) : bytes;
  let start = 0;
  for (let end = buf.indexOf(NEWLINE); end !== -1; end = buf.indexOf(NEWLINE, start)) {
    consumeLine(state, buf.toString("utf8", start, end));
    start = end + 1;
  }
  state.carry = Buffer.from(buf.subarray(start));
  if (state.carry.length > carryMax) state.carry = Buffer.alloc(0);
}

async function readFirstLine(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

interface Limits {
  entriesFileMax: number;
  entriesTotalMax: number;
  carryMaxBytes: number;
}

async function readFrom(path: string, state: FileState, size: number, limits: Limits): Promise<void> {
  const handle = await open(path, "r");
  try {
    while (state.offset < size) {
      const length = Math.min(CHUNK_BYTES, size - state.offset);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, state.offset);
      if (bytesRead === 0) break;
      state.offset += bytesRead;
      consume(state, chunk.subarray(0, bytesRead), limits.carryMaxBytes);
      trim(state, limits.entriesFileMax);
    }
  } finally {
    await handle.close();
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === "ENOENT";

/**
 * Reads pi session logs incrementally: each file keeps what was parsed, as slim
 * entries, and later reads parse only the bytes pi appended. A file that shrank
 * or whose first line changed (pi rewrote it) is read again from the start.
 */
export function createPiSessions(opts: { dir: string; limits?: Partial<Limits> }): PiSessions {
  const limits: Limits = {
    entriesFileMax: opts.limits?.entriesFileMax ?? ENTRIES_FILE_MAX,
    entriesTotalMax: opts.limits?.entriesTotalMax ?? ENTRIES_TOTAL_MAX,
    carryMaxBytes: opts.limits?.carryMaxBytes ?? CARRY_MAX_BYTES,
  };
  const files = new Map<string, FileState>();
  const busy = new Map<string, Promise<FileState | null>>();

  /** Entries held across every file; recomputed at a keep, which runs once per file read. */
  function heldEntries(): number {
    let total = 0;
    for (const state of files.values()) total += state.entries.length;
    return total;
  }

  function keep(path: string, state: FileState): void {
    files.delete(path);
    files.set(path, state);
    // Drop the least recently read logs first. The one just read is last, so it is evicted only when it is the only one left.
    while ((files.size > FILES_MAX || heldEntries() > limits.entriesTotalMax) && files.size > 1) {
      const oldest = files.keys().next().value;
      if (oldest === undefined) break;
      files.delete(oldest);
    }
  }

  async function update(path: string): Promise<FileState | null> {
    let info: { size: number; mtimeMs: number };
    try {
      info = await stat(path);
    } catch (err) {
      if (!isMissing(err)) throw err;
      files.delete(path);
      return null;
    }
    let state = files.get(path);
    if (state && info.size === state.offset && info.mtimeMs === state.mtimeMs) {
      // Touch the entry so eviction follows last use, not last change.
      keep(path, state);
      return state;
    }
    if (state && (info.size < state.offset || (state.firstLine !== null && (await rewritten(path, state.firstLine))))) state = undefined;
    state ??= fresh();
    if (info.size > state.offset) await readFrom(path, state, info.size, limits);
    state.mtimeMs = info.mtimeMs;
    keep(path, state);
    return state;
  }

  async function rewritten(path: string, firstLine: string): Promise<boolean> {
    return (await readFirstLine(path, Buffer.byteLength(firstLine))) !== firstLine;
  }

  /** One read of a file at a time, so two calls never append the same lines twice. */
  function refresh(path: string): Promise<FileState | null> {
    const run = (busy.get(path) ?? Promise.resolve(null)).then(
      () => update(path),
      () => update(path),
    );
    busy.set(path, run);
    const done = () => {
      if (busy.get(path) === run) busy.delete(path);
    };
    run.then(done, done);
    return run;
  }

  return {
    async reportOf(sessionIds, timeZone) {
      const found: FileState[] = [];
      for (const id of new Set(sessionIds)) {
        const state = await refresh(sessionFile(opts.dir, id));
        if (state) found.push(state);
      }
      if (found.length === 0) return null;
      const began = (s: FileState): number => {
        const at = Date.parse((s.header as { timestamp?: string } | null)?.timestamp ?? "");
        return Number.isFinite(at) ? at : 0;
      };
      const entries = found
        .sort((a, b) => began(a) - began(b))
        .flatMap((s) => {
          const cut = forkedAt(s.header);
          return cut === null ? s.entries : s.entries.filter((e) => !(Date.parse(e.timestamp) < cut));
        });
      return { report: buildReport(entries, null, { timeZone }), at: Math.max(...found.map((s) => s.mtimeMs)) };
    },
    sessionIdOf(path) {
      const name = basename(path);
      return name.endsWith(EXTENSION) && name.length > EXTENSION.length ? name.slice(0, -EXTENSION.length) : null;
    },
  };
}
