import { normalizeWirePurpose } from "../../shared/node-contracts";
import { defaultConnectionType } from "../../shared/connection-types";
import { normalizeRules } from "../../shared/wire-rules";
import { WIRE_MODEL_VERSION, type ConnectionData } from "../stores/connectionStore";

/**
 * Converts wires saved before the wiring model, once, as a workdesk loads.
 *
 * Under the model the tail of a wire is the end that starts things. Before
 * it, browser control ignored direction, so a wire dragged from a browser to
 * an agent let the agent drive the page, and that was the only thing such a
 * wire ever did. Those are turned round, so they keep doing it. One the user
 * had explicitly made a plain link ("relates to") stays a plain link.
 *
 * An untyped agent-to-note wire keeps appending replies, which it did before.
 *
 * A custom instruction becomes the wire's purpose, which is what it was
 * closest to, and the wire becomes the pair's ordinary live wire.
 *
 * Pure, and a no-op for a wire already written under this model, so it is
 * safe to run on every load.
 */
export function migrateWire(wire: ConnectionData): ConnectionData {
  if (wire.rules !== undefined) {
    // Rules come back from a file; anything malformed is dropped, not run.
    const rules = normalizeRules(wire.rules);
    wire = rules.length ? { ...wire, rules } : (({ rules: _, ...rest }) => rest)(wire);
  }
  if ((wire.v ?? 0) >= WIRE_MODEL_VERSION) return wire;
  let next: ConnectionData = { ...wire, v: WIRE_MODEL_VERSION };

  const wasBrowserToAgent =
    next.origin !== "spawn" &&
    next.from.kind === "browser" &&
    next.to.kind === "terminal" &&
    (next.type === undefined || next.type === "feeds-context-to");
  if (wasBrowserToAgent) {
    next = { ...next, from: next.to, to: next.from, type: "controls" };
  }

  // Untyped agent-to-note wires used to append every finished reply to the
  // note. New ones don't until the user turns that on, so old ones are
  // stamped with the rule they were running.
  if (
    next.type === undefined &&
    next.origin !== "spawn" &&
    next.from.kind === "terminal" &&
    next.to.kind === "note"
  ) {
    next = { ...next, type: "writes-to" };
  }

  if (next.type === "custom") {
    const purpose = normalizeWirePurpose(next.customPrompt);
    next = { ...next, type: defaultConnectionType(next.from.kind, next.to.kind) };
    if (purpose && !next.purpose) next.purpose = purpose;
    delete next.customPrompt;
  }
  return next;
}

export function migrateWires(
  connections: Record<string, ConnectionData>,
): Record<string, ConnectionData> {
  const out: Record<string, ConnectionData> = {};
  for (const [id, wire] of Object.entries(connections)) out[id] = migrateWire(wire);
  return out;
}
