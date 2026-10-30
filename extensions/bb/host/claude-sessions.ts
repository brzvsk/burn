import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_PRICES, listCost, priceOf } from "../../../src/prices.js";
import { buildReport, type EntryLike, type UsageReport, promptExcerpt } from "../../../src/report.js";

export const claudeProjectsDir = (env = process.env): string => join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const safeId = (id: string): boolean => /^[a-zA-Z0-9_-]+$/.test(id);
const object = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
interface FileState {
  offset: number;
  carry: Buffer;
  stamp: number;
  ino: number;
  firstLine: string | null;
  entries: Map<string, EntryLike>;
}

/** Reads only exact session identities and their subagent trees, never neighbouring sessions.
 * Usage belongs to an API message, not each content-block record in the transcript.
 * Keep the newest snapshot for a message; do not deduplicate by token values or UUID.
 */
interface OwnHistory {
  since?: number;
  parentSessionIds?: readonly string[];
}

export function createClaudeSessions(opts: { dir: string }) {
  const files = new Map<string, FileState>();
  let gate: Promise<unknown> = Promise.resolve();
  async function directories(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }
  async function children(dir: string): Promise<string[]> {
    let rows;
    try {
      rows = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const found: string[] = [];
    for (const e of rows) {
      if (e.isDirectory()) found.push(...(await children(join(dir, e.name))));
      else if (e.isFile() && e.name.startsWith("agent-") && e.name.endsWith(".jsonl")) found.push(join(dir, e.name));
    }
    return found;
  }
  function consume(state: FileState, line: string, session: string, child: boolean): void {
    state.firstLine ??= line;
    let row;
    try {
      row = object(JSON.parse(line));
    } catch {
      return;
    }
    if (!row || (typeof row.sessionId === "string" && row.sessionId !== session)) return;
    const m = object(row.message);
    if (!m || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) return;
    if (
      row.type === "user" &&
      !child &&
      !row.isMeta &&
      !row.isCompactSummary &&
      (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some((c) => object(c)?.type === "text")))
    ) {
      if (typeof row.uuid === "string")
        state.entries.set("prompt:" + row.uuid, {
          type: "message",
          timestamp: row.timestamp,
          message: { role: "user", content: promptExcerpt(m.content) },
        } as EntryLike);
      return;
    }
    const u = object(m.usage);
    if (row.type !== "assistant" || !u || typeof m.id !== "string") return;
    const model = typeof m.model === "string" ? m.model : "unknown";
    const tokens = {
      input: number(u.input_tokens),
      output: number(u.output_tokens),
      cacheRead: number(u.cache_read_input_tokens),
      cacheWrite: number(u.cache_creation_input_tokens),
    };
    const price = priceOf(ANTHROPIC_PRICES, model);
    const cost = price ? listCost(price, tokens, { tiers: true }) : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    // Anthropic's one-hour write is 2x input versus the five-minute 1.25x input.
    const hour = number(object(u.cache_creation)?.ephemeral_1h_input_tokens);
    if (price && hour > 0 && tokens.cacheWrite > 0) {
      const extra = (cost.cacheWrite * 0.6 * Math.min(hour, tokens.cacheWrite)) / tokens.cacheWrite;
      cost.cacheWrite += extra;
      cost.total += extra;
    }
    const key = "usage:" + m.id;
    const previous = state.entries.get(key);
    state.entries.set(key, {
      type: "message",
      timestamp: previous?.timestamp ?? row.timestamp,
      message: { role: "assistant", provider: "claude-code", model, usage: { ...tokens, cost, estimated: price !== null } },
    } as EntryLike);
  }
  async function read(path: string, session: string, child: boolean): Promise<FileState | null> {
    let info;
    try {
      info = await stat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let state = files.get(path);
    if (state?.firstLine && info.size > state.offset) {
      const head = await open(path, "r");
      try {
        const bytes = Buffer.alloc(Buffer.byteLength(state.firstLine));
        const read = await head.read(bytes, 0, bytes.length, 0);
        if (bytes.toString("utf8", 0, read.bytesRead) !== state.firstLine) state = undefined;
      } finally {
        await head.close();
      }
    }
    if (!state || info.size < state.offset || info.ino !== state.ino || (info.size === state.offset && info.mtimeMs !== state.stamp)) {
      state = { offset: 0, carry: Buffer.alloc(0), stamp: 0, ino: info.ino, firstLine: null, entries: new Map() };
    }
    const handle = await open(path, "r");
    try {
      while (state.offset < info.size) {
        const buf = Buffer.alloc(Math.min(1024 * 1024, info.size - state.offset));
        const { bytesRead } = await handle.read(buf, 0, buf.length, state.offset);
        if (!bytesRead) break;
        state.offset += bytesRead;
        const data = Buffer.concat([state.carry, buf.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          consume(state, data.toString("utf8", start, end), session, child);
          start = end + 1;
        }
        state.carry = Buffer.from(data.subarray(start));
      }
    } finally {
      await handle.close();
    }
    state.stamp = info.mtimeMs;
    files.delete(path);
    files.set(path, state);
    if (files.size > 1000) files.delete(files.keys().next().value!);
    return state;
  }
  async function report(sessionIds: readonly string[], timeZone: string, own: OwnHistory): Promise<{ report: UsageReport; at: number } | null> {
    const roots = await directories(opts.dir);
    const entries = new Map<string, EntryLike>();
    const inherited = new Set<string>();
    let missingParent = false;
    for (const parent of own.parentSessionIds ?? []) {
      if (!safeId(parent)) continue;
      let found = false;
      for (const root of roots) {
        const state = await read(join(root, parent + ".jsonl"), parent, false);
        if (!state) continue;
        found = true;
        for (const key of state.entries.keys()) inherited.add(key);
        for (const path of await children(join(root, parent, "subagents"))) {
          const sub = await read(path, parent, true);
          if (sub) for (const key of sub.entries.keys()) inherited.add(key);
        }
      }
      if (!found) missingParent = true;
    }
    const keep = (key: string, value: EntryLike) => !inherited.has(key) && (own.since === undefined || Date.parse(value.timestamp) >= own.since);
    let at = 0,
      found = 0,
      missing = 0;
    for (const id of new Set(sessionIds.filter(safeId))) {
      // BB thread ids are a Pi fallback, not Claude session identities.
      if (id.startsWith("thr_")) continue;
      let matched = false;
      for (const root of roots) {
        const main = await read(join(root, id + ".jsonl"), id, false);
        if (!main) continue;
        matched = true;
        found++;
        for (const [key, value] of main.entries) {
          if (keep(key, value)) entries.set(id + ":" + key, value);
        }
        at = Math.max(at, main.stamp);
        for (const path of await children(join(root, id, "subagents"))) {
          const sub = await read(path, id, true);
          if (!sub) continue;
          at = Math.max(at, sub.stamp);
          for (const [key, value] of sub.entries) {
            if (keep(key, value) && !entries.has(id + ":" + key)) entries.set(id + ":" + key, { ...value, agentId: id + ":" + path.split("/").pop()!.replace(/\.jsonl$/, "") });
          }
        }
      }
      if (!matched) missing++;
    }
    if (!found) return null;
    const report = buildReport(
      [...entries.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
      null,
      { timeZone },
    );
    report.agents = { coverage: missing || missingParent ? "partial" : "available", rows: report.agents?.rows ?? [] };
    report.coverage = missing || missingParent ? "partial" : "available";
    report.coverageNote =
      missing || missingParent
        ? "Partial saved history: some session or subagent history is unavailable."
        : "Saved history includes subagents. Background calls are grouped by time; deleted or external API logs cannot be recovered.";
    return { report, at };
  }
  return {
    reportOf(ids: readonly string[], zone: string, own: OwnHistory = {}) {
      const run = gate.then(() => report(ids, zone, own));
      gate = run.catch(() => undefined);
      return run;
    },
  };
}
