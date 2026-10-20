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
