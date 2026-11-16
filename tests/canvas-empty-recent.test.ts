import test from "node:test";
import assert from "node:assert/strict";

import { recentFolders } from "../src/components/canvasEmptyModel.ts";

const canvas = (id: string, createdAt: number, paths: string[]) => ({
  id,
  createdAt,
  scene: { projects: paths.map((path) => ({ path })) },
});

test("recent folders come from the other workdesks, newest workdesk first, without repeats", () => {
  const canvases = [canvas("a", 1, ["/x", "/y"]), canvas("b", 3, ["/z", "/x"]), canvas("here", 5, ["/w"])];
  assert.deepEqual(recentFolders(canvases, "here"), ["/z", "/x", "/y"]);
});

test("recent folders stop at the limit", () => {
  const canvases = [canvas("a", 1, ["/1", "/2", "/3", "/4", "/5"])];
  assert.deepEqual(recentFolders(canvases, "here", 2), ["/1", "/2"]);
});
