import { lazy } from "react";

/**
 * Monaco, loaded on first use: it's heavy (~1 MB gzipped), so cold start
 * stays light until a file is opened. Shared by the file viewer and file
 * tiles.
 */
export const MonacoEditor = lazy(async () => {
  // Load monaco core + the React wrapper in parallel, then point the
  // React wrapper's loader at the local copy (default fetches from
  // jsdelivr CDN — wrong for Electron: offline-flaky + CSP surface).
  const [monacoMod, reactMod] = await Promise.all([
    import("monaco-editor"),
    import("@monaco-editor/react"),
  ]);
  reactMod.loader.config({ monaco: monacoMod });

  // Register app-tinted Monaco themes. vs-dark's #1e1e1e and vs's
  // white don't match our palette (warm charcoal / warm cream) —
  // inherit the tokenisation from the base themes and only override
  // the structural colours (bg / gutter / selection / border). Keeps
  // syntax highlighting intact, drops the mismatched chrome.
  monacoMod.editor.defineTheme("tacit-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1a1918",
      "editor.foreground": "#e4e2df",
      "editorLineNumber.foreground": "#5a5754",
      "editorLineNumber.activeForeground": "#918e89",
      "editor.lineHighlightBackground": "#222120",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": "#e4e2df",
      "editor.selectionBackground": "#c4c0b840",
      "editor.inactiveSelectionBackground": "#c4c0b825",
      "editor.selectionHighlightBackground": "#c4c0b820",
      "editor.wordHighlightBackground": "#c4c0b818",
      "editor.findMatchBackground": "#d4a24e55",
      "editor.findMatchHighlightBackground": "#d4a24e25",
      "editorGutter.background": "#1a1918",
      "editorWidget.background": "#222120",
      "editorWidget.border": "#333231",
      "editorIndentGuide.background": "#333231",
      "editorIndentGuide.activeBackground": "#43423f",
      "editorBracketMatch.background": "#c4c0b820",
      "editorBracketMatch.border": "#c4c0b855",
      "scrollbarSlider.background": "#43423f55",
      "scrollbarSlider.hoverBackground": "#43423f90",
      "scrollbarSlider.activeBackground": "#43423fcc",
    },
  });
  monacoMod.editor.defineTheme("tacit-light", {
    base: "vs",
    inherit: true,
    rules: [
      // vs's default syntax colours are pitched for pure #ffffff.
      // On our warm cream they read over-saturated and clashy.
      // Warm them down across the board — these are the tokens
      // Monaco actually emits in practice for the languages we
      // care about (ts/js/json/md/py/rs/go/sh).
      { token: "comment", foreground: "8a857f", fontStyle: "italic" },
      { token: "keyword", foreground: "7c3aed" },
      { token: "storage", foreground: "7c3aed" },
      { token: "string", foreground: "15803d" },
      { token: "number", foreground: "a16207" },
      { token: "regexp", foreground: "b45309" },
      { token: "type", foreground: "0f766e" },
      { token: "type.identifier", foreground: "0f766e" },
      { token: "variable", foreground: "1c1917" },
      { token: "variable.predefined", foreground: "9a3412" },
      { token: "function", foreground: "1d4ed8" },
      { token: "constant", foreground: "9a3412" },
      { token: "tag", foreground: "b91c1c" },
      { token: "attribute.name", foreground: "7c2d12" },
      { token: "attribute.value", foreground: "15803d" },
      { token: "operator", foreground: "44403c" },
      { token: "delimiter", foreground: "57534e" },
    ],
    colors: {
      // Use --surface (#f3f2ef) for the editor surface — brighter
      // than --bg so code doesn't feel like it's sitting on a
      // dirty-cream background, while still clearly part of the
      // warm palette (not the stock stark white).
      "editor.background": "#f3f2ef",
      "editor.foreground": "#1c1917",
      "editorLineNumber.foreground": "#b2aba3",
      "editorLineNumber.activeForeground": "#57534e",
      "editor.lineHighlightBackground": "#eae8e4",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": "#1c1917",
      "editor.selectionBackground": "#44403c25",
      "editor.inactiveSelectionBackground": "#44403c12",
      "editor.selectionHighlightBackground": "#44403c10",
      "editor.wordHighlightBackground": "#44403c10",
      "editor.findMatchBackground": "#d9770655",
      "editor.findMatchHighlightBackground": "#d9770625",
      "editorGutter.background": "#f3f2ef",
      "editorWidget.background": "#eae8e4",
      "editorWidget.border": "#dbd8d3",
      "editorIndentGuide.background": "#e5e3df",
      "editorIndentGuide.activeBackground": "#c9c5bf",
      "editorBracketMatch.background": "#44403c15",
      "editorBracketMatch.border": "#44403c55",
      "scrollbarSlider.background": "#c9c5bf55",
      "scrollbarSlider.hoverBackground": "#c9c5bf90",
      "scrollbarSlider.activeBackground": "#c9c5bfcc",
    },
  });

  return { default: reactMod.default };
});

export function guessLanguage(path: string): string {
  const lower = path.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  // Deliberately narrow — the set matches Monaco's built-in language
  // services we ship via monacoEnvironment.ts. Unknown extensions fall
  // through to "plaintext" (still syntax-coloured as plain text, no
  // IntelliSense).
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    jsonc: "json",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    htm: "html",
    md: "markdown",
    markdown: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    xml: "xml",
    sql: "sql",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
  };
  return map[ext] ?? "plaintext";
}
