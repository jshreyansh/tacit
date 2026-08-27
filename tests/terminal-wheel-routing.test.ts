import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveTerminalWheelConsumer,
  scrollRoomFromScrollElement,
  scrollRoomFromXtermBuffer,
  type TerminalScrollRoom,
} from "../src/canvas/terminalWheelRouting.ts";

const HAS_SCROLLBACK: TerminalScrollRoom = {
  canScrollUp: true,
  canScrollDown: true,
};
const AT_BOTTOM: TerminalScrollRoom = {
  canScrollUp: true,
  canScrollDown: false,
};
const NO_SCROLLBACK: TerminalScrollRoom = {
  canScrollUp: false,
  canScrollDown: false,
};

function wheel(overrides: {
  deltaX?: number;
  deltaY?: number;
  overTerminal?: boolean;
  terminalFocused?: boolean;
  room?: TerminalScrollRoom | null;
}) {
  return resolveTerminalWheelConsumer({
    deltaX: overrides.deltaX ?? 0,
    deltaY: overrides.deltaY ?? 0,
    overTerminal: overrides.overTerminal ?? true,
    terminalFocused: overrides.terminalFocused ?? false,
    room: overrides.room === undefined ? HAS_SCROLLBACK : overrides.room,
  });
}

// The reported bug: wheeling over a terminal that was not the single focused
// tile panned the canvas instead of scrolling the terminal, so scrollback was
// unreachable and the only way to see more output was to enlarge the card.
test("an unfocused terminal with scrollback consumes a vertical wheel", () => {
  assert.equal(wheel({ deltaY: -120, room: AT_BOTTOM }), "terminal");
  assert.equal(wheel({ deltaY: -120, room: HAS_SCROLLBACK }), "terminal");
  assert.equal(wheel({ deltaY: 120, room: HAS_SCROLLBACK }), "terminal");
});

test("a gesture with no terminal under the cursor always pans the canvas", () => {
  assert.equal(wheel({ deltaY: -120, overTerminal: false }), "canvas");
  assert.equal(
    wheel({ deltaY: -120, overTerminal: false, terminalFocused: true }),
    "canvas",
  );
});

test("the focused terminal owns the wheel outright, in every direction", () => {
  // Mouse-reporting TUIs need the raw events even with an empty scrollback,
  // and horizontal gestures must not be stolen back by the camera.
  assert.equal(
    wheel({ deltaY: 120, terminalFocused: true, room: NO_SCROLLBACK }),
    "terminal",
  );
  assert.equal(
    wheel({ deltaX: -200, terminalFocused: true, room: NO_SCROLLBACK }),
    "terminal",
  );
  assert.equal(
    wheel({ deltaY: -120, terminalFocused: true, room: null }),
    "terminal",
  );
});

test("horizontal-dominant gestures over an unfocused terminal pan the canvas", () => {
  // A terminal has no horizontal axis, and horizontal panning across a dense
  // canvas must not snag on every tile it crosses.
  assert.equal(wheel({ deltaX: -200, deltaY: 10 }), "canvas");
  assert.equal(wheel({ deltaX: 200, deltaY: -10 }), "canvas");
});

test("vertical-dominant gestures still reach an unfocused terminal", () => {
  assert.equal(wheel({ deltaX: 10, deltaY: -200 }), "terminal");
});

test("an unfocused terminal chains to the canvas once its buffer runs out", () => {
  // Scrolling down while already pinned to the bottom keeps panning working
  // when the cursor happens to sit over a tile.
  assert.equal(wheel({ deltaY: 120, room: AT_BOTTOM }), "canvas");
  assert.equal(wheel({ deltaY: -120, room: NO_SCROLLBACK }), "canvas");
  assert.equal(wheel({ deltaY: 120, room: NO_SCROLLBACK }), "canvas");
});

test("an unfocused terminal with unknown scroll position pans the canvas", () => {
  assert.equal(wheel({ deltaY: -120, room: null }), "canvas");
});

test("a zero vertical delta over an unfocused terminal pans the canvas", () => {
  assert.equal(wheel({ deltaY: 0, deltaX: 0 }), "canvas");
});

test("scrollRoomFromXtermBuffer reads travel off viewportY vs baseY", () => {
  // Pinned to the bottom of a buffer with scrollback: history above, none below.
  assert.deepEqual(scrollRoomFromXtermBuffer({ viewportY: 500, baseY: 500 }), {
    canScrollUp: true,
    canScrollDown: false,
  });
  // Scrolled up into history: room in both directions.
  assert.deepEqual(scrollRoomFromXtermBuffer({ viewportY: 250, baseY: 500 }), {
    canScrollUp: true,
    canScrollDown: true,
  });
  // Fresh terminal / alt-screen TUI: no scrollback at all.
  assert.deepEqual(scrollRoomFromXtermBuffer({ viewportY: 0, baseY: 0 }), {
    canScrollUp: false,
    canScrollDown: false,
  });
});

test("scrollRoomFromScrollElement reads travel off a DOM scroll container", () => {
  assert.deepEqual(
    scrollRoomFromScrollElement({
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
    }),
    { canScrollUp: false, canScrollDown: true },
  );
  assert.deepEqual(
    scrollRoomFromScrollElement({
      scrollTop: 300,
      scrollHeight: 1000,
      clientHeight: 400,
    }),
    { canScrollUp: true, canScrollDown: true },
  );
  // Sub-pixel remainders at either end count as "at the end", so HiDPI
  // rounding does not strand the gesture on the terminal.
  assert.deepEqual(
    scrollRoomFromScrollElement({
      scrollTop: 599.6,
      scrollHeight: 1000,
      clientHeight: 400,
    }),
    { canScrollUp: true, canScrollDown: false },
  );
  assert.deepEqual(
    scrollRoomFromScrollElement({
      scrollTop: 0.4,
      scrollHeight: 1000,
      clientHeight: 400,
    }),
    { canScrollUp: false, canScrollDown: true },
  );
  assert.deepEqual(
    scrollRoomFromScrollElement({
      scrollTop: 0,
      scrollHeight: 400,
      clientHeight: 400,
    }),
    { canScrollUp: false, canScrollDown: false },
  );
});

// Guards the DOM-side half of the fix, which the pure router cannot see: the
// canvas handler swallows any wheel event whose host selector it does not
// match, so both engines' host classes have to be listed there.
test("the canvas wheel router matches both terminal engine hosts", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../src/canvas/XyFlowCanvas.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /\.tc-xterm-host, \.tc-wterm-host/);
});
