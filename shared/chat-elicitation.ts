import type { ChatAnswers, ChatQuestion } from "./chat-events";

/**
 * An MCP server asking the person something mid-turn (MCP `elicitation`),
 * as both agents pass it on: Claude as a `control_request` of subtype
 * `elicitation`, Codex as `mcpServer/elicitation/request`. Either way it's a
 * message and a form (a flat JSON schema of text, number, yes/no and
 * choice fields), or a link to finish something at. The chat asks it with
 * its question form, a question per field; the answer goes back as
 * `accept` with the values typed to the schema, and Skip declines. Pure.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export interface ElicitationField {
  key: string;
  title: string;
  description: string;
  kind: "text" | "number" | "integer" | "boolean" | "choice" | "choices";
  /** For choices: what's shown, and what goes back. */
  options: { label: string; value: string }[];
  required: boolean;
}

export interface Elicitation {
  server: string;
  message: string;
  /** `url`: finish something at a link (sign in, pay), then say it's done. */
  url: string | null;
  fields: ElicitationField[];
}

const CONFIRM_ID = "__confirm";

/** The answers the form itself offers (the agents' own options are in their words too). */
export const ELICITATION_LABELS = { yes: "Yes", no: "No", done: "Done", accept: "Continue" } as const;

function optionsOf(schema: Json): { label: string; value: string }[] {
  const items = isObject(schema.items) ? schema.items : null;
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(items?.anyOf) ? items.anyOf : null;
  if (oneOf) {
    return oneOf
      .filter((o): o is Json => isObject(o) && typeof o.const === "string")
      .map((o) => ({ value: o.const as string, label: typeof o.title === "string" ? o.title : (o.const as string) }));
  }
  const values = Array.isArray(schema.enum) ? schema.enum : Array.isArray(items?.enum) ? items.enum : [];
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  return values
    .filter((v): v is string => typeof v === "string")
    .map((value, i) => ({ value, label: typeof names[i] === "string" ? (names[i] as string) : value }));
}

/** The form an elicitation asks for. `order`: Claude's own field order, when it gives one. */
export function elicitationOf(input: { server: unknown; message: unknown; url?: unknown; schema?: unknown; order?: unknown }): Elicitation {
  const schema = isObject(input.schema) ? input.schema : {};
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : []);
  const order = Array.isArray(input.order) ? input.order.filter((k): k is string => typeof k === "string" && k in properties) : [];
  const keys = [...order, ...Object.keys(properties).filter((k) => !order.includes(k))];
  const fields = keys
    .map((key): ElicitationField | null => {
      const field = properties[key];
      if (!isObject(field)) return null;
      const options = optionsOf(field);
      const kind: ElicitationField["kind"] =
        field.type === "array" ? "choices" : options.length > 0 ? "choice" : field.type === "boolean" ? "boolean" : field.type === "integer" ? "integer" : field.type === "number" ? "number" : "text";
      return {
        key,
        title: typeof field.title === "string" ? field.title : key,
        description: typeof field.description === "string" ? field.description : "",
        kind,
        options,
        required: required.has(key),
      };
    })
    .filter((f): f is ElicitationField => f !== null);
  return {
    server: typeof input.server === "string" ? input.server : "",
    message: typeof input.message === "string" ? input.message : "",
    url: typeof input.url === "string" && input.url ? input.url : null,
    fields,
  };
}

/** The form as the chat's questions: one per field, the server's message on the first. */
export function elicitationQuestions(e: Elicitation): ChatQuestion[] {
  const labels = ELICITATION_LABELS;
  const header = e.server;
  if (e.url) {
    return [
      { id: CONFIRM_ID, header, question: `${e.message}\n${e.url}`, options: [{ label: labels.done }], multiSelect: false, allowOther: false, secret: false },
    ];
  }
  if (e.fields.length === 0) {
    return [{ id: CONFIRM_ID, header, question: e.message, options: [{ label: labels.accept }], multiSelect: false, allowOther: false, secret: false }];
  }
  return e.fields.map((f, i) => {
    const label = [f.title, f.description].filter(Boolean).join(" — ");
    const question = i === 0 && e.message ? `${e.message}\n\n${label}` : label;
    const options =
      f.kind === "boolean"
        ? [{ label: labels.yes }, { label: labels.no }]
        : f.kind === "choice" || f.kind === "choices"
          ? f.options.map((o) => ({ label: o.label }))
          : null;
    return { id: f.key, header: header || f.title, question, options, multiSelect: f.kind === "choices", allowOther: false, secret: false };
  });
}

/**
 * What goes back: `accept` with each answered field typed to its schema
 * (a choice by its value, yes/no as true/false, numbers as numbers), or
 * `decline` when skipped.
 */
export function elicitationResult(
  e: Elicitation,
  answers: ChatAnswers | null,
): { action: "accept" | "decline"; content: Record<string, unknown> | null } {
  const labels = ELICITATION_LABELS;
  if (answers === null) return { action: "decline", content: null };
  const content: Record<string, unknown> = {};
  for (const f of e.fields) {
    const picked = answers[f.key];
    if (!picked || picked.length === 0) continue;
    const valueOf = (label: string) => f.options.find((o) => o.label === label)?.value ?? label;
    if (f.kind === "choices") content[f.key] = picked.map(valueOf);
    else if (f.kind === "choice") content[f.key] = valueOf(picked[0]);
    else if (f.kind === "boolean") content[f.key] = picked[0] === labels.yes;
    else if (f.kind === "number" || f.kind === "integer") {
      const n = f.kind === "integer" ? Number.parseInt(picked[0], 10) : Number(picked[0]);
      if (Number.isFinite(n)) content[f.key] = n;
    } else content[f.key] = picked[0];
  }
  return { action: "accept", content: e.url || e.fields.length === 0 ? null : content };
}
