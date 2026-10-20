import test from "node:test";
import assert from "node:assert/strict";
import { createPtyResizer, PTY_RESIZE_SETTLE_MS } from "../src/terminal/ptyResizer";
import type { PtySize } from "../shared/pty-size";

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id: unknown) => {
        pending.delete(id as number);
      },
    },
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        pending.delete(due[0]);
        due[1].fn();
      }
      now = until;
    },
  };
}

const size = (cols: number, rows: number): PtySize => ({ cols, rows });

test("a drag tells the process its size twice: as it starts, and the final size once it settles (SHR-96)", () => {
  const clock = fakeClock();
  const sent: PtySize[] = [];
  const resizer = createPtyResizer((s) => sent.push(s), { initial: size(120, 40), timers: clock.timers });

  // One change a frame for about a second, rows climbing then falling.
  let rows = 40;
  for (let frame = 0; frame < 60; frame++) {
    rows += frame < 30 ? 1 : -1;
    resizer.request(size(120, rows));
    clock.advance(16);
  }
  assert.deepEqual(sent, [size(120, 41)]);
  clock.advance(PTY_RESIZE_SETTLE_MS);
  assert.deepEqual(sent, [size(120, 41), size(120, 40)]);
  assert.deepEqual(resizer.current, size(120, 40));
});

test("a single change, like a maximise, goes to the process at once", () => {
  const clock = fakeClock();
  const sent: PtySize[] = [];
  const resizer = createPtyResizer((s) => sent.push(s), { initial: size(80, 24), timers: clock.timers });
  resizer.request(size(200, 60));
  assert.deepEqual(sent, [size(200, 60)]);
  clock.advance(PTY_RESIZE_SETTLE_MS * 2);
  assert.deepEqual(sent, [size(200, 60)]);

  // After a quiet spell, the next change goes at once too.
  resizer.request(size(100, 30));
  assert.deepEqual(sent, [size(200, 60), size(100, 30)]);
});

test("asking for the size the process already has sends nothing, including the size it started at", () => {
  const clock = fakeClock();
  const sent: PtySize[] = [];
  const resizer = createPtyResizer((s) => sent.push(s), { initial: size(131, 58), timers: clock.timers });
  resizer.request(size(131, 58));
  clock.advance(PTY_RESIZE_SETTLE_MS);
  // A burst that ends where it began sends only its first step.
  resizer.request(size(131, 59));
  resizer.request(size(131, 58));
  clock.advance(PTY_RESIZE_SETTLE_MS);
  assert.deepEqual(sent, [size(131, 59), size(131, 58)]);
});

test("once disposed, a waiting resize is dropped and nothing more is sent", () => {
  const clock = fakeClock();
  const sent: PtySize[] = [];
  const resizer = createPtyResizer((s) => sent.push(s), { timers: clock.timers });
  resizer.request(size(100, 30));
  resizer.request(size(101, 30));
  resizer.dispose();
  clock.advance(PTY_RESIZE_SETTLE_MS);
  resizer.request(size(150, 50));
  assert.deepEqual(sent, [size(100, 30)]);
});
