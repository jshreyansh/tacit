import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  listBridgeTools,
  listToolsOf,
  McpServer,
  type ListedTool,
} from "../tacit-bridge/src/list-tools.ts";

/**
 * Every bridge tool's input schema, checked against what each vendor's model
 * API accepts, as the schema actually leaves the bridge (after the MCP SDK's
 * zod → JSON Schema conversion, via tools/list).
 *
 * Why: an MCP server that works in Claude can fail in another agent because
 * each vendor rejects different schema shapes, and the failure shows up on a
 * user's machine, not here. Tacit's tools now reach Claude, Codex, OpenCode and
 * Gemini (T1), so one careless schema, or an SDK/zod update that changes the
 * output, would break every non-Claude agent at once.
 *
 * Each rule names where we know it from. **Enforced** rules cover the agents
 * Tacit ships and fail the suite. **Advisory** rules cover vendors not shipped
 * yet (Kimi, local llama.cpp models); they're printed on every run so the gaps
 * are known when those are picked up, and never fail it.
 */

type Json = Record<string, unknown>;

interface Rule {
  id: string;
  vendor: string;
  source: string;
  level: "enforced" | "advisory";
  /** One line per violation; empty when the tool passes. */
  check: (tool: ListedTool) => string[];
}

/** Every schema reachable from `schema`, with a readable path for messages. */
function walk(schema: unknown, path = "input"): Array<{ node: Json; path: string }> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const node = schema as Json;
  const out = [{ node, path }];
  const properties = node.properties as Json | undefined;
  if (properties && typeof properties === "object") {
    for (const [key, child] of Object.entries(properties)) {
      out.push(...walk(child, `${path}.${key}`));
    }
  }
  if (node.items) out.push(...walk(node.items, `${path}[]`));
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    out.push(...walk(node.additionalProperties, `${path}{*}`));
  }
  for (const combinator of ["anyOf", "oneOf", "allOf"]) {
    const branches = node[combinator];
    if (Array.isArray(branches)) {
      branches.forEach((branch, i) => out.push(...walk(branch, `${path}.${combinator}[${i}]`)));
    }
  }
  return out;
}

function isObjectSchema(node: Json): boolean {
  return node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));
}

/**
 * Tools that take no arguments on purpose. Anything else that advertises no
 * inputs has lost them: this SDK turns a whole-input `z.union` into
 * `{ type: "object", properties: {} }` without an error, and the tool then
 * runs with no parameters for every agent. Adding a no-argument tool means
 * adding it here, deliberately.
 */
const NO_ARGUMENT_TOOLS = new Set([
  "browser_read",
  "list_nodes",
  "get_workspace_summary",
  "list_browser_profiles",
]);

const PROPERTY_KEY = /^[a-zA-Z0-9_.-]{1,64}$/;
const TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
/** The longest prefix an agent adds before the tool name (Claude Code's). */
const LONGEST_TOOL_PREFIX = "mcp__tacit__";

