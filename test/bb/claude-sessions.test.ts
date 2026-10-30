import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeSessions, claudeProjectsDir } from "../../extensions/bb/host/claude-sessions.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const timestamp = "2026-10-27T12:00:00.000Z";
const call = (id: string, output = 10, model = "claude-opus-5-5", sessionId = "session-a") => ({
  type: "assistant",
  timestamp,
  sessionId,
  message: { id, model, usage: { input_tokens: 100, output_tokens: output, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 } },
});
const line = (o: unknown) => JSON.stringify(o) + "\n";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "burn-claude-"));
  dirs.push(dir);
  const project = join(dir, "project");
  mkdirSync(project);
  const main = join(project, "session-a.jsonl");
  const subdir = join(project, "session-a", "subagents", "workflows", "run-1");
  mkdirSync(subdir, { recursive: true });
  const sub = join(subdir, "agent-a.jsonl");
  return { dir, project, main, sub, reader: createClaudeSessions({ dir }) };
}
describe("Claude transcripts", () => {
  it("counts API messages once across duplicate content blocks and recursive workflow files", async () => {
    const s = setup();
    writeFileSync(s.main, line(call("main")) + line(call("main")));
    writeFileSync(s.sub, line(call("child", 20, "claude-haiku-4-5")) + line(call("child", 20, "claude-haiku-4-5")));
    writeFileSync(join(s.project, "neighbour.jsonl"), line(call("unrelated")));
    const got = await s.reader.reportOf(["session-a", "session-a", "thr_fallback"], "UTC");
    expect(got?.report.calls).toBe(2);
    expect(got?.report.tokens).toMatchObject({ input: 200, output: 30, cacheRead: 400, cacheWrite: 100 });
    expect(got?.report.byModel.map((m) => m.key).sort()).toEqual(["claude-code/claude-haiku-4-5", "claude-code/claude-opus-5-5"]);
    expect(await s.reader.reportOf(["session-a"], "UTC")).toEqual(got);
    expect(await createClaudeSessions({ dir: s.dir }).reportOf(["session-a"], "UTC")).toEqual(got);
  });
  it("replaces usage snapshots and waits for complete JSONL lines including UTF-8", async () => {
    const s = setup();
    writeFileSync(s.main, line(call("a", 1)));
    expect((await s.reader.reportOf(["session-a"], "UTC"))?.report.tokens.output).toBe(1);
    const update = JSON.stringify({ ...call("a", 30), comment: "Привет" });
    appendFileSync(s.main, update.slice(0, -2));
    expect((await s.reader.reportOf(["session-a"], "UTC"))?.report.tokens.output).toBe(1);
    appendFileSync(s.main, update.slice(-2) + "\n");
    const report = (await s.reader.reportOf(["session-a"], "UTC"))?.report;
    expect(report?.calls).toBe(1);
    expect(report?.tokens.output).toBe(30);
  });
  it("ignores copied fork history with another session id and traversal identities", async () => {
    const s = setup();
    writeFileSync(s.main, line(call("old", 500, "unknown", "parent-session")) + line(call("new")));
    expect((await s.reader.reportOf(["session-a"], "UTC"))?.report.calls).toBe(1);
    expect(await s.reader.reportOf(["../session-a", "missing"], "UTC")).toBeNull();
  });
  it("rereads rewritten files, prices 1h cache and retains unknown model tokens", async () => {
    const s = setup();
    const one = call("one");
    Object.assign(one.message.usage, { cache_creation: { ephemeral_1h_input_tokens: 50 } });
    writeFileSync(s.main, line(one));
    const got = await s.reader.reportOf(["session-a"], "UTC");
    expect(got?.report.cost.cacheWrite).toBeCloseTo((50 * 8) / 1e6);
    writeFileSync(s.main, line(call("two", 2, "private-alias")));
    const report = (await s.reader.reportOf(["session-a", "missing"], "UTC"))?.report;
    expect(report?.calls).toBe(1);
    expect(report?.tokens.output).toBe(2);
    expect(report?.cost.total).toBe(0);
    expect(report?.coverageNote).toContain("Partial");
  });
  it("detects a larger in-place rewrite and counts string user prompts", async () => {
    const s = setup();
    writeFileSync(s.main, line(call("old")));
    await s.reader.reportOf(["session-a"], "UTC");
    writeFileSync(s.main, line({ type: "user", uuid: "u", timestamp, message: { content: "Hello" } }) + line(call("replacement-longer-id", 99)));
    const got = await s.reader.reportOf(["session-a"], "UTC");
    expect(got?.report.calls).toBe(1);
    expect(got?.report.tokens.output).toBe(99);
    expect(got?.report.turnCount).toBe(1);
  });
  it("honours CLAUDE_CONFIG_DIR", () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: "/custom" })).toBe("/custom/projects");
  });
});

it("excludes inherited fork messages even when session ids and copied timestamps were rewritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "burn-fork-"));
  dirs.push(dir);
  const project = join(dir, "project");
  mkdirSync(project);
  const inherited = call("copied");
  writeFileSync(join(project, "parent.jsonl"), line({ ...inherited, sessionId: "parent" }));
  writeFileSync(join(project, "session-a.jsonl"), line(inherited) + line(call("own", 4)));
  const reader = createClaudeSessions({ dir });
  const got = await reader.reportOf(["session-a"], "UTC", { parentSessionIds: ["parent"], since: Date.parse(timestamp) });
  expect(got?.report.calls).toBe(1);
  expect(got?.report.tokens.output).toBe(4);
  expect((await reader.reportOf(["parent"], "UTC"))?.report.calls).toBe(1);
});

it("exposes native spend as a subset, with stable ids across reads", async () => {
  const s = setup();
  writeFileSync(s.main, line(call("main")));
  writeFileSync(s.sub, line(call("native", 20)) + line(call("native", 20)));
  const got = await s.reader.reportOf(["session-a"], "UTC");
  expect(got?.report.agents?.coverage).toBe("available");
  expect(got?.report.agents?.rows).toHaveLength(1);
  expect(got?.report.agents?.rows[0]?.calls).toBe(1);
  expect(got!.report.agents!.rows[0]!.cost.total).toBeLessThan(got!.report.cost.total);
});

it("excludes copied parent subagent snapshots even with rewritten timestamps", async () => {
  const s = setup();
  const parentSubs = join(s.project, 'parent', 'subagents', 'nested');
  mkdirSync(parentSubs, { recursive: true });
  writeFileSync(join(s.project, 'parent.jsonl'), line({...call('parent-main'), sessionId:'parent'}));
  writeFileSync(join(parentSubs, 'agent-parent.jsonl'), line({...call('copied-native', 99), sessionId:'parent'}));
  writeFileSync(s.main, line(call('own-main', 4)));
  writeFileSync(s.sub, line({...call('copied-native', 99), timestamp:'2026-10-28T12:00:00Z'}) + line(call('own-native', 7)));
  const got = await s.reader.reportOf(['session-a'], 'UTC', {parentSessionIds:['parent']});
  expect(got?.report.calls).toBe(2);
  expect(got?.report.tokens.output).toBe(11);
  expect(got?.report.agents?.rows).toHaveLength(1);
});
