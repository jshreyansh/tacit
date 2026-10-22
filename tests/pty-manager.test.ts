import test from "node:test";
import assert from "node:assert/strict";

test(
  "notifyThemeChanged sends SIGWINCH to the PTY child on unix platforms",
  { skip: process.platform === "win32" },
  async () => {
    const { PtyManager } = await import(
      `../electron/pty-manager.ts?sigwinch=${Date.now()}`,
    );
    const manager = new PtyManager() as PtyManager & {
      instances: Map<number, { pid?: number }>;
    };
    manager.instances.set(7, { pid: 4321 });

    const originalKill = process.kill;
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    (process as typeof process & {
      kill: (pid: number, signal: NodeJS.Signals) => boolean;
    }).kill = ((pid: number, signal: NodeJS.Signals) => {
      calls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    try {
      manager.notifyThemeChanged(7);
    } finally {
      process.kill = originalKill;
    }

    assert.deepEqual(calls, [{ pid: 4321, signal: "SIGWINCH" }]);
  },
);

test("notifyThemeChanged ignores unknown PTYs", async () => {
  const { PtyManager } = await import(
    `../electron/pty-manager.ts?unknown=${Date.now()}`,
  );
  const manager = new PtyManager();
  manager.notifyThemeChanged(999);
  assert.ok(true);
});

test(
  "create retries transient PTY spawn failures before surfacing an error",
  { skip: process.platform === "win32" },
  async () => {
    let attempts = 0;
    const { PtyManager } = await import(
      `../electron/pty-manager.ts?retry=${Date.now()}`,
    );
    const manager = new PtyManager({
      buildLaunchSpec: async () => ({
        cwd: process.cwd(),
        file: "/bin/sh",
        args: [],
        env: {},
      }),
      spawn: ((..._args: unknown[]) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("posix_spawnp failed.");
        }
        return { pid: 9876 };
      }) as typeof import("node-pty").spawn,
    });
    const id = await manager.create({
      cwd: process.cwd(),
    });

    assert.equal(id, 1);
    assert.equal(manager.getPid(id), 9876);
    assert.equal(attempts, 2);
  },
);

async function managerRecordingSpawns(tag: string) {
  const spawned: Array<{ cols?: number; rows?: number }> = [];
  const resized: Array<[number, number]> = [];
  const { PtyManager } = await import(`../electron/pty-manager.ts?${tag}=${Date.now()}`);
  const manager = new PtyManager({
    buildLaunchSpec: async () => ({ cwd: process.cwd(), file: "/bin/sh", args: [], env: {} }),
    spawn: ((_file: string, _args: string[], opts: { cols?: number; rows?: number }) => {
      spawned.push({ cols: opts.cols, rows: opts.rows });
      return { pid: 4242, resize: (c: number, r: number) => resized.push([c, r]) };
    }) as unknown as typeof import("node-pty").spawn,
  });
  return { manager, spawned, resized };
}

test("a terminal starts at the size the tile measured, so an agent's first screen fits it (SHR-95)", async () => {
  const { manager, spawned } = await managerRecordingSpawns("size");
  await manager.create({ cwd: process.cwd(), cols: 131, rows: 58 });
  assert.deepEqual(spawned, [{ cols: 131, rows: 58 }]);
});

test("without a measured size, or with one no terminal could have, it starts at 80×24", async () => {
  const { manager, spawned } = await managerRecordingSpawns("nosize");
  await manager.create({ cwd: process.cwd() });
  await manager.create({ cwd: process.cwd(), cols: 0, rows: 58 });
  await manager.create({ cwd: process.cwd(), cols: 131.5, rows: 58 });
  await manager.create({ cwd: process.cwd(), cols: 131, rows: 99999 });
  assert.deepEqual(spawned, Array(4).fill({ cols: 80, rows: 24 }));
});

test("a resize to a size no terminal could have is ignored", async () => {
  const { manager, resized } = await managerRecordingSpawns("resize");
  const id = await manager.create({ cwd: process.cwd() });
  manager.resize(id, 120, 40);
  manager.resize(id, Number.NaN, 40);
  manager.resize(id, 0, 0);
  assert.deepEqual(resized, [[120, 40]]);
});

async function realShellManager(script: string) {
  const { PtyManager } = await import(`../electron/pty-manager.ts?real=${Date.now()}-${Math.random()}`);
  const manager = new PtyManager({
    buildLaunchSpec: async () => ({ cwd: process.cwd(), file: "/bin/sh", args: ["-c", script], env: { PATH: "/usr/bin:/bin" } }),
  });
  return manager as InstanceType<typeof PtyManager>;
}

test(
  "a terminal counts as stopped only once node-pty has reported its exit, so quitting never lands on that report",
  { skip: process.platform === "win32" },
  async () => {
    const manager = await realShellManager("sleep 30");
    const id = await manager.create({ cwd: process.cwd() });
    const pid = manager.getPid(id)!;
    let reported = false;
    manager.onExit(id, () => {
      reported = true;
    });
    await manager.destroy(id);
    assert.equal(reported, true, "the exit was reported before destroy resolved");
    assert.throws(() => process.kill(pid, 0), "the process is gone");
  },
);

test(
  "a terminal that ignores the hang-up is killed, and still reported before it counts as stopped",
  { skip: process.platform === "win32", timeout: 15_000 },
  async () => {
    const manager = await realShellManager("trap '' HUP; echo ready; sleep 30");
    const id = await manager.create({ cwd: process.cwd() });
    // The trap has to be in place before the hang-up is sent.
    await new Promise<void>((resolve) => manager.onData(id, (data: string) => data.includes("ready") && resolve()));
    let reported = false;
    manager.onExit(id, () => {
      reported = true;
    });
    const started = Date.now();
    await manager.destroyAll();
    assert.equal(reported, true);
    assert.ok(Date.now() - started >= 4_900, "it waited for the hang-up first");
  },
);
