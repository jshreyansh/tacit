import test from "node:test";
import assert from "node:assert/strict";

import {
  BASE_LABEL_PX,
  LABEL_FADE_BAND,
  LABEL_HIDE_SCALE,
  MIN_LABEL_PX,
  connectionLabelLayout,
} from "../src/canvas/connectionLabelScale";
import {
  MAX_WIRE_PROMPT_LENGTH,
  connectionStrokeStyle,
  formatConnectionTypeLabel,
  hasCustomMarker,
  shortCustomPrompt,
} from "../src/canvas/connectionTypeStyle";
import {
  MAX_CUSTOM_PROMPT_LENGTH,
  connectionTypeSpec,
  validConnectionTypes,
  type ConnectionEndpointKind,
  type ConnectionFamily,
} from "../shared/connection-types";

const wire = (
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
  over: { type?: string; customPrompt?: string } = {},
) => ({
  from: { kind: from },
  to: { kind: to },
  ...(over.type ? { type: over.type as never } : {}),
  ...(over.customPrompt ? { customPrompt: over.customPrompt } : {}),
});

/** What the menu actually puts on screen, in order. */
const menuRows = (from: ConnectionEndpointKind, to: ConnectionEndpointKind) =>
  validConnectionTypes(from, to).map((type) => connectionTypeSpec(type).label);

// ---------------------------------------------------------------- label text

test("a wire says what it is, even when nobody chose a type", () => {
  // The label reads the meaning through resolveConnectionType, so an untyped
  // wire is labelled with what it actually does rather than left blank.
  assert.equal(formatConnectionTypeLabel(wire("terminal", "browser")), "controls");
  assert.equal(
    formatConnectionTypeLabel(wire("browser", "terminal")),
    "feeds context to",
  );
  assert.equal(formatConnectionTypeLabel(wire("note", "note")), "relates to");
});

test("an explicit type wins over the inferred one", () => {
  assert.equal(
    formatConnectionTypeLabel(wire("terminal", "browser", { type: "sends-replies-to" })),
    "sends replies to",
  );
});

test("a type this build doesn't know degrades to the inferred label, not a blank", () => {
  assert.equal(
    formatConnectionTypeLabel(wire("terminal", "browser", { type: "teleports-to" })),
    "controls",
  );
});

test("a custom wire shows enough of its instruction to be recognised", () => {
  const label = formatConnectionTypeLabel(
    wire("terminal", "terminal", {
      type: "custom",
      customPrompt: "send only the final summary",
    }),
  );
  assert.ok(label.startsWith("custom · "), `expected a custom label, got ${label}`);
  // Recognisable means some of the user's own words survive.
  assert.ok(label.includes("send only"), label);
});

test("a long instruction is elided rather than allowed to cover the canvas", () => {
  const prompt = "x".repeat(MAX_CUSTOM_PROMPT_LENGTH);
  const short = shortCustomPrompt(prompt);
  assert.ok(short);
  assert.ok(
    short!.length <= MAX_WIRE_PROMPT_LENGTH,
    `${short!.length} > ${MAX_WIRE_PROMPT_LENGTH}`,
  );
  assert.ok(short!.endsWith("…"), short!);
});

test("whitespace in an instruction is collapsed before it is drawn", () => {
  assert.equal(shortCustomPrompt("  send   only "), "send only");
  assert.equal(shortCustomPrompt("   "), null);
  assert.equal(shortCustomPrompt(undefined), null);
});

test("custom with no instruction yet is still honestly labelled custom", () => {
  assert.equal(
    formatConnectionTypeLabel(wire("note", "note", { type: "custom" })),
    "custom",
  );
});

test("only a custom wire gets the hand-written marker", () => {
  assert.equal(hasCustomMarker(wire("note", "note", { type: "custom" })), true);
  assert.equal(hasCustomMarker(wire("terminal", "browser")), false);
  assert.equal(
    hasCustomMarker(wire("terminal", "terminal", { type: "hands-off-to" })),
    false,
  );
});

// -------------------------------------------------------------- stroke style

test("the three families are told apart by stroke alone, in both views", () => {
  const families: ConnectionFamily[] = ["action", "knowledge", "structural"];
  for (const view of ["working", "overview"] as const) {
    const signatures = families.map((family) => {
      const style = connectionStrokeStyle(family, view);
      return `${style.dash ?? "solid"}/${style.width}/${style.opacity}`;
    });
    assert.equal(
      new Set(signatures).size,
      families.length,
      `${view}: two families are drawn identically (${signatures.join(", ")})`,
    );
  }
});

test("action is solid, knowledge is dashed, structural is a faint hairline", () => {
  assert.equal(connectionStrokeStyle("action").dash, null);
  assert.ok(connectionStrokeStyle("knowledge").dash);
  const structural = connectionStrokeStyle("structural");
  assert.ok(
    structural.width < connectionStrokeStyle("action").width,
    "structural should be thinner than action",
  );
  assert.ok(
    structural.opacity < connectionStrokeStyle("action").opacity,
    "structural should be fainter than action",
  );
});

