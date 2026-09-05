import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { WorkspaceSavePathRegistry } from "../electron/workspace-save-path.ts";

test("workspace save path registry only allows user-selected paths", () => {
  const registry = new WorkspaceSavePathRegistry((filePath) =>
    path.resolve("/workspace", filePath),
  );

  const selected = registry.register("selected.tacit");
  assert.equal(selected, path.resolve("/workspace/selected.tacit"));
  assert.equal(
    registry.assertAllowed("./selected.tacit"),
    path.resolve("/workspace/selected.tacit"),
  );

  assert.throws(
    () => registry.assertAllowed("other.tacit"),
    /not selected by the user/,
  );
  assert.throws(() => registry.assertAllowed(""), /path is required/);
});

