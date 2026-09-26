import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bashRcFile,
  integratedShellKind,
  shellIntegrationLaunch,
  writeShellIntegrationFiles,
  zshStartupFiles,
} from "../electron/shell-integration.ts";
import { buildLaunchSpec, type LaunchResolverDeps } from "../electron/pty-launch.ts";

test("zsh, bash and fish are recognised by name, other shells are not", () => {
  assert.equal(integratedShellKind("/bin/zsh"), "zsh");
  assert.equal(integratedShellKind("/opt/homebrew/bin/bash"), "bash");
  assert.equal(integratedShellKind("/usr/local/bin/fish"), "fish");
  assert.equal(integratedShellKind("-zsh"), "zsh");
  assert.equal(integratedShellKind("/bin/sh"), null);
  assert.equal(integratedShellKind("/usr/bin/nu"), null);
});

test("each zsh file sources the person's file of the same name", () => {
  const files = zshStartupFiles();
  for (const name of [".zshenv", ".zprofile", ".zshrc"] as const) {
    assert.match(files[name], new RegExp(`source "\\$ZDOTDIR/\\${name}"`));
  }
});

test("the zsh .zshrc moves HISTFILE back out of Tacit's folder", () => {
  const rc = zshStartupFiles()[".zshrc"];
  assert.match(rc, /if \[\[ "\$HISTFILE" == "\$ZDOTDIR\/\.zsh_history" \]\]/);
  // The guard must run before the person's .zshrc, which may set its own.
  assert.ok(rc.indexOf("HISTFILE=") < rc.indexOf('source "$ZDOTDIR/.zshrc"'));
});

test("zsh launch points ZDOTDIR at the integration folder and remembers the person's", () => {
  const launch = shellIntegrationLaunch({
    shell: "/bin/zsh",
    integrationDir: "/data/shell-integration",
    pathFirst: ["/app/shims", "/app/cli"],
    env: { HOME: "/Users/me" },
  });
  assert.deepEqual(launch, {
    args: ["-l"],
    env: {
      TACIT_PATH_FIRST: "/app/shims:/app/cli",
      TACIT_USER_ZDOTDIR: "/Users/me",
      ZDOTDIR: "/data/shell-integration/zsh",
    },
  });
});

test("an inherited ZDOTDIR is kept as the person's own", () => {
  const launch = shellIntegrationLaunch({
    shell: "/bin/zsh",
    integrationDir: "/data/shell-integration",
    pathFirst: ["/app/shims"],
    env: { HOME: "/Users/me", ZDOTDIR: "/Users/me/.config/zsh" },
  });
  assert.equal(launch?.env.TACIT_USER_ZDOTDIR, "/Users/me/.config/zsh");
});

test("an inherited ZDOTDIR that is Tacit's own folder is never used, so files cannot source themselves", () => {
  const launch = shellIntegrationLaunch({
    shell: "/bin/zsh",
    integrationDir: "/data/shell-integration",
    pathFirst: ["/app/shims"],
    env: { HOME: "/Users/me", ZDOTDIR: "/data/shell-integration/zsh" },
  });
  assert.equal(launch?.env.TACIT_USER_ZDOTDIR, "/Users/me");
});

test("bash launches interactive with Tacit's rc file", () => {
  const launch = shellIntegrationLaunch({
    shell: "/bin/bash",
    integrationDir: "/data/shell-integration",
    pathFirst: ["/app/shims"],
    env: { HOME: "/Users/me" },
  });
  assert.deepEqual(launch?.args, ["--rcfile", "/data/shell-integration/bash/rc.bash", "-i"]);
  assert.match(bashRcFile(), /\$HOME\/\.bash_profile" "\$HOME\/\.bash_login" "\$HOME\/\.profile"/);
});

test("fish keeps its login flag and adds an init command", () => {
  const launch = shellIntegrationLaunch({
    shell: "/usr/local/bin/fish",
    integrationDir: "/data/shell-integration",
    pathFirst: ["/app/shims"],
    env: { HOME: "/Users/me" },
  });
  assert.equal(launch?.args[0], "-l");
  assert.equal(launch?.args[1], "--init-command");
  assert.match(launch?.args[2] ?? "", /--on-event fish_prompt/);
});

test("the files are written whole, and a rewrite replaces them", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tacit-shell-")), "shell-integration");
  writeShellIntegrationFiles(dir);
  fs.writeFileSync(path.join(dir, "zsh", ".zshrc"), "stale");
  writeShellIntegrationFiles(dir);
  assert.equal(fs.readFileSync(path.join(dir, "zsh", ".zshrc"), "utf8"), zshStartupFiles()[".zshrc"]);
  assert.ok(fs.existsSync(path.join(dir, "bash", "rc.bash")));
  assert.deepEqual(
    fs.readdirSync(path.dirname(dir)).filter((name) => name.includes(".tmp-")),
    [],
  );
});

// ── Real shells ─────────────────────────────────────────────────────────
// The bug only exists in how a real shell runs its startup files, so the
// proof has to run one: a home whose .zprofile / .bash_profile puts a fake
// `claude` ahead of the shim, exactly as ~/.local/bin does on a real Mac.

function fakeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tacit-shell-real-"));
  const home = path.join(root, "home");
  const shims = path.join(root, "shims");
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.mkdirSync(shims);
  fs.writeFileSync(path.join(home, ".local", "bin", "claude"), "#!/bin/sh\necho real\n", { mode: 0o755 });
  fs.writeFileSync(path.join(shims, "claude"), "#!/bin/sh\necho shim\n", { mode: 0o755 });
  const prepend = 'export PATH="$HOME/.local/bin:$PATH"\n';
  fs.writeFileSync(path.join(home, ".zprofile"), prepend);
  fs.writeFileSync(path.join(home, ".zshrc"), "MY_ZSHRC=loaded\n");
  fs.writeFileSync(path.join(home, ".bash_profile"), prepend);
  const integrationDir = path.join(root, "integration");
  writeShellIntegrationFiles(integrationDir);
  const env = { HOME: home, PATH: `${shims}:/usr/bin:/bin`, TERM: "xterm" };
  return { home, shims, integrationDir, env };
}

function runShell(shell: string, args: string[], env: Record<string, string>, command: string): string {
  const out = execFileSync(shell, [...args, "-c", command], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.trim().split("\n").pop() ?? "";
}

test("zsh: without integration the person's startup files hide the shim (the bug)", { skip: !fs.existsSync("/bin/zsh") }, () => {
  const { env } = fakeHome();
  assert.equal(runShell("/bin/zsh", ["-l", "-i"], env, "claude"), "real");
});

test("zsh: with integration the shim wins, their .zshrc still runs, history stays home", { skip: !fs.existsSync("/bin/zsh") }, () => {
  const { home, shims, integrationDir, env } = fakeHome();
  const launch = shellIntegrationLaunch({ shell: "/bin/zsh", integrationDir, pathFirst: [shims], env })!;
  const out = runShell("/bin/zsh", [...launch.args, "-i"], { ...env, ...launch.env },
    'print -r -- "$(claude)|$MY_ZSHRC|$HISTFILE|$ZDOTDIR"');
  assert.equal(out, `shim|loaded|${home}/.zsh_history|${home}`);
});

test("bash: without integration the shim is hidden; with it, the shim wins", { skip: !fs.existsSync("/bin/bash") }, () => {
  const { shims, integrationDir, env } = fakeHome();
  assert.equal(runShell("/bin/bash", ["-l", "-i"], env, "claude"), "real");
  const launch = shellIntegrationLaunch({ shell: "/bin/bash", integrationDir, pathFirst: [shims], env })!;
  assert.equal(runShell("/bin/bash", launch.args, { ...env, ...launch.env }, "claude"), "shim");
});

// ── Wired into buildLaunchSpec ──────────────────────────────────────────

function deps(overrides: Partial<LaunchResolverDeps> = {}): LaunchResolverDeps {
  return {
    platform: "darwin",
    pathDelimiter: ":",
    pathSeparator: "/",
    existsSync: (file) => ["/bin/zsh", "/repo", "/data/shell-integration"].includes(file),
    isExecutable: (file) => file === "/bin/zsh",
    readFileSync: () => "",
    homeDir: () => "/Users/me",
    getShellEnv: async () => ({ PATH: "/usr/bin:/bin", HOME: "/Users/me", SHELL: "/bin/zsh" }),
    ...overrides,
  };
}

test("a shell terminal keeps the prepended folders' order through the integration", async () => {
  const launch = await buildLaunchSpec(
    { cwd: "/repo", extraPathEntries: ["/app/cli", "/app/cli/agent-shims"], shellIntegrationDir: "/data/shell-integration" },
    deps(),
  );
  assert.equal(launch.file, "/bin/zsh");
  assert.deepEqual(launch.args, ["-l"]);
  assert.equal(launch.env.ZDOTDIR, "/data/shell-integration/zsh");
  // Same order as PATH itself: the shims were unshifted last, so they lead.
  assert.equal(launch.env.TACIT_PATH_FIRST, "/app/cli/agent-shims:/app/cli");
  assert.deepEqual(launch.env.PATH.split(":").slice(0, 2), ["/app/cli/agent-shims", "/app/cli"]);
});

test("a missing integration folder falls back to the plain login shell", async () => {
  const launch = await buildLaunchSpec(
    { cwd: "/repo", extraPathEntries: ["/app/cli"], shellIntegrationDir: "/data/missing" },
    deps(),
  );
  assert.deepEqual(launch.args, ["-l"]);
  assert.equal(launch.env.ZDOTDIR, undefined);
});

test("agent terminals, which launch a CLI directly, are untouched", async () => {
  const launch = await buildLaunchSpec(
    { cwd: "/repo", shell: "/bin/zsh", args: ["-c", "true"], extraPathEntries: ["/app/cli"], shellIntegrationDir: "/data/shell-integration" },
    deps(),
  );
  assert.deepEqual(launch.args, ["-c", "true"]);
  assert.equal(launch.env.ZDOTDIR, undefined);
});