test("an agent-to-browser wire is drawn exactly as it always was", () => {
  // `controls` is an action, and this is the compatibility claim that makes
  // typing wires free: nothing drawn before types existed changes appearance.
  const style = connectionStrokeStyle("action", "working");
  assert.deepEqual(style, { dash: null, width: 1.5, opacity: 0.8 });
});

// ------------------------------------------------------------- zoom / labels

test("labels are pinned at their base size when zoomed in, never growing", () => {
  for (const scale of [1, 1.4, 2]) {
    assert.equal(connectionLabelLayout(scale).fontPx, BASE_LABEL_PX, `at ${scale}`);
  }
});

test("zooming out shrinks the label only down to a floor, then holds", () => {
  const scales = [0.95, 0.9, 0.85, 0.8, 0.7, 0.6, LABEL_HIDE_SCALE];
  let previous = BASE_LABEL_PX + 1;
  for (const scale of scales) {
    const { fontPx } = connectionLabelLayout(scale);
    assert.ok(fontPx <= previous, `${scale} grew the label`);
    assert.ok(fontPx >= MIN_LABEL_PX, `${scale} fell through the floor`);
    previous = fontPx;
  }
  // The floor is genuinely reached rather than merely approached.
  assert.equal(connectionLabelLayout(LABEL_HIDE_SCALE).fontPx, MIN_LABEL_PX);
});

test("holding the floor means the label is being counter-scaled, not just small", () => {
  // At the floor the label is bigger than the canvas transform would have made
  // it — that is the whole point of computing this in screen space.
  assert.ok(connectionLabelLayout(0.6).counterScale > 1);
  // At 1:1 there is nothing to counteract.
  assert.equal(connectionLabelLayout(1).counterScale, 1);
});

test("below the threshold labels disappear and the line style carries it", () => {
  for (const scale of [0.49, 0.3, 0.1]) {
    const layout = connectionLabelLayout(scale);
    assert.equal(layout.visible, false, `at ${scale}`);
    assert.equal(layout.opacity, 0, `at ${scale}`);
  }
  assert.equal(connectionLabelLayout(LABEL_HIDE_SCALE).visible, true);
});

test("labels fade in across a band instead of popping into existence", () => {
  assert.equal(connectionLabelLayout(LABEL_HIDE_SCALE).opacity, 0);
  const mid = connectionLabelLayout(LABEL_HIDE_SCALE + LABEL_FADE_BAND / 2);
  assert.ok(mid.opacity > 0 && mid.opacity < 1, String(mid.opacity));
  assert.equal(connectionLabelLayout(LABEL_HIDE_SCALE + LABEL_FADE_BAND).opacity, 1);
});

test("a nonsense scale cannot take the layer down with a NaN font size", () => {
  for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const layout = connectionLabelLayout(scale);
    assert.ok(Number.isFinite(layout.fontPx), `${scale} produced ${layout.fontPx}`);
    assert.ok(Number.isFinite(layout.opacity));
  }
});

// --------------------------------------------------------------- menu rows

test("the menu offers readable phrases, in order, with custom last", () => {
  assert.deepEqual(menuRows("terminal", "browser"), [
    "controls",
    "sends replies to",
    "relates to",
    "custom",
  ]);
  assert.deepEqual(menuRows("note", "terminal"), ["instructs", "relates to", "custom"]);
  assert.deepEqual(menuRows("note", "note"), ["relates to", "custom"]);
  assert.deepEqual(menuRows("browser", "browser"), [
    "sends page to",
    "relates to",
    "custom",
  ]);
});

test("no row is a dead end: every offered type has a label and only custom asks", () => {
  const kinds: ConnectionEndpointKind[] = ["terminal", "browser", "note"];
  for (const from of kinds) {
    for (const to of kinds) {
      const types = validConnectionTypes(from, to);
      assert.equal(types.at(-1), "custom", `${from}>${to} must end with custom`);
      for (const type of types) {
        const spec = connectionTypeSpec(type);
        assert.ok(spec.label.length > 0, `${type} has no label`);
        assert.equal(
          spec.needsInput,
          type === "custom",
          `${type} asks for input it shouldn't`,
        );
      }
    }
  }
});

test("the wire's current meaning is always one of the rows the menu shows", () => {
  // Otherwise the menu would open with nothing marked as current.
  const kinds: ConnectionEndpointKind[] = ["terminal", "browser", "note"];
  for (const from of kinds) {
    for (const to of kinds) {
      const label = formatConnectionTypeLabel(wire(from, to));
      assert.ok(
        menuRows(from, to).includes(label),
        `${from}>${to} is labelled "${label}", which its menu does not offer`,
      );
    }
  }
});
