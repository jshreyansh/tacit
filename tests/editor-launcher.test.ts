import test from "node:test";
import assert from "node:assert/strict";

import {
  buildEditorCommand,
  detectEditors,
  isInsideFolder,
  openInEditor,
  runDetached,
  type DetectedEditor,
  type EditorCommand,
  type OpenDeps,
} from "../electron/editor-launcher.ts";

function detect(files: string[], pathDirs: string[] = []) {
  const present = new Set(files);
  return detectEditors({
    appDirs: ["/Applications", "/Users/me/Applications"],
    pathDirs,
    exists: (file) => present.has(file),
  });
}

const CODE_APP = "/Applications/Visual Studio Code.app";
const CODE_CLI = `${CODE_APP}/Contents/Resources/app/bin/code`;

test("finds an app in either Applications folder, and nothing that isn't there", () => {
  assert.deepEqual(detect([]), []);
  const found = detect([CODE_APP, "/Users/me/Applications/Cursor.app"]);
  assert.deepEqual(found.map((e) => e.id), ["vscode", "cursor"]);
  assert.equal(found[1].app, "/Users/me/Applications/Cursor.app");
});

test("prefers the command line inside the app over one on PATH", () => {
  const [editor] = detect([CODE_APP, CODE_CLI, "/opt/bin/code"], ["/opt/bin"]);
  assert.equal(editor.cli, CODE_CLI);
});

test("an app whose own command line is missing falls back to PATH", () => {
  const [editor] = detect([CODE_APP, "/opt/bin/code"], ["/opt/bin"]);
  assert.equal(editor.app, CODE_APP);
  assert.equal(editor.cli, "/opt/bin/code");
});

test("finds an editor installed only on PATH", () => {
  const found = detect(["/opt/bin/zed"], ["/usr/bin", "/opt/bin"]);
  assert.deepEqual(found.map((e) => [e.id, e.cli, e.app]), [["zed", "/opt/bin/zed", undefined]]);
});

test("finds a JetBrains IDE under any of its bundle names", () => {
  const [editor] = detect(["/Applications/PyCharm CE.app", "/Applications/PyCharm CE.app/Contents/MacOS/pycharm"]);
  assert.equal(editor.id, "pycharm");
  assert.equal(editor.cli, "/Applications/PyCharm CE.app/Contents/MacOS/pycharm");
});

const vscode: DetectedEditor = { id: "vscode", name: "VS Code", cli: "/bin/code", lineStyle: "goto" };
const zed: DetectedEditor = { id: "zed", name: "Zed", cli: "/bin/zed", lineStyle: "zed" };
const idea: DetectedEditor = { id: "idea", name: "IDEA", cli: "/bin/idea", lineStyle: "jetbrains" };
const appOnly: DetectedEditor = { id: "xcode", name: "Xcode", app: "/Applications/Xcode.app" };

test("builds each editor's command for a folder, a file and a file at a line", () => {
  const cases: Array<[DetectedEditor, string[], string[], string[]]> = [
    [vscode, ["/p"], ["/p/a.ts"], ["--goto", "/p/a.ts:12"]],
    [zed, ["/p"], ["/p/a.ts"], ["/p/a.ts:12"]],
    [idea, ["/p"], ["/p/a.ts"], ["--line", "12", "/p/a.ts"]],
  ];
  for (const [editor, folder, file, atLine] of cases) {
    assert.deepEqual(buildEditorCommand(editor, { path: "/p" })?.args, folder);
    assert.deepEqual(buildEditorCommand(editor, { path: "/p/a.ts" })?.args, file);
    assert.deepEqual(buildEditorCommand(editor, { path: "/p/a.ts", line: 12 })?.args, atLine);
    assert.equal(buildEditorCommand(editor, { path: "/p" })?.command, editor.cli);
  }
});

test("an app without a command line opens through `open -a`, without the line", () => {
  assert.deepEqual(buildEditorCommand(appOnly, { path: "/p/a.ts", line: 12 }), {
    command: "/usr/bin/open",
    args: ["-a", "/Applications/Xcode.app", "/p/a.ts"],
  });
});

test("a path with spaces or shell characters stays one argument", () => {
  const file = "/p/my file; rm -rf $(x).ts";
  assert.deepEqual(buildEditorCommand(vscode, { path: file, line: 3 })?.args, ["--goto", `${file}:3`]);
});

test("inside a folder means the folder or below it, not a similar name", () => {
  assert.equal(isInsideFolder("/p/app", "/p/app"), true);
  assert.equal(isInsideFolder("/p/app/src/a.ts", "/p/app"), true);
  assert.equal(isInsideFolder("/p/app/..config", "/p/app"), true);
  assert.equal(isInsideFolder("/p/app-other/a.ts", "/p/app"), false);
  assert.equal(isInsideFolder("/p", "/p/app"), false);
  assert.equal(isInsideFolder("/p/app/../../etc/passwd", "/p/app"), false);
});