const RULES: Rule[] = [
  {
    id: "root-is-object",
    vendor: "all",
    source: "MCP spec; Anthropic input_schema",
    level: "enforced",
    check: ({ inputSchema }) =>
      inputSchema.type === "object" ? [] : [`root type is ${JSON.stringify(inputSchema.type)}, not "object"`],
  },
  {
    id: "no-lost-inputs",
    vendor: "all",
    source: "found in T2: the SDK silently empties a whole-input z.union",
    level: "enforced",
    check: ({ name, inputSchema }) => {
      const properties = (inputSchema.properties ?? {}) as Json;
      if (Object.keys(properties).length > 0 || NO_ARGUMENT_TOOLS.has(name)) return [];
      return [
        "advertises no inputs; if that is intended, add it to NO_ARGUMENT_TOOLS, otherwise its schema was lost (a whole-input z.union does this)",
      ];
    },
  },
  {
    id: "no-top-level-combinators",
    vendor: "Codex / OpenAI",
    source: "Hermes tools/schema_sanitizer.py: Codex rejects top-level combinators",
    level: "enforced",
    check: ({ inputSchema }) =>
      ["anyOf", "oneOf", "allOf"].filter((k) => k in inputSchema).map((k) => `top-level ${k}`),
  },
  {
    id: "no-nullable-top-level",
    vendor: "Anthropic",
    source: "Hermes tools/schema_sanitizer.py: Anthropic rejects a nullable anyOf at the top of input_schema",
    level: "enforced",
    check: ({ inputSchema }) => {
      const type = inputSchema.type;
      return Array.isArray(type) && type.includes("null") ? ["root type includes null"] : [];
    },
  },
  {
    id: "property-keys",
    vendor: "Anthropic",
    source: "Hermes tools/schema_sanitizer.py: property keys must match ^[a-zA-Z0-9_.-]{1,64}$",
    level: "enforced",
    check: ({ inputSchema }) =>
      walk(inputSchema).flatMap(({ node, path }) =>
        Object.keys((node.properties ?? {}) as Json)
          .filter((key) => !PROPERTY_KEY.test(key))
          .map((key) => `${path}: property key ${JSON.stringify(key)}`),
      ),
  },
  {
    id: "tool-name",
    vendor: "Anthropic, OpenAI",
    source: "function names: ^[a-zA-Z0-9_-]+$, at most 64 characters",
    level: "enforced",
    check: ({ name }) => {
      const full = `${LONGEST_TOOL_PREFIX}${name}`;
      const problems: string[] = [];
      if (!TOOL_NAME.test(name)) problems.push(`name has characters outside [a-zA-Z0-9_-]`);
      if (full.length > 64) problems.push(`"${full}" is ${full.length} characters, over 64`);
      return problems;
    },
  },
  {
    id: "type-arrays",
    vendor: "Gemini",
    source: "Gemini CLI 0.46.0 source: it normalises only two-element [T, \"null\"] type arrays",
    level: "enforced",
    check: ({ inputSchema }) =>
      walk(inputSchema)
        .filter(({ node }) => Array.isArray(node.type))
        .filter(({ node }) => {
          const types = node.type as unknown[];
          return !(types.length === 2 && types.includes("null") && types.every((t) => typeof t === "string"));
        })
        .map(({ node, path }) => `${path}: type ${JSON.stringify(node.type)}`),
  },
  {
    id: "kimi-required-and-types",
    vendor: "Moonshot / Kimi",
    source: "Hermes agent/moonshot_schema.py",
    level: "advisory",
    check: ({ inputSchema }) =>
      walk(inputSchema).flatMap(({ node, path }) => {
        const problems: string[] = [];
        if (isObjectSchema(node) && !Array.isArray(node.required)) problems.push(`${path}: object has no required array`);
        if (path !== "input" && !("type" in node) && !node.anyOf && !node.oneOf && !node.allOf) {
          problems.push(`${path}: no type`);
        }
        return problems;
      }),
  },
  {
    id: "llama-object-properties",
    vendor: "llama.cpp",
    source: "Hermes tools/schema_sanitizer.py: grammar conversion fails on an object without properties",
    level: "advisory",
    check: ({ inputSchema }) =>
      walk(inputSchema)
        .filter(({ node }) => isObjectSchema(node) && !node.properties && !node.additionalProperties)
        .map(({ path }) => `${path}: object has no properties`),
  },
];

function violations(tools: ListedTool[], level: Rule["level"]): string[] {
  return RULES.filter((rule) => rule.level === level).flatMap((rule) =>
    tools.flatMap((tool) =>
      rule.check(tool).map((problem) => `${tool.name} breaks ${rule.id} (${rule.vendor}): ${problem}`),
    ),
  );
}

let bridgeTools: ListedTool[];
test.before(async () => {
  bridgeTools = await listBridgeTools();
});

test("the bridge lists its tools in-process, as an agent receives them", () => {
  assert.equal(bridgeTools.length, 17);
  for (const tool of bridgeTools) {
    assert.ok(tool.inputSchema && typeof tool.inputSchema === "object", tool.name);
  }
});

