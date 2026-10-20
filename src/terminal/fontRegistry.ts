import { FONT_REGISTRY } from "../../shared/font-registry";

export { FONT_REGISTRY, type FontEntry } from "../../shared/font-registry";

/** Build xterm fontFamily string: selected font + fallback chain */
export function buildFontFamily(fontId: string): string {
  const entry = FONT_REGISTRY.find((f) => f.id === fontId);
  const primary = entry?.cssFamily ?? '"Geist Mono"';
  return `${primary}, "Geist Mono", Menlo, monospace`;
}
