import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChromeLoginWatch } from "../electron/chrome-login-watch.ts";
import { OpenCodeActivity } from "../electron/opencode-activity.ts";
import { SessionWatcher, toClaudeProjectKey } from "../electron/session-watcher.ts";
import { TelemetryService } from "../electron/telemetry-service.ts";

// When macOS can't watch any more folders, every folder watch in the process
// emits 'error' (EMFILE). A watch with no 'error' listener turns that into an
// uncaught exception in the main process: a crash dialog per watch. These
// stand in for fs.watch with watchers that, like the real ones, throw on an
// 'error' nobody listens to.
class FakeWatcher extends EventEmitter {
  closed = false;
  constructor(
    readonly target: string,
    readonly listener: ((event: string, filename: string | null) => void) | undefined,
  ) {
    super();
  }
  close() {
    this.closed = true;
  }
}

function fakeWatches(t: test.TestContext, failWith?: NodeJS.ErrnoException) {
  const made: FakeWatcher[] = [];
  t.mock.method(fs, "watch", (target: fs.PathLike, a?: unknown, b?: unknown) => {
    if (failWith) throw failWith;
    const listener = (typeof a === "function" ? a : b) as FakeWatcher["listener"];
    const watcher = new FakeWatcher(String(target), listener);
    made.push(watcher);
    return watcher;
  });
  return made;
}

const emfile = () => Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(t: test.TestContext, prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function quietWarnings(t: test.TestContext): string[] {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.map(String).join(" ")));
  return warnings;
}

// --- Session watcher ---------------------------------------------------------

const claudeLine = (stop: "end_turn" | "tool_use") =>
  `${JSON.stringify({ type: "assistant", message: { stop_reason: stop, content: [{ type: "text", text: "x" }] } })}\n`;

function claudeSession(t: test.TestContext) {
  const home = tempDir(t, "tacit-watch-failures-home-");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  const cwd = "/work/project";
  const file = path.join(home, ".claude", "projects", toClaudeProjectKey(cwd), "s1.jsonl");
  return { cwd, file };
}

test("a session whose watch fails later is checked now, then polled", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const made = fakeWatches(t);
  const warnings = quietWarnings(t);
  const { cwd, file } = claudeSession(t);
  const watcher = new SessionWatcher();
  t.after(() => watcher.unwatchAll());
  let turnsEnded = 0;
  assert.equal(watcher.watch("s1", "claude", cwd, () => turnsEnded++).ok, true);
  assert.equal(made.length, 1);

  fs.writeFileSync(file, claudeLine("end_turn"));
  made[0].emit("error", emfile());
  assert.ok(made[0].closed, "the failed watch wasn't closed");
  assert.match(warnings.join("\n"), /polling every 30s instead/);
  assert.equal(turnsEnded, 1, "the turn that ended while the watch was failing wasn't noticed");

  // Polling starts now, not a minute later. A new turn starts (Claude's check
  // reads the last few lines, so the file is rewritten), then ends.
  fs.writeFileSync(file, `${JSON.stringify({ type: "user", message: { content: "next" } })}\n`);
  t.mock.timers.tick(30_000);
  fs.appendFileSync(file, claudeLine("end_turn"));
  t.mock.timers.tick(30_000);
  assert.equal(turnsEnded, 2, "the next turn's end wasn't picked up by polling");
});

test("a session whose watch can't start is polled from the start", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  fakeWatches(t, emfile());
  const warnings = quietWarnings(t);
  const { cwd, file } = claudeSession(t);
  const watcher = new SessionWatcher();
  t.after(() => watcher.unwatchAll());
  let turnsEnded = 0;
  assert.equal(watcher.watch("s1", "claude", cwd, () => turnsEnded++).ok, true);
  assert.match(warnings.join("\n"), /can't watch/);

  fs.writeFileSync(file, claudeLine("end_turn"));
  t.mock.timers.tick(30_000);
  assert.equal(turnsEnded, 1);
});

// --- Telemetry ---------------------------------------------------------------

