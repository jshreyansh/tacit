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
  MAX_WIRE_LABEL_LENGTH,
  connectionStrokeStyle,
  wireLabel,
  wireRoleLabel,
} from "../src/canvas/connectionTypeStyle";
import {
  connectionTypeSpec,
  type ConnectionEndpointKind,
  type ConnectionFamily,
} from "../shared/connection-types";
import type { Ability } from "../shared/node-contracts";

const wire = (
  from: ConnectionEndpointKind,
  to: ConnectionEndpointKind,
  over: { type?: string; purpose?: string } = {},
) => ({
  from: { kind: from },
  to: { kind: to },
  ...(over.type ? { type: over.type as never } : {}),
  ...(over.purpose ? { purpose: over.purpose } : {}),
});

const label = (w: ReturnType<typeof wire>, tailAbilities: Ability[] = []) => {
  const l = wireLabel({ connection: w, tailAbilities });
  return l.kind === "purpose" ? `purpose:${l.text}` : l.key;
};

// ---------------------------------------------------------------- label text

test("a wire says what it does, from what its tail can do to its head", () => {
  assert.equal(label(wire("terminal", "browser"), ["read", "drive"]), "wire_label_drives");
  assert.equal(label(wire("terminal", "browser"), ["read"]), "wire_label_reads");
  assert.equal(label(wire("terminal", "terminal"), ["tell", "ask", "hand_off"]), "wire_label_messages");
  assert.equal(label(wire("terminal", "terminal"), ["run"]), "wire_label_runs");
  assert.equal(label(wire("terminal", "note"), ["read", "append"]), "wire_label_adds");
  assert.equal(label(wire("terminal", "note"), ["read", "log"]), "wire_label_logs");
  // A tail that starts nothing still sends its contents along.
  assert.equal(label(wire("note", "terminal"), []), "wire_label_sends");
});

test("the user's purpose wins over the generic words, and is cut short", () => {
  assert.equal(label(wire("terminal", "terminal", { purpose: "review each diff" }), ["tell"]), "purpose:review each diff");
  const long = label(wire("terminal", "terminal", { purpose: "x".repeat(200) }), ["tell"]);
  assert.ok(long.length - "purpose:".length <= MAX_WIRE_LABEL_LENGTH, long);
});

test("a plain link says so even with a purpose, and reply rules name the rule", () => {
  assert.equal(label(wire("terminal", "terminal", { type: "relates-to", purpose: "x" })), "wire_label_link");
  assert.equal(label(wire("terminal", "browser", { type: "sends-replies-to" }), ["drive"]), "wire_label_replies_chat");
  assert.equal(label(wire("terminal", "note", { type: "writes-to" }), ["append"]), "wire_label_replies_note");
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

test("a wire's label names the role of the agent at its far end, and how its work is going", () => {
  const wire = { from: { id: "lead" }, to: { kind: "terminal", id: "worker" } };
  // A Hydra worker: its assignment's role and status.
  assert.deepEqual(wireRoleLabel({ connection: wire, hydra: { role: "qa", status: "in_progress" } }), {
    role: "qa",
    status: "hydra_status_in_progress",
  });
  // Waiting at a question in its terminal.
  assert.deepEqual(wireRoleLabel({ connection: wire, hydra: { role: "qa", status: "in_progress", needsYou: true } }), {
    role: "qa",
    status: "hydra_status_needs_you",
  });
  // A role given on the wire, before anything is handed off, and while a
  // tracked hand-off along it runs and when it ends.
  const withRole = { ...wire, role: "reviewer" };
  assert.deepEqual(wireRoleLabel({ connection: withRole }), { role: "reviewer", status: null });
  assert.deepEqual(wireRoleLabel({ connection: withRole, handoffForward: "working" }), { role: "reviewer", status: "handoff_status_working" });
  assert.deepEqual(wireRoleLabel({ connection: withRole, handoffForward: "stuck" }), { role: "reviewer", status: "handoff_status_stuck" });
  // A tracked hand-off with no role: "hand-off · done" (the window fills the word in).
  assert.deepEqual(wireRoleLabel({ connection: wire, handoffForward: "done" }), { role: null, status: "handoff_status_done" });
  // One the other way along a two-way wire doesn't borrow the far end's role.
  assert.deepEqual(wireRoleLabel({ connection: withRole, handoffBack: "working" }), { role: null, status: "handoff_status_working" });
  // The user's own words win; and a plain wire has nothing to add.
  assert.equal(wireRoleLabel({ connection: { ...withRole, purpose: "review the auth change" }, handoffForward: "working" }), null);
  assert.equal(wireRoleLabel({ connection: wire }), null);
});

test("every role and status the label can show has words in each language", async () => {
  const { en } = await import("../src/i18n/en");
  const { zh } = await import("../src/i18n/zh");
  const keys = [
    "wire_label_handoff",
    ...["working", "done", "stuck", "error", "timed_out"].map((s) => `handoff_status_${s}`),
    ...["pending", "claimed", "in_progress", "completed", "timed_out", "failed", "needs_you"].map((s) => `hydra_status_${s}`),
  ];
  for (const key of keys) {
    assert.equal(typeof (en as Record<string, unknown>)[key], "string", `en ${key}`);
    assert.equal(typeof (zh as Record<string, unknown>)[key], "string", `zh ${key}`);
  }
});