test("every bridge tool passes every rule for the agents Tacit ships", () => {
  assert.deepEqual(violations(bridgeTools, "enforced"), []);
});

test("advisory findings for vendors not shipped yet are reported, not failed", (t) => {
  const findings = violations(bridgeTools, "advisory");
  for (const finding of findings) t.diagnostic(`advisory: ${finding}`);
  // Known on 26 Sep (Kimi): six tools send no required array, and
  // emit_event.payload's values carry no type. Not a failure while Kimi is
  // deferred (SHR-106).
  assert.ok(Array.isArray(findings));
});

test("every no-argument tool on the list still exists", () => {
  const names = new Set(bridgeTools.map((tool) => tool.name));
  for (const name of NO_ARGUMENT_TOOLS) assert.ok(names.has(name), `${name} is listed but gone`);
});

// ── Each rule is proven to fail ────────────────────────────────────────────

function fixture(name: string, inputSchema: Json): ListedTool {
  return { name, inputSchema };
}

const BAD_FIXTURES: Record<string, ListedTool> = {
  "root-is-object": fixture("bad_root", { type: "string" }),
  "no-lost-inputs": fixture("lost_inputs", { type: "object", properties: {} }),
  "no-top-level-combinators": fixture("union_root", {
    type: "object",
    properties: { a: { type: "string" } },
    anyOf: [{ required: ["a"] }],
  }),
  "no-nullable-top-level": fixture("nullable_root", {
    type: ["object", "null"],
    properties: { a: { type: "string" } },
  }),
  "property-keys": fixture("bad_key", { type: "object", properties: { "has space": { type: "string" } } }),
  "tool-name": fixture("x".repeat(60), { type: "object", properties: { a: { type: "string" } } }),
  "type-arrays": fixture("three_types", {
    type: "object",
    properties: { a: { type: ["string", "number", "null"] } },
  }),
  "kimi-required-and-types": fixture("kimi_gap", { type: "object", properties: { a: {} } }),
  "llama-object-properties": fixture("bare_object", {
    type: "object",
    properties: { a: { type: "object" } },
    required: ["a"],
  }),
};

test("every rule has a known-bad example", () => {
  assert.deepEqual(Object.keys(BAD_FIXTURES).sort(), RULES.map((rule) => rule.id).sort());
});

for (const rule of RULES) {
  test(`${rule.id} catches its bad example and names the tool and rule`, () => {
    const bad = BAD_FIXTURES[rule.id];
    const found = violations([bad], rule.level).filter((v) => v.includes(`breaks ${rule.id} `));
    assert.ok(found.length > 0, `${rule.id} did not fire`);
    assert.match(found[0], new RegExp(`^${bad.name} breaks ${rule.id} \\(`));
  });
}

// ── What the SDK really emits ─────────────────────────────────────────────

test("a whole-input z.union loses its inputs silently, and no-lost-inputs catches it", async () => {
  const server = new McpServer({ name: "scratch", version: "0" });
  server.registerTool(
    "scratch_union",
    {
      description: "scratch",
      // Not a shape: the SDK accepts it, then lists the tool with no inputs.
      inputSchema: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) as never,
    },
    async () => ({ content: [] }),
  );
  const [tool] = await listToolsOf(server);
  assert.deepEqual(tool.inputSchema.properties, {});
  assert.ok(violations([tool], "enforced").some((v) => v.startsWith("scratch_union breaks no-lost-inputs")));
});

test("a union or nullable inside a property is emitted as a nested anyOf, which every shipped agent accepts", async () => {
  const server = new McpServer({ name: "scratch", version: "0" });
  server.registerTool(
    "scratch_nested",
    {
      description: "scratch",
      inputSchema: { v: z.union([z.string(), z.number()]), n: z.string().nullable() },
    },
    async () => ({ content: [] }),
  );
  const [tool] = await listToolsOf(server);
  assert.deepEqual(violations([tool], "enforced"), []);
});