test("telemetry keeps reading a session on its poll after the folder watch fails", async (t) => {
  const made = fakeWatches(t);
  const warnings = quietWarnings(t);
  const dir = tempDir(t, "tacit-watch-failures-telemetry-");
  const sessionFile = path.join(dir, "session.jsonl");
  fs.writeFileSync(sessionFile, "");
  const service = new TelemetryService({ processPollIntervalMs: 0, sessionPollIntervalMs: 20 });
  t.after(() => service.dispose());
  service.registerTerminal({ terminalId: "t1", worktreePath: dir, provider: "claude" });
  service.attachSessionSource({ terminalId: "t1", provider: "claude", confidence: "high", sessionId: "s1", sessionFile });

  const folderWatch = made.find((watcher) => watcher.target === dir);
  assert.ok(folderWatch, "the session's folder wasn't watched");
  folderWatch.emit("error", emfile());
  assert.ok(folderWatch.closed);
  assert.match(warnings.join("\n"), /reading the session on the poll instead/);

  fs.appendFileSync(sessionFile, claudeLine("tool_use"));
  await sleep(200);
  assert.equal(service.getTerminalSnapshot("t1")?.turn_state, "tool_pending", "the poll stopped reading the session");
});

test("telemetry's OpenCode -wal watch that fails is set up again when the file reappears", (t) => {
  const made = fakeWatches(t);
  quietWarnings(t);
  const dir = tempDir(t, "tacit-watch-failures-telemetry-");
  const sessionFile = path.join(dir, "opencode.db");
  fs.writeFileSync(sessionFile, "");
  const service = new TelemetryService({ processPollIntervalMs: 0, sessionPollIntervalMs: 60_000 });
  t.after(() => service.dispose());
  service.registerTerminal({ terminalId: "t1", worktreePath: dir, provider: "opencode" });
  service.attachSessionSource({ terminalId: "t1", provider: "opencode", confidence: "high", sessionId: "s1", sessionFile });

  const walWatches = () => made.filter((watcher) => watcher.target === `${sessionFile}-wal`);
  const folderWatch = made.find((watcher) => watcher.target === dir);
  assert.equal(walWatches().length, 1);
  assert.ok(folderWatch);
  walWatches()[0].emit("error", emfile());
  assert.ok(walWatches()[0].closed);

  folderWatch.listener?.("rename", "opencode.db-wal");
  assert.equal(walWatches().length, 2, "the -wal file wasn't watched again");
  assert.equal(walWatches()[1].closed, false);
});

// --- OpenCode activity -------------------------------------------------------

test("an OpenCode wait whose watches fail ends on its timer, and the next wait watches again", async (t) => {
  const made = fakeWatches(t);
  const warnings = quietWarnings(t);
  const dir = tempDir(t, "tacit-watch-failures-opencode-");
  const activity = new OpenCodeActivity(path.join(dir, "opencode.db"), 100);
  t.after(() => activity.dispose());

  const first = activity.next();
  assert.equal(made.length, 2, "the folder and the -wal file weren't both watched");
  for (const watcher of made) watcher.emit("error", emfile());
  assert.ok(made.every((watcher) => watcher.closed));
  assert.match(warnings.join("\n"), /waits end on their timer/);
  await first; // ends on its 100 ms timer

  const second = activity.next();
  assert.equal(made.length, 4, "the next wait didn't watch again");
  let woke = false;
  void second.then(() => (woke = true));
  made[3].listener?.("change", null); // OpenCode writes to its -wal file
  await sleep(50);
  assert.equal(woke, false, "a wake is coalesced");
  await sleep(400);
  assert.equal(woke, true, "a write didn't end the wait");
});

// --- Chrome login watch ------------------------------------------------------

test("Chrome's login watch that fails still finds new logins on the next sync", async (t) => {
  const made = fakeWatches(t);
  const root = tempDir(t, "tacit-watch-failures-chrome-");
  fs.mkdirSync(path.join(root, "Default"));
  fs.writeFileSync(path.join(root, "Default", "Cookies"), "");
  let rows = ".google.com|SID|100";
  const logs: string[] = [];
  const logins: string[] = [];
  const watch = new ChromeLoginWatch({
    chromeRoot: root,
    readLoginRows: async () => rows,
    onNewLogin: (source) => logins.push(source),
    log: (message) => logs.push(message),
  });
  t.after(() => watch.close());
  watch.setSources([{ identityId: "identity-a", sourceProfileId: "Default" }]);
  await watch.check("Default");
  assert.equal(made.length, 1);

  made[0].emit("error", emfile());
  assert.ok(made[0].closed);
  assert.match(logs.join("\n"), /watching Default failed \(EMFILE.*new logins are found on the next sync instead/);

  rows = ".google.com|SID|200";
  await watch.check("Default");
  assert.deepEqual(logins, ["Default"]);
});
