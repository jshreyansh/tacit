/**
 * A database drawn as Mermaid's erDiagram: each table with a row for each
 * field, and what joins them. Free of React and the DOM.
 */
export interface ErField {
  name: string;
  type: string;
  keys: string;
  note: string;
}
export interface ErTable {
  id: string;
  title: string;
  fields: ErField[];
}
export interface ErLink {
  from: string;
  to: string;
  label: string;
  dashed: boolean;
}
export interface Er {
  tables: ErTable[];
  links: ErLink[];
}

export const isErDiagram = (source: string): boolean => /^\s*(?:```(?:mermaid)?\s*)?erDiagram\b/.test(source);

const NAME = `(?:"[^"]+"|[\\p{L}\\p{N}_][\\p{L}\\p{N}_.-]*)`;
const RELATION = new RegExp(`^(${NAME})\\s+([|}o{]{1,2})(--|\\.\\.)([|}o{]{1,2})\\s+(${NAME})\\s*(?::\\s*(.+))?$`, "u");
const ENTITY = new RegExp(`^(${NAME})(?:\\s*\\[([^\\]]+)\\])?\\s*(\\{)?\\s*(\\})?$`, "u");
const bare = (s: string) => s.trim().replace(/^"([\s\S]*)"$/, "$1").trim();

export function parseEr(source: string): Er | { error: string } {
  const er: Er = { tables: [], links: [] };
  const byId = new Map<string, ErTable>();
  const table = (name: string): ErTable => {
    const id = bare(name);
    let t = byId.get(id);
    if (!t) {
      t = { id, title: id, fields: [] };
      byId.set(id, t);
      er.tables.push(t);
    }
    return t;
  };
  let open: ErTable | null = null;
  for (const raw of source.replace(/```(?:mermaid)?/g, "").split("\n")) {
    const line = raw.trim().replace(/;$/, "");
    if (!line || line.startsWith("%%") || /^erDiagram$/.test(line) || /^(direction|title|accTitle|accDescr|style|classDef|class)\b(?!\s*\{)/.test(line)) continue;
    if (open) {
      if (line === "}") {
        open = null;
        continue;
      }
      const m = /^(\S+)(?:\s+("[^"]+"|[^\s"]+))?((?:\s*,?\s*(?:PK|FK|UK|UNIQUE)\b)*)\s*("[^"]*")?\s*$/i.exec(line);
      if (!m) return { error: `This field isn't one Tacit understands: "${line.slice(0, 120)}". Write fields as: type name PK "a note".` };
      open.fields.push({ type: m[2] ? m[1] : "", name: bare(m[2] ?? m[1]), keys: m[3].trim().replace(/\s*,\s*|\s+/g, " ").toUpperCase(), note: m[4] ? bare(m[4]) : "" });
      continue;
    }
    const r = RELATION.exec(line);
    if (r) {
      const many = (s: string) => /[{}]/.test(s);
      const size = `${many(r[2]) ? "N" : "1"}:${many(r[4]) ? "N" : "1"}`;
      er.links.push({ from: table(r[1]).id, to: table(r[5]).id, label: r[6] && bare(r[6]) ? `${bare(r[6])} ${size}` : size, dashed: r[3] === ".." });
      continue;
    }
    const e = ENTITY.exec(line);
    if (!e) return { error: `This line isn't an erDiagram line Tacit understands: "${line.slice(0, 120)}". Write USERS ||--o{ SESSIONS : has, and USERS { uuid id PK }.` };
    const t = table(e[1]);
    if (e[2]) t.title = bare(e[2]);
    if (e[3] && !e[4]) open = t;
  }
  if (!er.tables.length) return { error: "The erDiagram has no tables. Write USERS { uuid id PK } and USERS ||--o{ SESSIONS : has." };
  return er;
}
