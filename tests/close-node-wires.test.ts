import test from "node:test";
import assert from "node:assert/strict";

import { removeConnectionsInvolving, useConnectionStore } from "../src/stores/connectionStore.ts";

// Wires used to outlive a closed node: emit_event tried to deliver along
// them and the record's topology kept listing them (seen 27 Sep: a wire to a
// browser closed a day earlier).
test("closing a node drops exactly the wires that touch it", () => {
  const store = useConnectionStore.getState();
  const manager = { kind: "terminal" as const, id: "mgr" };
  const worker = { kind: "terminal" as const, id: "w1" };
  const other = { kind: "terminal" as const, id: "w2" };
  const page = { kind: "browser" as const, id: "br" };
  store.addConnection(manager, worker, "spawn");
  store.addConnection(worker, page, "spawn");
  const kept = store.addConnection(manager, other, "spawn");

  removeConnectionsInvolving("terminal", "w1");

  assert.deepEqual(Object.keys(useConnectionStore.getState().connections), [kept]);
});
