/**
 * Keys as a keyboard sends them, for CDP Input.dispatchKeyEvent: what a page
 * sees from a real key press (a trusted keydown, the character, a keyup). Pure.
 *
 * Excel Online's grid takes characters only as key presses, not as inserted
 * text; a chord like Meta+A needs its editing command named on macOS, since a
 * dispatched key doesn't go through the menu that would run it.
 */

export interface KeyEventParams {
  type: "keyDown" | "rawKeyDown" | "keyUp" | "char";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
  commands?: string[];
}

const NAMED: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Insert: { code: "Insert", vk: 45 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Space: { code: "Space", vk: 32, text: " " },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, vk: 112 + i }])),
};

const ALIASES: Record<string, string> = {
  enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape", backspace: "Backspace", delete: "Delete", del: "Delete",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", space: "Space", insert: "Insert",
};

export const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
const MOD_NAMES: Record<string, keyof typeof MOD> = {
  alt: "Alt", option: "Alt", opt: "Alt", ctrl: "Control", control: "Control", meta: "Meta", cmd: "Meta", command: "Meta", super: "Meta", shift: "Shift",
};
const MOD_KEYS: Record<keyof typeof MOD, { key: string; code: string; vk: number }> = {
  Alt: { key: "Alt", code: "AltLeft", vk: 18 },
  Control: { key: "Control", code: "ControlLeft", vk: 17 },
  Meta: { key: "Meta", code: "MetaLeft", vk: 91 },
  Shift: { key: "Shift", code: "ShiftLeft", vk: 16 },
};

/** macOS editing commands a chord runs, which a dispatched key must name. */
const MAC_COMMANDS: Record<string, string> = {
  "Meta+a": "selectAll", "Meta+c": "copy", "Meta+x": "cut", "Meta+v": "paste", "Meta+z": "undo", "Meta+Shift+z": "redo",
};

const SHIFTED: Record<string, string> = { "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "~": "`" };
const PUNCT_CODE: Record<string, [string, number]> = {
  "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219], "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222], ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], "`": ["Backquote", 192],
};

/** One character's key: its code and key code on a US layout, when it has one. */
export function charKey(ch: string): { key: string; code: string; vk: number; shift: boolean } {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, vk: ch.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, vk: ch.charCodeAt(0), shift: false };
  if (ch === " ") return { key: " ", code: "Space", vk: 32, shift: false };
  const base = SHIFTED[ch];
  if (base) {
    const [code, vk] = /[0-9]/.test(base) ? [`Digit${base}`, base.charCodeAt(0)] : PUNCT_CODE[base] ?? ["", 0];
    return { key: ch, code, vk, shift: true };
  }
  const p = PUNCT_CODE[ch];
  if (p) return { key: ch, code: p[0], vk: p[1], shift: false };
  // Anything else (accents, other scripts, emoji): the character alone.
  return { key: ch, code: "", vk: 0, shift: false };
}

/** Typing text as key presses, one character at a time. Newlines press Enter. */
export function typeEvents(text: string): KeyEventParams[] {
  const out: KeyEventParams[] = [];
  for (const ch of Array.from(text)) {
    if (ch === "\n") { out.push(...chordEvents("Enter")); continue; }
    if (ch === "\t") { out.push(...chordEvents("Tab")); continue; }
    const k = charKey(ch);
    const modifiers = k.shift ? MOD.Shift : 0;
    out.push({ type: "keyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers, text: ch, unmodifiedText: ch });
    out.push({ type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
  }
  return out;
}

export class KeyError extends Error {}

/** "Meta+Shift+Z", "Enter", "ctrl+a": the presses and releases, modifiers around the key. */
export function chordEvents(chord: string, platform: string = process.platform): KeyEventParams[] {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new KeyError(`No key in "${chord}"`);
  let keyPart = parts[parts.length - 1];
  const mods: Array<keyof typeof MOD> = [];
  for (const p of parts.slice(0, -1)) {
    const lower = p.toLowerCase();
    const m = lower === "controlormeta" || lower === "mod" ? (platform === "darwin" ? "Meta" : "Control") : MOD_NAMES[lower];
    if (!m) throw new KeyError(`"${p}" isn't a modifier (use Meta, Control, Alt or Shift)`);
    if (!mods.includes(m)) mods.push(m);
  }
  const named = NAMED[keyPart] ? keyPart : ALIASES[keyPart.toLowerCase()];
  let key: string, code: string, vk: number, text: string | undefined;
  if (named) {
    ({ code, vk, text } = NAMED[named]);
    key = named === "Space" ? " " : named;
  } else if (Array.from(keyPart).length === 1) {
    // With a command key, a letter's case doesn't matter: Meta+A is Meta+a. Shift is said when meant.
    const commandHeld = mods.some((m) => m !== "Shift");
    const ch = commandHeld && /^[A-Z]$/.test(keyPart) && !mods.includes("Shift") ? keyPart.toLowerCase() : keyPart;
    const k = charKey(ch);
    keyPart = ch;
    ({ key, code, vk } = k);
    text = keyPart;
    if (k.shift && !mods.includes("Shift")) mods.push("Shift");
  } else {
    throw new KeyError(`"${keyPart}" isn't a key name (try Enter, Tab, Escape, ArrowDown, a letter…)`);
  }
  const modifiers = mods.reduce((n, m) => n | MOD[m], 0);
  const out: KeyEventParams[] = [];
  let held = 0;
  for (const m of mods) {
    held |= MOD[m];
    out.push({ type: "rawKeyDown", key: MOD_KEYS[m].key, code: MOD_KEYS[m].code, windowsVirtualKeyCode: MOD_KEYS[m].vk, modifiers: held });
  }
  // A character only goes in when no command modifier is held.
  const typesText = text !== undefined && !(modifiers & (MOD.Control | MOD.Meta | MOD.Alt));
  const commandKey = [...mods.filter((m) => m !== "Shift"), ...(mods.includes("Shift") ? ["Shift"] : []), key.length === 1 ? key.toLowerCase() : key].join("+");
  const command = platform === "darwin" ? MAC_COMMANDS[commandKey] : undefined;
  out.push({
    type: typesText ? "keyDown" : "rawKeyDown",
    key, code, windowsVirtualKeyCode: vk, modifiers,
    ...(typesText ? { text, unmodifiedText: text } : {}),
    ...(command ? { commands: [command] } : {}),
  });
  out.push({ type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
  for (const m of [...mods].reverse()) {
    held &= ~MOD[m];
    out.push({ type: "keyUp", key: MOD_KEYS[m].key, code: MOD_KEYS[m].code, windowsVirtualKeyCode: MOD_KEYS[m].vk, modifiers: held });
  }
  return out;
}
