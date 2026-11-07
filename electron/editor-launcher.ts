import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { EditorInfo, EditorOpenResult, EditorTarget } from "../shared/editors";

/**
 * Open in your editor (T20). Main finds the editors and builds the commands;
 * the window only ever names an editor from the found list and a path inside
 * an open project. Commands run with array arguments and no shell.
 */

/** How an editor's command line takes a line number. */
type LineStyle = "goto" | "zed" | "jetbrains";

interface EditorSpec {
  id: string;
  name: string;
  /** App bundle names, most usual first. */
  apps: string[];
  /** The command line inside the bundle, which works without any PATH setup. */
  bundledCli?: string;
  /** Names on PATH, for an editor installed without a bundle we know. */
  pathCli?: string[];
  lineStyle?: LineStyle;
}

const vscodeFamily = (id: string, name: string, app: string, cli: string): EditorSpec => ({
  id,
  name,
  apps: [`${app}.app`],
  bundledCli: `Contents/Resources/app/bin/${cli}`,
  pathCli: [cli],
  lineStyle: "goto",
});

const jetbrains = (id: string, name: string, apps: string[], binary: string): EditorSpec => ({
  id,
  name,
  apps: apps.map((app) => `${app}.app`),
  bundledCli: `Contents/MacOS/${binary}`,
  lineStyle: "jetbrains",
});

export const EDITORS: readonly EditorSpec[] = [
  vscodeFamily("vscode", "VS Code", "Visual Studio Code", "code"),
  vscodeFamily("cursor", "Cursor", "Cursor", "cursor"),
  {
    id: "zed",
    name: "Zed",
    apps: ["Zed.app"],
    bundledCli: "Contents/MacOS/cli",
    pathCli: ["zed"],
    lineStyle: "zed",
  },
  vscodeFamily("windsurf", "Windsurf", "Windsurf", "windsurf"),
  vscodeFamily("antigravity", "Antigravity IDE", "Antigravity IDE", "antigravity-ide"),
  jetbrains("idea", "IntelliJ IDEA", ["IntelliJ IDEA", "IntelliJ IDEA Ultimate", "IntelliJ IDEA CE"], "idea"),
  jetbrains("webstorm", "WebStorm", ["WebStorm"], "webstorm"),
  jetbrains("pycharm", "PyCharm", ["PyCharm", "PyCharm Professional", "PyCharm CE"], "pycharm"),
  jetbrains("goland", "GoLand", ["GoLand"], "goland"),
  jetbrains("clion", "CLion", ["CLion"], "clion"),
  jetbrains("rustrover", "RustRover", ["RustRover"], "rustrover"),
  jetbrains("rider", "Rider", ["Rider"], "rider"),
  jetbrains("phpstorm", "PhpStorm", ["PhpStorm"], "phpstorm"),
  jetbrains("rubymine", "RubyMine", ["RubyMine"], "rubymine"),
  { id: "xcode", name: "Xcode", apps: ["Xcode.app"] },
];

/** An editor found on this Mac, and how to start it. */
export interface DetectedEditor extends EditorInfo {
  app?: string;
  cli?: string;
  lineStyle?: LineStyle;
}

export interface DetectOptions {
  appDirs: string[];
  /** The login shell's PATH, split into folders. */
  pathDirs: string[];
  exists: (file: string) => boolean;
}

export function detectEditors({ appDirs, pathDirs, exists }: DetectOptions): DetectedEditor[] {
  const found: DetectedEditor[] = [];
  for (const spec of EDITORS) {
    const app = appDirs.flatMap((dir) => spec.apps.map((name) => path.join(dir, name))).find(exists);
    const bundled = app && spec.bundledCli ? path.join(app, spec.bundledCli) : undefined;
    const cli =
      bundled && exists(bundled)
        ? bundled
        : pathDirs.flatMap((dir) => (spec.pathCli ?? []).map((name) => path.join(dir, name))).find(exists);
    if (!app && !cli) continue;
    found.push({ id: spec.id, name: spec.name, app, cli, lineStyle: spec.lineStyle });
  }
  return found;
}

export interface EditorCommand {
  command: string;
  args: string[];
}

/**
 * The command for a target. Without a command line, `open -a` still opens the
 * file; it has no way to say which line. Target paths are absolute by the time
 * they get here, so none can be read as a flag.
 */
export function buildEditorCommand(editor: DetectedEditor, target: EditorTarget): EditorCommand | null {
  const { path: file, line } = target;
  if (editor.cli) {
    const args =
      line === undefined
        ? [file]
        : editor.lineStyle === "goto"
          ? ["--goto", `${file}:${line}`]
          : editor.lineStyle === "zed"
            ? [`${file}:${line}`]
            : editor.lineStyle === "jetbrains"
              ? ["--line", String(line), file]
              : [file];
    return { command: editor.cli, args };
  }
  if (editor.app) return { command: "/usr/bin/open", args: ["-a", editor.app, file] };
  return null;
}

export function isInsideFolder(target: string, folder: string): boolean {
  const relative = path.relative(folder, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export interface OpenDeps {
  detect: () => DetectedEditor[] | Promise<DetectedEditor[]>;
  /** The folders of the open projects and their worktrees. */
  openFolders: () => string[] | Promise<string[]>;
  /** Follows links, so a link inside a project can't lead out of it; throws if the path is gone. */
  realpath: (file: string) => string;
  run: (command: EditorCommand) => Promise<boolean>;
}

function validTarget(target: unknown): target is EditorTarget {
  if (!target || typeof target !== "object") return false;
  const { path: file, line } = target as { path?: unknown; line?: unknown };
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) return false;
  return line === undefined || (typeof line === "number" && Number.isSafeInteger(line) && line > 0);
}

export async function openInEditor(editorId: unknown, target: unknown, deps: OpenDeps): Promise<EditorOpenResult> {
  if (typeof editorId !== "string" || !validTarget(target)) return { ok: false, reason: "invalid" };
  const editor = (await deps.detect()).find((candidate) => candidate.id === editorId);
  if (!editor) return { ok: false, reason: "unknown_editor" };

  let real: string;
  try {
    real = deps.realpath(target.path);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  const folders = (await deps.openFolders()).flatMap((folder) => {
    try {
      return [deps.realpath(folder)];
    } catch {
      return [];
    }
  });
  if (!folders.some((folder) => isInsideFolder(real, folder))) return { ok: false, reason: "outside_projects" };

  // The path as asked for, not the resolved one: the editor should show the
  // file under the project it was opened from.
  const command = buildEditorCommand(editor, { path: target.path, line: target.line });
  if (!command) return { ok: false, reason: "failed" };
  return (await deps.run(command)) ? { ok: true } : { ok: false, reason: "failed" };
}

/** How long a command gets to fail before it counts as started. Some keep running as the editor. */
const START_GRACE_MS = 1500;

/** Starts the command, detached so it outlives Tacit. False if it can't start or fails straight away. */
export function runDetached(
  { command, args }: EditorCommand,
  env: NodeJS.ProcessEnv = process.env,
  graceMs = START_GRACE_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false, env });
    const timer = setTimeout(() => {
      child.unref();
      resolve(true);
    }, graceMs);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

/** The real Mac: both Applications folders and the login shell's PATH. */
export function detectInstalledEditors(homeDir: string, shellPath: string | undefined): DetectedEditor[] {
  return detectEditors({
    appDirs: ["/Applications", path.join(homeDir, "Applications")],
    pathDirs: (shellPath ?? "").split(path.delimiter).filter(Boolean),
    exists: (file) => fs.existsSync(file),
  });
}
