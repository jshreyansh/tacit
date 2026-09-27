import test from "node:test";
import assert from "node:assert/strict";

import {
  conversationIdFromLog,
  findAntigravityConversation,
  openFilesFromLsof,
  type AntigravitySessionDeps,
} from "../electron/antigravity-session.ts";

const HOME = "/Users/me";
const LOG_DIR = `${HOME}/.gemini/antigravity-cli/log`;
const CONVERSATIONS = `${HOME}/.gemini/antigravity-cli/conversations`;
const ID_A = "1939909e-0693-46c4-acd6-6fed30f695ce";
const ID_B = "2522080a-3456-4a41-8841-7511621f60d4";

// Lines as agy 1.2.12 writes them.
const LOG_WITH_A = [
  "I0927 11:55:10.636280       8 server.go:1584] Starting language server process with pid 33979",
  `I0927 11:55:14.462951     978 server.go:1239] Created conversation ${ID_A}`,
  `I0927 11:55:14.463068     978 server.go:3166] GetConversationDetail: found conversation ${ID_A} (active=true)`,
].join("\n");

function deps(overrides: Partial<AntigravitySessionDeps> & { files?: Record<string, string> }): AntigravitySessionDeps {
  const files = overrides.files ?? {};
  return {
    homeDir: HOME,
    listOpenFiles: () => Object.keys(files),
    readFile: (file) => files[file] ?? null,
    exists: (file) => file.startsWith(CONVERSATIONS),
    ...overrides,
  };
}

test("a log names its conversation; before the first message it names none", () => {
  assert.equal(conversationIdFromLog(LOG_WITH_A), ID_A);
  assert.equal(
    conversationIdFromLog("I0927 manager.go:932] Full redraw completed (rerenderAll) for conversation  (epoch 0, items 1)"),
    null,
  );
});

test("a log that moved to a newer conversation reports the newer one", () => {
  assert.equal(conversationIdFromLog(`${LOG_WITH_A}\nI0927 server.go:1239] Created conversation ${ID_B}`), ID_B);
});

test("lsof -Fn output lists the process's open files", () => {
  assert.deepEqual(openFilesFromLsof("p123\nf1\nn/a/b.log\nf2\nn/c d.txt\n"), ["/a/b.log", "/c d.txt"]);
});

test("the conversation comes from the log this process holds open, not any other", () => {
  const found = findAntigravityConversation(
    42,
    deps({
      files: {
        [`${LOG_DIR}/cli-20260927_115510.log`]: LOG_WITH_A,
        "/Users/me/.gemini/antigravity-cli/settings.json": `conversation ${ID_B}`,
      },
    }),
  );
  assert.deepEqual(found, { sessionId: ID_A, confidence: "strong" });
});

test("no conversation yet, or one agy never saved, is not a session to resume", () => {
  assert.equal(findAntigravityConversation(42, deps({ files: { [`${LOG_DIR}/x.log`]: "no conversation yet" } })), null);
  assert.equal(
    findAntigravityConversation(42, deps({ files: { [`${LOG_DIR}/x.log`]: LOG_WITH_A }, exists: () => false })),
    null,
  );
});

test("a process that is gone has nothing to find", () => {
  assert.equal(findAntigravityConversation(42, deps({ listOpenFiles: () => [] })), null);
});
