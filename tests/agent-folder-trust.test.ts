import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  claudeWithTrust,
  codexTrustLevel,
  codexWithTrust,
  trustHydraFolder,
} from "../electron/agent-folder-trust";

// A Hydra workbench is a new folder; Claude and Codex each ask whether to
// trust a new folder. Tacit trusts it for them only when the folder is inside
// the repo and the agent already trusts that repo (decided 29 Oct).

const repo = "/work/app";
const folder = "/work/app/.worktrees/workbench-1";

test("Claude: the folder gets the repo's settings and trust, not its history", () => {
  const config = {
    numStartups: 3,
    projects: {
      [repo]: {
        hasTrustDialogAccepted: true,
        allowedTools: ["Bash(npm test)"],
        mcpServers: { db: { command: "db-mcp" } },
        lastCost: 12,
        lastSessionId: "s-1",
      },
    },
  };
  const next = claudeWithTrust(config, repo, folder)!;
  assert.deepEqual(next.projects![folder], {
    allowedTools: ["Bash(npm test)"],
    mcpContextUris: [],
    mcpServers: { db: { command: "db-mcp" } },
    hasTrustDialogAccepted: true,
  });
  assert.equal(next.numStartups, 3, "the rest of the file is kept");
  assert.deepEqual(next.projects![repo], config.projects[repo], "the repo's entry is untouched");
  assert.notEqual(next.projects![folder].allowedTools, config.projects[repo].allowedTools, "copied, not shared");
});

test("Claude: an entry the folder already has is kept, and an explicit no stays no", () => {
  const already = { projects: { [repo]: { hasTrustDialogAccepted: true }, [folder]: { hasTrustDialogAccepted: true } } };
  assert.equal(claudeWithTrust(already, repo, folder), null);
  const refused = { projects: { [repo]: { hasTrustDialogAccepted: true }, [folder]: { hasTrustDialogAccepted: false } } };
  assert.equal(claudeWithTrust(refused, repo, folder), null);
  const partial = { projects: { [repo]: { hasTrustDialogAccepted: true }, [folder]: { allowedTools: ["Read"] } } };
  assert.deepEqual(claudeWithTrust(partial, repo, folder)!.projects![folder], {
    allowedTools: ["Read"],
    mcpContextUris: [],
    mcpServers: {},
    hasTrustDialogAccepted: true,
  });
});

test("Codex: a table is added for the folder; one already there is left alone", () => {
  const toml = `model = "gpt-5.4"\n\n[projects."${repo}"]\ntrust_level = "trusted"\n`;
  assert.equal(codexTrustLevel(toml, repo), "trusted");
  assert.equal(codexTrustLevel(toml, folder), undefined);
  const next = codexWithTrust(toml, folder)!;
  assert.equal(next, `${toml}\n[projects."${folder}"]\ntrust_level = "trusted"\n`);
  assert.equal(codexTrustLevel(next, folder), "trusted");
  assert.equal(codexWithTrust(next, folder), null);
  const untrusted = `${toml}\n[projects."${folder}"]\ntrust_level = "untrusted"\n`;
  assert.equal(codexWithTrust(untrusted, folder), null, "the user's no stays");
  // Quotes and backslashes in a path are escaped as TOML needs.
  const odd = '/work/a "b"\\c';
  assert.match(codexWithTrust("", `${odd}/w`)!, /^\[projects\."\/work\/a \\"b\\"\\\\c\/w"\]\n/);
});

function home(t: test.TestContext, files: { claude?: unknown; codex?: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folder-trust-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (files.claude !== undefined) {
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(files.claude, null, 2), { mode: 0o600 });
  }
  if (files.codex !== undefined) {
    fs.mkdirSync(path.join(dir, ".codex"));
    fs.writeFileSync(path.join(dir, ".codex", "config.toml"), files.codex, { mode: 0o600 });
  }
  return dir;
}

test("a Hydra folder is trusted on disk when the agent trusts its repo, written whole", (t) => {
  const h = home(t, {
    claude: { projects: { [repo]: { hasTrustDialogAccepted: true } } },
    codex: `[projects."${repo}"]\ntrust_level = "trusted"\n`,
  });
  assert.deepEqual(trustHydraFolder({ agent: "claude", repo, folder, home: h }), { status: "trusted" });
  assert.deepEqual(trustHydraFolder({ agent: "codex", repo, folder, home: h }), { status: "trusted" });
  const claude = fs.readFileSync(path.join(h, ".claude.json"), "utf8");
  assert.equal(JSON.parse(claude).projects[folder].hasTrustDialogAccepted, true);
  assert.equal(claude.endsWith("}"), true, "written as Claude writes it, no newline at the end");
  assert.equal(fs.statSync(path.join(h, ".claude.json")).mode & 0o777, 0o600, "its permissions are kept");
  assert.equal(codexTrustLevel(fs.readFileSync(path.join(h, ".codex", "config.toml"), "utf8"), folder), "trusted");
  assert.deepEqual(fs.readdirSync(h).filter((f) => f.includes("tmp")), [], "no temporary file left");
  // Twice is once.
  assert.deepEqual(trustHydraFolder({ agent: "claude", repo, folder, home: h }), { status: "already" });
  assert.deepEqual(trustHydraFolder({ agent: "codex", repo, folder, home: h }), { status: "already" });
});

test("nothing is written when the repo isn't trusted, or the folder isn't inside it", (t) => {
  const claude = { projects: { "/work": { hasTrustDialogAccepted: true } } };
  const codex = `[projects."/work"]\ntrust_level = "trusted"\n`;
  const h = home(t, { claude, codex });
  // A trusted parent of the repo isn't the repo.
  assert.deepEqual(trustHydraFolder({ agent: "claude", repo, folder, home: h }), { status: "repo_not_trusted" });
  assert.deepEqual(trustHydraFolder({ agent: "codex", repo, folder, home: h }), { status: "repo_not_trusted" });
  assert.deepEqual(trustHydraFolder({ agent: "claude", repo: "/work", folder: "/elsewhere/wb", home: h }), { status: "not_inside_repo" });
  assert.deepEqual(trustHydraFolder({ agent: "claude", repo: "/work", folder: "/work", home: h }), { status: "not_inside_repo" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h, ".claude.json"), "utf8")), claude);
  assert.equal(fs.readFileSync(path.join(h, ".codex", "config.toml"), "utf8"), codex);
});

test("an agent with no config file yet is reported, not created", (t) => {
  const h = home(t, {});
  const outcome = trustHydraFolder({ agent: "claude", repo, folder, home: h });
  assert.equal(outcome.status, "failed");
  assert.equal(fs.existsSync(path.join(h, ".claude.json")), false);
});
