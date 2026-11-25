import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { StatePersistence } from "../electron/state-persistence.ts";
import {
  getTacitDataDir,
  resolveTacitPortFile,
} from "../shared/tacit-instance.ts";

test("save writes atomically via tmp+rename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-state-"));
  const file = path.join(dir, "state.json");

  const data = { version: 1, projects: [] };
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);

  const loaded = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.deepEqual(loaded, data);
  assert.equal(fs.existsSync(tmp), false, "tmp file should be cleaned up by rename");

  fs.rmSync(dir, { recursive: true });
});

test("save with skipRestore flag", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-state-"));
  const file = path.join(dir, "state.json");

  const data = { version: 1, projects: [], skipRestore: true };
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);

  const loaded = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(loaded.skipRestore, true);

  fs.rmSync(dir, { recursive: true });
});

test("getTacitDataDir separates prod and dev state directories", () => {
  assert.equal(
    getTacitDataDir("prod"),
    path.join(os.homedir(), ".tacit"),
  );
  assert.equal(
    getTacitDataDir("dev"),
    path.join(os.homedir(), ".tacit-dev"),
  );
});

test("resolveTacitPortFile defaults to the prod instance port file", () => {
  assert.equal(
    resolveTacitPortFile({}),
    path.join(os.homedir(), ".tacit", "port"),
  );
});

test("resolveTacitPortFile respects TACIT_INSTANCE and TACIT_PORT_FILE", () => {
  assert.equal(
    resolveTacitPortFile({ TACIT_INSTANCE: "dev" }),
    path.join(os.homedir(), ".tacit-dev", "port"),
  );
  assert.equal(
    resolveTacitPortFile({
      TACIT_INSTANCE: "prod",
      TACIT_PORT_FILE: "/tmp/custom-port-file",
    }),
    "/tmp/custom-port-file",
  );
});

const STATE = { version: 3, workspace: { canvases: [{ id: "a", scene: { projects: [{ path: "/p", worktrees: [] }] } }] } };
function saved(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-state-"));
  fs.writeFileSync(path.join(dir, "state.json"), body);
  return { dir, read: () => fs.readFileSync(path.join(dir, "state.json"), "utf-8"), kept: () => fs.readdirSync(dir).filter((f) => f.startsWith("state.") && f !== "state.json"), state: new StatePersistence(dir) };
}

test("nothing is saved over workdesks the window hasn't opened", () => {
  const body = JSON.stringify(STATE);
  const x = saved(body);
  assert.throws(() => x.state.save({ version: 3 }), /haven't been opened/, "before it's asked for");
  x.state.open();
  assert.throws(() => x.state.save({ version: 3 }), /haven't been opened/, "while it's opening, or failed to");
  assert.equal(x.read(), body);
  x.state.opened();
  x.state.save({ ...STATE, version: 4 });
  assert.match(x.read(), /"version": 4/);
  // The window reloads: held again until it has opened it again.
  x.state.open();
  assert.throws(() => x.state.save({}), /haven't been opened/);
  fs.rmSync(x.dir, { recursive: true });
});

test("a file that can't be read isn't taken for nothing saved", () => {
  const x = saved("{ not json");
  assert.throws(() => x.state.open());
  assert.throws(() => x.state.save({ version: 3 }), /haven't been opened/);
  assert.equal(x.read(), "{ not json");
  x.state.replace();
  x.state.save({ version: 3 });
  assert.equal(x.kept().length, 1);
  assert.equal(fs.readFileSync(path.join(x.dir, x.kept()[0]), "utf-8"), "{ not json", "kept beside it");
  fs.rmSync(x.dir, { recursive: true });
});

test("the first run saves, and going from folders to none keeps what was there", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-state-"));
  const state = new StatePersistence(dir);
  assert.equal(state.open(), null);
  state.opened();
  state.save(STATE);
  state.save({ version: 3, workspace: { canvases: [] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "state.before-empty.json"), "utf-8")), STATE);
  state.save({ version: 3, workspace: { canvases: [] }, n: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "state.before-empty.json"), "utf-8")), STATE, "and isn't itself lost to the next save");
  fs.rmSync(dir, { recursive: true });
});