function openSetup(overrides: Partial<OpenDeps> = {}) {
  const ran: EditorCommand[] = [];
  const deps: OpenDeps = {
    detect: () => [vscode],
    openFolders: () => ["/projects/app", "/worktrees/app-feature"],
    realpath: (file) => file,
    run: async (command) => {
      ran.push(command);
      return true;
    },
    ...overrides,
  };
  return { deps, ran };
}

test("opens a file inside a project, at its line", async () => {
  const { deps, ran } = openSetup();
  const result = await openInEditor("vscode", { path: "/projects/app/a.ts", line: 4 }, deps);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(ran, [{ command: "/bin/code", args: ["--goto", "/projects/app/a.ts:4"] }]);
});

test("opens a worktree outside the project's own folder", async () => {
  const { deps, ran } = openSetup();
  assert.deepEqual(await openInEditor("vscode", { path: "/worktrees/app-feature" }, deps), { ok: true });
  assert.equal(ran.length, 1);
});

test("refuses a path outside the open projects", async () => {
  const { deps, ran } = openSetup();
  assert.deepEqual(await openInEditor("vscode", { path: "/etc/passwd" }, deps), {
    ok: false,
    reason: "outside_projects",
  });
  assert.equal(ran.length, 0);
});

test("refuses a link inside a project that leads out of it", async () => {
  const { deps, ran } = openSetup({
    realpath: (file) => (file === "/projects/app/link" ? "/Users/me/.ssh/id_rsa" : file),
  });
  assert.deepEqual(await openInEditor("vscode", { path: "/projects/app/link" }, deps), {
    ok: false,
    reason: "outside_projects",
  });
  assert.equal(ran.length, 0);
});

test("refuses an editor that isn't on the found list", async () => {
  const { deps, ran } = openSetup();
  assert.deepEqual(await openInEditor("/bin/sh", { path: "/projects/app/a.ts" }, deps), {
    ok: false,
    reason: "unknown_editor",
  });
  assert.equal(ran.length, 0);
});

test("refuses malformed arguments before doing anything", async () => {
  const { deps, ran } = openSetup({
    detect: () => assert.fail("should not get as far as detecting"),
  });
  const bad: Array<[unknown, unknown]> = [
    [42, { path: "/projects/app/a.ts" }],
    ["vscode", null],
    ["vscode", "/projects/app/a.ts"],
    ["vscode", { path: "relative/a.ts" }],
    ["vscode", { path: "--inspect" }],
    ["vscode", { path: "/projects/app/a\0.ts" }],
    ["vscode", { path: "/projects/app/a.ts", line: 0 }],
    ["vscode", { path: "/projects/app/a.ts", line: 1.5 }],
    ["vscode", { path: "/projects/app/a.ts", line: "3" }],
  ];
  for (const [id, target] of bad) {
    assert.deepEqual(await openInEditor(id, target, deps), { ok: false, reason: "invalid" });
  }
  assert.equal(ran.length, 0);
});

test("says so when the file is gone or the editor fails to start", async () => {
  const gone = openSetup({
    realpath: (file) => {
      if (file.endsWith("gone.ts")) throw new Error("ENOENT");
      return file;
    },
  });
  assert.deepEqual(await openInEditor("vscode", { path: "/projects/app/gone.ts" }, gone.deps), {
    ok: false,
    reason: "not_found",
  });
  const failed = openSetup({ run: async () => false });
  assert.deepEqual(await openInEditor("vscode", { path: "/projects/app/a.ts" }, failed.deps), {
    ok: false,
    reason: "failed",
  });
});

test("a project folder that has gone doesn't stop the others counting", async () => {
  const { deps } = openSetup({
    openFolders: () => ["/projects/gone", "/projects/app"],
    realpath: (file) => {
      if (file === "/projects/gone") throw new Error("ENOENT");
      return file;
    },
  });
  assert.deepEqual(await openInEditor("vscode", { path: "/projects/app/a.ts" }, deps), { ok: true });
});

test("runDetached reports a command that fails or can't start, and one that keeps running", async () => {
  assert.equal(await runDetached({ command: "/usr/bin/true", args: [] }), true);
  assert.equal(await runDetached({ command: "/usr/bin/false", args: [] }), false);
  assert.equal(await runDetached({ command: "/no/such/editor", args: [] }), false);
  const started = Date.now();
  assert.equal(await runDetached({ command: "/bin/sleep", args: ["0.3"] }, process.env, 50), true);
  assert.ok(Date.now() - started < 280);
});
