/**
 * A flowchart written as Mermaid, read and laid out
 * (docs/architecture/workdesk-board.md, "Agents draw"). Agents write this
 * well and place boxes badly, so they send the words and Tacit places them.
 * Free of React and the DOM.
 */
import type { BoardShapeKind } from "../types/board";

export interface FlowNode {
  id: string;
  text: string;
  shape: BoardShapeKind;
  /** The subgraph it's in. */
  group: string | null;
}
export interface FlowEdge {
  from: string;
  to: string;
  label: string;
  dashed: boolean;
  ends: "none" | "end" | "both";
}
export interface Flow {
  direction: "down" | "right";
  nodes: FlowNode[];
  edges: FlowEdge[];
  groups: Array<{ id: string; title: string }>;
}

const ID = /^[\p{L}\p{N}_]+(?:[-.][\p{L}\p{N}_]+)*/u;
/** Mermaid's node shapes, longest opening first. What we have no shape for is a box. */
const SHAPES: Array<[open: string, close: string, shape: BoardShapeKind]> = [
  ["(((", ")))", "ellipse"],
  ["([", "])", "ellipse"],
  ["((", "))", "ellipse"],
  ["[(", ")]", "ellipse"],
  ["[[", "]]", "rect"],
  ["[/", "/]", "rect"],
  ["[\\", "\\]", "rect"],
  ["{{", "}}", "rect"],
  ["{", "}", "diamond"],
  ["[", "]", "rect"],
  ["(", ")", "rect"],
  [">", "]", "rect"],
];
const clean = (text: string) =>
  text
    .trim()
    .replace(/^"([\s\S]*)"$/, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/#quot;|&quot;/g, '"')
    .replace(/&lt;|#lt;/g, "<")
    .replace(/&gt;|#gt;/g, ">")
    .replace(/&amp;|#amp;/g, "&")
    .replace(/#(\d{2,5});/g, (_, n) => String.fromCodePoint(Number(n)))
    .trim();

/** A line's edge: `-->`, `---`, `-.->`, `==>`, `<-->`, `--x`, with `|label|` or `-- label -->`. */
function edgeAt(s: string): { length: number; label: string; dashed: boolean; ends: FlowEdge["ends"] } | null {
  const m =
    /^(<)?(-{2,}|={2,}|-\.+-)([>xo])?(?=[\s|"\p{L}\p{N}_]|$)/u.exec(s) ??
    null;
  const worded = /^(<)?(--|==|-\.)\s+([^|\n]*?[^\s-])\s*(-{2,}|={2,}|\.+-)([>xo])?/.exec(s);
  // `-- label -->` starts like a plain `--`; it's the worded one when an arrow ends it.
  if (worded && (!m || m[2] === "--" || m[2] === "==") && !/^(<)?(-{2,}|={2,}|-\.+-)[>xo]/.test(s) && !/^(-{3,}|={3,})/.test(s)) {
    return { length: worded[0].length, label: clean(worded[3]), dashed: worded[2] === "-.", ends: worded[1] ? "both" : worded[5] ? "end" : "none" };
  }
  if (!m) return null;
  let length = m[0].length;
  let label = "";
  const pipe = /^\s*\|(\s*"[^"]*"\s*|[^|]*)\|/.exec(s.slice(length));
  if (pipe) {
    label = clean(pipe[1]);
    length += pipe[0].length;
  }
  return { length, label, dashed: m[2].includes("."), ends: m[1] ? "both" : m[3] ? "end" : "none" };
}

/** Lines, and what `;` ends: but not one inside words, in brackets, quotes or a label. */
function statements(source: string): string[] {
  const out: string[] = [];
  let now = "";
  let depth = 0;
  let quoted = false;
  let label = false;
  for (const c of source) {
    if (c === "\n") {
      out.push(now);
      now = "";
      depth = 0;
      quoted = label = false;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted) {
      if (c === "|") label = !label;
      else if (!label && "[({".includes(c)) depth++;
      else if (!label && "])}".includes(c)) depth = Math.max(0, depth - 1);
    }
    if (c === ";" && !quoted && !label && depth === 0) {
      out.push(now);
      now = "";
    } else now += c;
  }
  out.push(now);
  return out;
}

export function parseFlow(source: string): Flow | { error: string } {
  const flow: Flow = { direction: "down", nodes: [], edges: [], groups: [] };
  const byId = new Map<string, FlowNode>();
  const stack: string[] = [];
  const lines = statements(source.replace(/```(?:mermaid)?/g, ""));
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    const head = /^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*$/i.exec(line);
    if (head) {
      flow.direction = /^(LR|RL)$/i.test(head[1] ?? "") ? "right" : "down";
      continue;
    }
    if (/^(style|classDef|class|linkStyle|click|direction|accTitle|accDescr)\b/.test(line)) continue;
    const sub = /^subgraph\s+(?:([\p{L}\p{N}_-]+)\s*\[(.+)\]|(.+))$/u.exec(line);
    if (sub) {
      const title = clean(sub[2] ?? sub[3]);
      const id = `g${flow.groups.length + 1}`;
      flow.groups.push({ id, title });
      stack.push(id);
      continue;
    }
    if (/^end$/i.test(line)) {
      stack.pop();
      continue;
    }
    let rest = line;
    const fail = () => ({ error: `This line isn't a flowchart line Tacit understands: "${line.slice(0, 120)}". Write nodes as A[Words] or A{Question?}, and arrows as A --> B or A -->|label| B.` });
    const node = (): string | null => {
      const id = ID.exec(rest)?.[0];
      if (!id) return null;
      rest = rest.slice(id.length);
      let text: string | null = null;
      let shape: BoardShapeKind = "rect";
      for (const [open, close, kind] of SHAPES) {
        if (!rest.startsWith(open)) continue;
        // Quoted words may hold the brackets themselves.
        const quoted = /^\s*"([^"]*)"\s*/.exec(rest.slice(open.length));
        const end = quoted && rest.slice(open.length + quoted[0].length).startsWith(close) ? open.length + quoted[0].length : rest.indexOf(close, open.length);
        if (end < 0) continue;
        text = clean(rest.slice(open.length, end));
        shape = kind;
        rest = rest.slice(end + close.length);
        break;
      }
      rest = rest.replace(/^:::[\w-]+/, "");
      const group = stack[stack.length - 1] ?? null;
      const known = byId.get(id);
      if (known) {
        if (text !== null) Object.assign(known, { text, shape });
        if (group && !known.group) known.group = group;
      } else {
        const made: FlowNode = { id, text: text ?? id, shape, group };
        byId.set(id, made);
        flow.nodes.push(made);
      }
      return id;
    };
    const nodes = (): string[] | null => {
      const out: string[] = [];
      for (;;) {
        rest = rest.trimStart();
        const id = node();
        if (!id) return null;
        out.push(id);
        rest = rest.trimStart();
        if (!rest.startsWith("&")) return out;
        rest = rest.slice(1);
      }
    };
    let from = nodes();
    if (!from) return fail();
    while (rest) {
      const edge = edgeAt(rest);
      if (!edge) return fail();
      rest = rest.slice(edge.length);
      const to = nodes();
      if (!to) return fail();
      for (const a of from) for (const b of to) flow.edges.push({ from: a, to: b, label: edge.label, dashed: edge.dashed, ends: edge.ends });
      from = to;
    }
  }
  if (flow.nodes.length === 0) return { error: "The flowchart has no nodes. Write nodes as A[Words], and arrows as A --> B." };
  // A subgraph nothing was put in isn't drawn.
  flow.groups = flow.groups.filter((g) => flow.nodes.some((node) => node.group === g.id));
  return flow;
}

export interface Size {
  w: number;
  h: number;
}
export interface Placed extends Size {
  x: number;
  y: number;
}

const GAP_ALONG = 100;
const GAP_ACROSS = 84;

interface Cell {
  id: string;
  /** Along the flow, and across it. */
  along: number;
  across: number;
  size: Size;
  dummy: boolean;
}

/**
 * Nodes in ranks along the flow, ordered across it to cross few lines: the
 * usual layered drawing. `size` and `labelWidth` are in canvas units.
 */
export function layoutLayered(
  nodes: ReadonlyArray<{ id: string } & Size>,
  edges: ReadonlyArray<{ from: string; to: string; labelWidth?: number }>,
  direction: Flow["direction"],
  /** Which end of its rank a node keeps to: one joined to something beside the drawing is on that side. */
  pull: ReadonlyMap<string, -1 | 1> = new Map(),
): Map<string, Placed> {
  const right = direction === "right";
  const ids = new Set(nodes.map((x) => x.id));
  const links = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);
  const out = new Map<string, string[]>(nodes.map((x) => [x.id, []]));
  for (const e of links) out.get(e.from)!.push(e.to);

  // Lines that go back up are turned round for ranking.
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  const key = (a: string, b: string) => `${a}\u0000${b}`;
  const visit = (start: string) => {
    const todo: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    state.set(start, 1);
    while (todo.length) {
      const top = todo[todo.length - 1];
      const to = out.get(top.id)![top.next++];
      if (to === undefined) {
        state.set(top.id, 2);
        todo.pop();
      } else if (state.get(to) === 1) back.add(key(top.id, to));
      else if (!state.has(to)) {
        state.set(to, 1);
        todo.push({ id: to, next: 0 });
      }
    }
  };
  const hasIn = new Set(links.map((e) => e.to));
  for (const x of nodes) if (!hasIn.has(x.id) && !state.has(x.id)) visit(x.id);
  for (const x of nodes) if (!state.has(x.id)) visit(x.id);
  const forward = links.map((e) => (back.has(key(e.from, e.to)) ? { from: e.to, to: e.from, back: true } : { from: e.from, to: e.to, back: false }));

  const rank = new Map<string, number>(nodes.map((x) => [x.id, 0]));
  for (let i = 0; i < nodes.length; i++) {
    let moved = false;
    for (const e of forward) {
      const want = rank.get(e.from)! + 1;
      if (rank.get(e.to)! < want && want < nodes.length) {
        rank.set(e.to, want);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // A line over several ranks keeps a place in each, so boxes leave it room.
  const ranks: Cell[][] = [];
  const cells = new Map<string, Cell>();
  const put = (id: string, r: number, size: Size, dummy: boolean) => {
    const cell: Cell = { id, along: 0, across: 0, size, dummy };
    (ranks[r] ??= []).push(cell);
    cells.set(id, cell);
  };
  for (const x of nodes) put(x.id, rank.get(x.id)!, { w: x.w, h: x.h }, false);
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  // A line back isn't what a box lines up with.
  const lineUp = new Map<string, string[]>();
  const lineDown = new Map<string, string[]>();
  const join = (a: string, b: string, isBack: boolean) => {
    if (!isBack || a.startsWith("\u0000") || b.startsWith("\u0000")) {
      if (!isBack || a.startsWith("\u0000")) lineDown.set(a, [...(lineDown.get(a) ?? []), b]);
      if (!isBack || b.startsWith("\u0000")) lineUp.set(b, [...(lineUp.get(b) ?? []), a]);
    }
    down.set(a, [...(down.get(a) ?? []), b]);
    up.set(b, [...(up.get(b) ?? []), a]);
  };
  forward.forEach((e, i) => {
    let last = e.from;
    for (let r = rank.get(e.from)! + 1; r < rank.get(e.to)!; r++) {
      const id = `\u0000${i}:${r}`;
      put(id, r, { w: 24, h: 24 }, true);
      join(last, id, e.back);
      last = id;
    }
    join(last, e.to, e.back);
  });
  for (let r = 0; r < ranks.length; r++) ranks[r] ??= [];

  const position = () => new Map(ranks.flatMap((row) => row.map((c, i) => [c.id, i] as const)));
  const crossings = () => {
    const at = position();
    let count = 0;
    for (const row of ranks) {
      const lines = row.flatMap((c) => (down.get(c.id) ?? []).map((t) => [at.get(c.id)!, at.get(t)!] as const));
      for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if ((lines[i][0] - lines[j][0]) * (lines[i][1] - lines[j][1]) < 0) count++;
    }
    return count;
  };
  const sweep = (row: Cell[], near: Map<string, string[]>) => {
    const at = position();
    const weight = new Map(row.map((c, i) => {
      const n = (near.get(c.id) ?? []).map((x) => at.get(x)!);
      return [c.id, n.length ? n.reduce((a, b) => a + b, 0) / n.length : i] as const;
    }));
    row.sort((a, b) => weight.get(a.id)! - weight.get(b.id)!);
  };
  let best = ranks.map((row) => [...row]);
  let fewest = crossings();
  for (let i = 0; i < 12 && fewest > 0; i++) {
    if (i % 2 === 0) for (let r = 1; r < ranks.length; r++) sweep(ranks[r], up);
    else for (let r = ranks.length - 2; r >= 0; r--) sweep(ranks[r], down);
    const now = crossings();
    if (now < fewest) {
      fewest = now;
      best = ranks.map((row) => [...row]);
    }
  }
  best.forEach((row, r) => (ranks[r] = [...row.filter((c) => pull.get(c.id) === -1), ...row.filter((c) => !pull.has(c.id)), ...row.filter((c) => pull.get(c.id) === 1)]));

  // Along: each rank after the one before, with room for the words on its lines.
  const labels = new Map<number, number>();
  for (const e of links) {
    const r = Math.min(rank.get(e.from)!, rank.get(e.to)!);
    labels.set(r, Math.max(labels.get(r) ?? 0, e.labelWidth ?? 0));
  }
  let along = 0;
  ranks.forEach((row, r) => {
    const deep = Math.max(0, ...row.map((c) => (right ? c.size.w : c.size.h)));
    for (const c of row) c.along = along + deep / 2;
    const words = labels.get(r) ?? 0;
    along += deep + (right ? Math.max(GAP_ALONG, words ? words + 80 : 0) : words ? GAP_ALONG + 40 : GAP_ALONG);
  });

  // Across: near what each is joined to, never over its neighbour.
  const span = (c: Cell) => (right ? c.size.h : c.size.w);
  const apart = (a: Cell, b: Cell) => (span(a) + span(b)) / 2 + (a.dummy || b.dummy ? GAP_ACROSS / 2 : GAP_ACROSS);
  for (const row of ranks) {
    let x = 0;
    row.forEach((c, i) => {
      x = i === 0 ? 0 : x + apart(row[i - 1], c);
      c.across = x;
    });
    for (const c of row) c.across -= x / 2;
  }
  const settle = (row: Cell[], near: Map<string, string[]>) => {
    const want = row.map((c) => {
      const n = (near.get(c.id) ?? []).map((id) => cells.get(id)!.across).sort((a, b) => a - b);
      return n.length ? (n[(n.length - 1) >> 1] + n[n.length >> 1]) / 2 : c.across;
    });
    // Pushed right from the left, and left from the right; the middle of the two is fair to both.
    const a: number[] = [];
    row.forEach((c, i) => a.push(i === 0 ? want[0] : Math.max(want[i], a[i - 1] + apart(row[i - 1], c))));
    const b: number[] = new Array(row.length);
    for (let i = row.length - 1; i >= 0; i--) b[i] = i === row.length - 1 ? want[i] : Math.min(want[i], b[i + 1] - apart(row[i], row[i + 1]));
    row.forEach((c, i) => (c.across = (a[i] + b[i]) / 2));
  };
  for (let i = 0; i < 8; i++) {
    for (let r = 1; r < ranks.length; r++) settle(ranks[r], lineUp);
    for (let r = ranks.length - 2; r >= 0; r--) settle(ranks[r], lineDown);
  }

  const placed = new Map<string, Placed>();
  for (const x of nodes) {
    const c = cells.get(x.id)!;
    const cx = right ? c.along : c.across;
    const cy = right ? c.across : c.along;
    placed.set(x.id, { x: cx - x.w / 2, y: cy - x.h / 2, w: x.w, h: x.h });
  }
  return placed;
}

export interface FlowPlan {
  nodes: Map<string, Placed>;
  groups: Map<string, Placed>;
}

const GROUP_PAD = 60;
const CLUSTER_GAP = 140;

/** Where everything goes. Each subgraph is laid out by itself, and then they're placed as single things. */
export function layoutFlow(flow: Flow, sizeOf: (node: FlowNode) => Size, labelWidth: (label: string) => number): FlowPlan {
  const inGroup = (id: string | null) => flow.nodes.filter((x) => x.group === id);
  const edges = flow.edges.map((e) => ({ from: e.from, to: e.to, labelWidth: e.label ? labelWidth(e.label) : 0 }));
  const boxOf = (places: Iterable<Placed>): Placed => {
    const list = [...places];
    const x = Math.min(...list.map((p) => p.x));
    const y = Math.min(...list.map((p) => p.y));
    return { x, y, w: Math.max(...list.map((p) => p.x + p.w)) - x, h: Math.max(...list.map((p) => p.y + p.h)) - y };
  };
  if (flow.groups.length === 0) return { nodes: layoutLayered(flow.nodes.map((x) => ({ id: x.id, ...sizeOf(x) })), edges, flow.direction), groups: new Map() };
  const outerId = new Map(flow.nodes.map((x) => [x.id, x.group ?? x.id]));
  // Which cluster is after which, for which side each node's lines leave from.
  const beside = flow.direction === "down" ? "right" : "down";
  const order = layoutLayered([...flow.groups.map((g) => ({ id: g.id, w: 10, h: 10 })), ...inGroup(null).map((x) => ({ id: x.id, w: 10, h: 10 }))], edges.map((e) => ({ from: outerId.get(e.from)!, to: outerId.get(e.to)! })).filter((e) => e.from !== e.to), beside);
  const place = (id: string) => {
    const p = order.get(outerId.get(id)!)!;
    return beside === "right" ? p.x : p.y;
  };
  const pull = new Map<string, -1 | 1>();
  for (const e of edges) {
    if (outerId.get(e.from) === outerId.get(e.to)) continue;
    const side = Math.sign(place(e.to) - place(e.from)) as -1 | 0 | 1;
    if (!side) continue;
    pull.set(e.from, side);
    if (!pull.has(e.to)) pull.set(e.to, -side as -1 | 1);
  }
  const inner = new Map(flow.groups.map((g) => [g.id, layoutLayered(inGroup(g.id).map((x) => ({ id: x.id, ...sizeOf(x) })), edges, flow.direction, pull)] as const));
  const outerNodes = [
    ...flow.groups.map((g) => {
      const b = boxOf(inner.get(g.id)!.values());
      return { id: g.id, w: b.w + GROUP_PAD * 2, h: b.h + GROUP_PAD * 2 };
    }),
    ...inGroup(null).map((x) => ({ id: x.id, ...sizeOf(x) })),
  ];
  const outerEdges = edges.map((e) => ({ ...e, from: outerId.get(e.from)!, to: outerId.get(e.to)! })).filter((e) => e.from !== e.to);
  // Subgraphs beside each other read better across the flow than along it.
  const places = layoutLayered(outerNodes, outerEdges, beside);
  spread(places, CLUSTER_GAP - GAP_ALONG, flow.direction === "down" ? "x" : "y");
  // Columns of clusters (rows, when it runs across), each starting at the same line.
  const along = flow.direction === "down" ? "x" : "y";
  const across = along === "x" ? "y" : "x";
  const long = along === "x" ? "w" : "h";
  const deep = along === "x" ? "h" : "w";
  const columns = new Map<number, string[]>();
  for (const [id, p] of [...places].sort((a, b) => a[1][across] - b[1][across])) {
    const at = Math.round(p[along] + p[long] / 2);
    columns.set(at, [...(columns.get(at) ?? []), id]);
  }
  const nodes = new Map<string, Placed>();
  const groups = new Map<string, Placed>();
  const ordered = [...columns].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids);
  for (const ids of ordered) {
    let next = 0;
    for (const id of ids.filter((x) => inner.has(x))) {
      const p = places.get(id)!;
      const at = { ...p, [across]: next };
      next += p[deep] + CLUSTER_GAP;
      groups.set(id, at);
      const b = boxOf(inner.get(id)!.values());
      for (const [node, q] of inner.get(id)!) nodes.set(node, { ...q, x: q.x - b.x + at.x + GROUP_PAD, y: q.y - b.y + at.y + GROUP_PAD });
    }
  }
  // What's in no cluster: level with what it's joined to, under whatever's in its column.
  for (const ids of ordered) {
    let floor = Math.max(-Infinity, ...ids.filter((x) => groups.has(x)).map((x) => groups.get(x)![across] + groups.get(x)![deep] + GAP_ACROSS));
    for (const id of ids.filter((x) => !inner.has(x))) {
      const p = places.get(id)!;
      const joined = flow.edges.flatMap((e) => (e.from === id ? [e.to] : e.to === id ? [e.from] : [])).flatMap((x) => nodes.get(x) ?? []);
      const middle = joined.length ? Math.min(...joined.map((q) => q[across] + q[deep] / 2)) : p[deep] / 2 + GROUP_PAD;
      const start = Math.max(floor, middle - p[deep] / 2);
      nodes.set(id, { ...p, [across]: start });
      floor = start + p[deep] + GAP_ACROSS;
    }
  }
  return { nodes, groups };
}

/** A little more room between columns (or rows) of clusters, for the lines between them. */
function spread(places: Map<string, Placed>, extra: number, axis: "x" | "y"): void {
  const starts = [...new Set([...places.values()].map((p) => Math.round(p[axis] + (axis === "x" ? p.w : p.h) / 2)))].sort((a, b) => a - b);
  for (const p of places.values()) p[axis] += starts.indexOf(Math.round(p[axis] + (axis === "x" ? p.w : p.h) / 2)) * extra;
}
