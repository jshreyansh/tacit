import test from "node:test";
import assert from "node:assert/strict";
import { layoutFlow, parseFlow, type Flow, type FlowNode } from "../src/board/flowchart";

const ok = (s: string) => {
  const f = parseFlow(s);
  assert.ok(!("error" in f), "error" in f ? f.error : "");
  return f as Flow;
};
const edges = (f: Flow) => f.edges.map((e) => `${e.from}${e.ends === "both" ? "<" : ""}${e.dashed ? "~" : "-"}${e.ends === "none" ? "" : ">"}${e.to}${e.label ? `:${e.label}` : ""}`);

test("Mermaid's nodes, shapes and arrows", () => {
  const f = ok(`flowchart LR
    A[Start] --> B{Password right?}
    B -->|yes| C((Home)); B -- no, try again --> A
    C -.-> D([Log out])
    D ==> E["Say (bye) [now]"] & F
    F --- G <--> H
    G -. maybe .-> H
    %% a comment
    style A fill:#f00
    classDef x fill:#fff`);
  assert.equal(f.direction, "right");
  assert.deepEqual(edges(f), ["A->B", "B->C:yes", "B->A:no, try again", "C~>D", "D->E", "D->F", "F-G", "G<->H", "G~>H:maybe"]);
  const by = Object.fromEntries(f.nodes.map((x) => [x.id, x]));
  assert.deepEqual([by.A.text, by.B.shape, by.C.shape, by.D.shape, by.E.text, by.F.text], ["Start", "diamond", "ellipse", "ellipse", "Say (bye) [now]", "F"]);
});

test("no spaces, line breaks, fences, other scripts, a node described later", () => {
  const f = ok("```mermaid\ngraph TD\nA-->B-->|x|C\nB[Two<br/>lines]\n登录 --> 注册[注册账号]\n```");
  assert.deepEqual(edges(f), ["A->B", "B->C:x", "登录->注册"]);
  assert.equal(f.nodes.find((x) => x.id === "B")!.text, "Two\nlines");
  assert.equal(f.nodes.find((x) => x.id === "注册")!.text, "注册账号");
  assert.equal(f.direction, "down");
});

test("subgraphs, and one nothing is in", () => {
  const f = ok("flowchart TD\nsubgraph one [Sign up]\nA-->B\nend\nsubgraph Log in\nC-->D\nend\nsubgraph Empty\nend\nB-->C\nX-->A");
  assert.deepEqual(f.groups.map((g) => g.title), ["Sign up", "Log in"]);
  assert.deepEqual(f.nodes.map((x) => `${x.id}:${x.group}`), ["A:g1", "B:g1", "C:g2", "D:g2", "X:null"]);
});

test("what isn't a flowchart says which line", () => {
  for (const bad of ["A -->", "just some words here", "A --> --> B", "A[never closed", ""]) {
    const f = parseFlow(bad);
    assert.ok("error" in f, bad);
  }
  assert.match((parseFlow("A-->B\nthis is a sentence") as { error: string }).error, /"this is a sentence"/);
});

const size = (n: FlowNode) => ({ w: n.shape === "diamond" ? 240 : 200, h: 90 });
const plan = (s: string) => {
  const f = ok(s);
  return { f, p: layoutFlow(f, size, (l) => l.length * 9) };
};
const overlapping = (boxes: Iterable<{ x: number; y: number; w: number; h: number }>) => {
  const list = [...boxes];
  return list.flatMap((a, i) => list.slice(i + 1).filter((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)).length;
};

const LOGIN = `flowchart TD
subgraph signup [Sign up]
  s1[Enter email and password] --> s2{Email valid?}
  s2 -->|no| s3[Show email error] --> s1
  s2 -->|yes| s4{Already registered?}
  s4 -->|yes| s5[Suggest logging in]
  s4 -->|no| s6[Create account] --> s7[Send verification email] --> s8{Link clicked?}
  s8 -->|no| s9[Resend] --> s8
  s8 -->|yes| s10((Verified))
end
subgraph login [Log in]
  l1[Enter email and password] --> l2{Match?}
  l2 -->|no| l3{5 tries?}
  l3 -->|no| l1
  l3 -->|yes| l4[Lock for 15 minutes]
  l2 -->|yes| l5[Start session] --> l6((Home))
end
s5 --> l1
s10 --> l1`;

test("nothing is placed over anything else, along the flow, with loops", () => {
  for (const source of [LOGIN, LOGIN.replace("TD", "LR"), "A-->B\nA-->C\nA-->D\nB-->E\nC-->E\nD-->E\nE-->A\nA-->E", "A-->A\nB", "A-->B\nB-->A"]) {
    const { p } = plan(source);
    assert.equal(overlapping(p.nodes.values()), 0, source);
    assert.equal(overlapping(p.groups.values()), 0, source);
    for (const at of p.nodes.values()) assert.ok(Number.isFinite(at.x + at.y));
  }
  const { p } = plan("A-->B-->C");
  assert.ok(p.nodes.get("A")!.y < p.nodes.get("B")!.y && p.nodes.get("B")!.y < p.nodes.get("C")!.y);
  assert.equal(Math.round(p.nodes.get("A")!.x), Math.round(p.nodes.get("C")!.x), "a straight chain is straight");
  const r = plan("graph LR\nA-->B").p;
  assert.ok(r.nodes.get("A")!.x < r.nodes.get("B")!.x);
});

test("a subgraph goes round its own nodes and no others", () => {
  const { f, p } = plan(LOGIN);
  for (const node of f.nodes) {
    const at = p.nodes.get(node.id)!;
    for (const [id, g] of p.groups) {
      const inside = at.x >= g.x && at.y >= g.y && at.x + at.w <= g.x + g.w && at.y + at.h <= g.y + g.h;
      assert.equal(inside, node.group === id, `${node.id} in ${id}`);
    }
  }
});

test("a big one is quick", () => {
  const lines = Array.from({ length: 180 }, (_, i) => `n${i} --> n${(i * 7 + 3) % 180}\nn${i} --> n${i + 1}`).join("\n");
  const from = performance.now();
  const { p } = plan(lines);
  assert.ok(performance.now() - from < 4000, `${Math.round(performance.now() - from)} ms`);
  assert.equal(overlapping(p.nodes.values()), 0);
});
