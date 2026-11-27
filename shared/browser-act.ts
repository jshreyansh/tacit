/**
 * The steps an agent sends in one browser_act call, checked before any runs.
 * Up to 20, in order, stopping at the first that fails. Pure.
 */

export type Target = { ref: string } | { x: number; y: number; screenshot?: string };

export type ActStep =
  | ({ do: "click"; button?: "left" | "right" | "middle"; count?: number } & Target)
  | ({ do: "hover" } & Target)
  | { do: "fill"; ref: string; text: string }
  | { do: "type"; text: string; ref?: string }
  | { do: "press"; keys: string[] }
  | { do: "paste"; text: string; ref?: string }
  | { do: "select"; ref: string; values: string[] }
  | { do: "check"; ref: string; checked: boolean }
  | { do: "scroll"; ref?: string; dx?: number; dy?: number }
  | { do: "drag"; from: Target; to: Target }
  | { do: "upload"; ref: string; paths: string[] }
  | { do: "wait"; ms?: number; text?: string; gone?: string; download?: boolean };

export const MAX_STEPS = 20;
const MAX_TEXT = 20_000;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isRef = (v: unknown): v is string => typeof v === "string" && /^(f\d{1,4})?e\d{1,7}$/.test(v.trim());
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStrs = (v: unknown, max = 50): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= max && v.every((s) => typeof s === "string" && s.length <= 200);

function target(v: unknown, where: string): string | null {
  if (!isObj(v)) return `${where} needs a ref (from browser_snapshot) or an x and y`;
  if (v.ref !== undefined) return isRef(v.ref) ? null : `${where}: "${String(v.ref)}" isn't a ref like e12 or f1e3`;
  if (isNum(v.x) && isNum(v.y)) return v.screenshot === undefined || typeof v.screenshot === "string" ? null : `${where}: screenshot must be a screenshot's id`;
  return `${where} needs a ref (from browser_snapshot) or an x and y`;
}

/** Null when the steps are fine; otherwise what's wrong, said so the agent can fix it. */
const chordParts = (chord: string) => chord.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
const COMMAND_MODS = new Set(["meta", "cmd", "command", "super", "ctrl", "control", "controlormeta", "mod", "alt", "option", "opt"]);

/** A key that puts a character in, as typing does: one character, with Shift at most. */
export function typesCharacter(chord: string): boolean {
  const parts = chordParts(chord);
  const key = parts[parts.length - 1] ?? "";
  return (Array.from(key).length === 1 || key === "space") && !parts.slice(0, -1).some((m) => COMMAND_MODS.has(m));
}

/**
 * A paste of whatever is on the person's clipboard (Cmd+V, Ctrl+V, Shift+Insert). Agents
 * paste their own text with the paste step instead; the person's clipboard isn't theirs.
 */
export function isPasteChord(chord: string): boolean {
  const parts = chordParts(chord);
  const key = parts[parts.length - 1] ?? "";
  const mods = parts.slice(0, -1);
  return (key === "v" && mods.some((m) => m !== "shift" && m !== "alt" && m !== "option" && m !== "opt" && COMMAND_MODS.has(m))) || (key === "insert" && mods.includes("shift"));
}

export function validateSteps(steps: unknown): string | null {
  if (!Array.isArray(steps) || steps.length === 0) return "steps must be a list of one or more steps";
  if (steps.length > MAX_STEPS) return `At most ${MAX_STEPS} steps in one call`;
  for (const [i, s] of steps.entries()) {
    const at = `Step ${i + 1}`;
    if (!isObj(s) || typeof s.do !== "string") return `${at} needs "do" (click, hover, fill, type, press, paste, select, check, scroll, drag, upload, wait)`;
    switch (s.do) {
      case "click": {
        const e = target(s, `${at} (click)`);
        if (e) return e;
        if (s.button !== undefined && !["left", "right", "middle"].includes(String(s.button))) return `${at}: button is left, right or middle`;
        if (s.count !== undefined && !(isNum(s.count) && s.count >= 1 && s.count <= 3)) return `${at}: count is 1, 2 or 3`;
        break;
      }
      case "hover": {
        const e = target(s, `${at} (hover)`);
        if (e) return e;
        break;
      }
      case "fill":
        if (!isRef(s.ref)) return `${at} (fill) needs the ref of the field`;
        if (typeof s.text !== "string" || s.text.length > MAX_TEXT) return `${at} (fill) needs text, up to ${MAX_TEXT} characters`;
        break;
      case "type":
        if (typeof s.text !== "string" || !s.text || s.text.length > MAX_TEXT) return `${at} (type) needs text, up to ${MAX_TEXT} characters`;
        if (s.ref !== undefined && !isRef(s.ref)) return `${at} (type): ref must be like e12`;
        break;
      case "press":
        if (!isStrs(s.keys, 30)) return `${at} (press) needs keys, like ["Enter"] or ["Meta+A", "Delete"]`;
        if ((s.keys as string[]).some(isPasteChord)) return `${at} (press): pasting the person's clipboard isn't allowed. To paste text, use {"do":"paste","text":"..."}.`;
        break;
      case "paste":
        if (typeof s.text !== "string" || !s.text || s.text.length > 200_000) return `${at} (paste) needs text`;
        if (s.ref !== undefined && !isRef(s.ref)) return `${at} (paste): ref must be like e12`;
        break;
      case "select":
        if (!isRef(s.ref)) return `${at} (select) needs the ref of the list`;
        if (!isStrs(s.values)) return `${at} (select) needs values: the options' text or values`;
        break;
      case "check":
        if (!isRef(s.ref)) return `${at} (check) needs the ref of the checkbox`;
        if (typeof s.checked !== "boolean") return `${at} (check) needs checked: true or false`;
        break;
      case "scroll":
        if (s.ref !== undefined && !isRef(s.ref)) return `${at} (scroll): ref must be like e12`;
        if (s.dx !== undefined && !isNum(s.dx)) return `${at} (scroll): dx is a number of pixels`;
        if (s.dy !== undefined && !isNum(s.dy)) return `${at} (scroll): dy is a number of pixels`;
        break;
      case "drag": {
        const a = target(s.from, `${at} (drag) from`);
        if (a) return a;
        const b = target(s.to, `${at} (drag) to`);
        if (b) return b;
        break;
      }
      case "upload":
        if (!isRef(s.ref)) return `${at} (upload) needs the ref of the file picker`;
        if (!isStrs(s.paths, 20)) return `${at} (upload) needs paths: files in this workdesk's folders`;
        break;
      case "wait":
        if (s.ms !== undefined && !(isNum(s.ms) && s.ms >= 0 && s.ms <= 10_000)) return `${at} (wait): ms is 0 to 10000`;
        if (s.download !== undefined && s.download !== true) return `${at} (wait): download is true or left out`;
        if (s.ms === undefined && typeof s.text !== "string" && typeof s.gone !== "string" && s.download !== true) return `${at} (wait) needs ms, text, gone or download`;
        break;
      default:
        return `${at}: "${s.do}" isn't a step (click, hover, fill, type, press, paste, select, check, scroll, drag, upload, wait)`;
    }
  }
  return null;
}

/** Steps that change nothing on the page. */
export const isReadOnlyStep = (s: ActStep): boolean => s.do === "wait" || s.do === "hover";
