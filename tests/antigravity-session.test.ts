import test from "node:test";
import assert from "node:assert/strict";

import {
  conversationIdFromLog,
  findAntigravityConversation,
  type AntigravitySessionDeps,
} from "../electron/antigravity-session.ts";
import { antigravityLogPath } from "../shared/agent-adapters.ts";

const HOME = "/Users/me";
const CONVERSATIONS = `${HOME}/.gemini/antigravity-cli/conversations`;
const ID_A = "1939909e-0693-46c4-acd6-6fed30f695ce";
const ID_B = "2522080a-3456-4a41-8841-7511621f60d4";

// Lines as agy 1.2.12 writes them.
const LOG_WITH_A = [
  "I0927 11:55:10.636280       8 server.go:1584] Starting language server process with pid 33979",
  `I0927 11:55:14.462951     978 server.go:1239] Created conversation ${ID_A}`,
  `I0927 11:55:14.463068     978 server.go:3166] GetConversationDetail: found conversation ${ID_A} (active=true)`,
].join("\n");

function deps(files: Record<string, string>, overrides: Partial<AntigravitySessionDeps> = {}): AntigravitySessionDeps {
  return {
    homeDir: HOME,
    readFile: (file) => files[file] ?? null,
    exists: (file) => file.startsWith(CONVERSATIONS),
    ...overrides,
  };
}

test("each terminal's agy logs to a file of its own, named by the terminal", () => {
  assert.equal(
    antigravityLogPath(HOME, "1790489784638-1"),
    `${HOME}/.gemini/antigravity-cli/log/tacit-1790489784638-1.log`,
  );
  assert.equal(antigravityLogPath(HOME, "../x y"), `${HOME}/.gemini/antigravity-cli/log/tacit-___x_y.log`);
});

test("a log names its conversation; before the first message it names none", () => {
  assert.equal(conversationIdFromLog(LOG_WITH_A), ID_A);
  assert.equal(
    conversationIdFromLog("I0927 manager.go:932] Full redraw completed (rerenderAll) for conversation  (epoch 0, items 1)"),
    null,
  );
});

test("a log that moved to a newer conversation reports the newer one", () => {
  assert.equal(conversationIdFromLog(`${LOG_WITH_A}\nI0927 common.go:401] Resuming conversation ${ID_B}`), ID_B);
});

// Two terminals restored in the same second used to share agy's default log
// and were both handed the first one's conversation.
test("two terminals read two logs and get their own conversations", () => {
  const files = {
    [antigravityLogPath(HOME, "t-1")]: LOG_WITH_A,
    [antigravityLogPath(HOME, "t-2")]: `Created conversation ${ID_B}`,
  };
  assert.equal(findAntigravityConversation("t-1", deps(files))?.sessionId, ID_A);
  assert.equal(findAntigravityConversation("t-2", deps(files))?.sessionId, ID_B);
  assert.equal(findAntigravityConversation("t-3", deps(files)), null);
});

test("no conversation yet, or one agy never saved, is not a session to resume", () => {
  const log = antigravityLogPath(HOME, "t-1");
  assert.equal(findAntigravityConversation("t-1", deps({ [log]: "no conversation yet" })), null);
  assert.equal(findAntigravityConversation("t-1", deps({ [log]: LOG_WITH_A }, { exists: () => false })), null);
});
