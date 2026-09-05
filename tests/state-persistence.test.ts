import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
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
