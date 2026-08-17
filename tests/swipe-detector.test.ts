import test from "node:test";
import assert from "node:assert/strict";

import { createSwipeDetector } from "../src/canvas/swipeDetector";

/**
 * Two-finger swipe paging in focus mode.
 *
 * The behaviour under test is the momentum tail. A macOS trackpad keeps
 * emitting wheel events after the fingers leave the surface, smoothly decaying
 * over a second or more. Those events are not a gesture, and anything that
 * lets them start one makes focus mode skip a node on its own — swipe from A
 * to B, arrive at B, and land on C a second later untouched.
 */

/** Feed a run of events, returning how many times a swipe fired. */
function feed(
  detector: ReturnType<typeof createSwipeDetector>,
  samples: Array<{ deltaX: number; deltaY?: number; wait?: number }>,
  clock: { now: number },
): number {
  let fired = 0;
  for (const s of samples) {
    clock.now += s.wait ?? 16; // ~60Hz, the real event rate
    if (detector.handleWheel({ deltaX: s.deltaX, deltaY: s.deltaY ?? 0 }).triggered) {
      fired += 1;
    }
  }
  return fired;
}

function withClock<T>(run: (clock: { now: number }) => T): T {
  const clock = { now: 1_000_000 };
  const realNow = Date.now;
  Date.now = () => clock.now;
  try {
    return run(clock);
  } finally {
    Date.now = realNow;
  }
}

/** A flick: a few large samples in quick succession. */
const FLICK = [{ deltaX: -60 }, { deltaX: -55 }, { deltaX: -45 }];

/**
 * A real momentum tail, shaped like the ones logged from the device: a long
 * smooth decay at the same event rate, never pausing until it stops.
 */
function momentumTail(from: number, samples: number) {
  const out: Array<{ deltaX: number }> = [];
  let v = from;
  for (let i = 0; i < samples; i += 1) {
    v *= 0.94;
    out.push({ deltaX: -v });
  }
  return out;
}

test("a deliberate flick fires exactly once", () => {
  withClock((clock) => {
    const d = createSwipeDetector();
    assert.equal(feed(d, FLICK, clock), 1);
  });
});

test("the direction reflects the way the fingers moved", () => {
  withClock((clock) => {
    const left = createSwipeDetector();
    const right = createSwipeDetector();
    feed(left, FLICK, clock);
    const a = left.handleWheel({ deltaX: 0, deltaY: 0 });
    assert.equal(a.triggered, false);

    clock.now += 2000;
    const r = createSwipeDetector();
    let dir: number | undefined;
    for (const s of [{ deltaX: 60 }, { deltaX: 55 }, { deltaX: 45 }]) {
      clock.now += 16;
      const res = r.handleWheel({ deltaX: s.deltaX, deltaY: 0 });
      if (res.triggered) dir = res.direction;
    }
    assert.equal(dir, 1);
    void right;
  });
});

// The reported bug: one swipe, then a second page turn a beat later with no
// further input. A long tail is exactly what produces it.
test("a long momentum tail after a flick never fires a second time", () => {
  withClock((clock) => {
    const d = createSwipeDetector();
    const fired = feed(d, [...FLICK, ...momentumTail(120, 90)], clock);
    assert.equal(fired, 1, "the tail must not page again");
  });
});

test("even a very long tail cannot fire again", () => {
  withClock((clock) => {
    const d = createSwipeDetector();
    // ~2.5s of decay at 60Hz, past any fixed cooldown cap.
    const fired = feed(d, [...FLICK, ...momentumTail(140, 150)], clock);
    assert.equal(fired, 1);
  });
});

// The tail's own low-amplitude end must not seed a fresh gesture either.
test("the settled end of a tail does not accumulate into a swipe", () => {
  withClock((clock) => {
    const d = createSwipeDetector();
    const crawl = Array.from({ length: 40 }, () => ({ deltaX: -6 }));
    const fired = feed(d, [...FLICK, ...momentumTail(120, 40), ...crawl], clock);
    assert.equal(fired, 1);
  });
});

// The cooldown must not become a lockout: once the trackpad goes quiet, the
// next real swipe has to work.
test("a second deliberate swipe after the tail ends does fire", () => {
  withClock((clock) => {
    const d = createSwipeDetector();
    feed(d, [...FLICK, ...momentumTail(120, 60)], clock);
    clock.now += 400; // fingers lifted, trackpad silent
    assert.equal(feed(d, FLICK, clock), 1, "a genuine second swipe must page");
  });
});

test("a diagonal scroll is not a swipe", () => {
  withClock((clock) => {
    const d = createSwipeDetector();
    const diagonal = [
      { deltaX: -60, deltaY: -40 },
      { deltaX: -55, deltaY: -45 },
      { deltaX: -45, deltaY: -30 },
    ];
    assert.equal(feed(d, diagonal, clock), 0);
  });
});

test("reset clears any pending cooldown", () => {
  withClock((clock) => {
    const d = createSwipeDetector();
    feed(d, FLICK, clock);
    d.reset();
    clock.now += 200;
    assert.equal(feed(d, FLICK, clock), 1);
  });
});
