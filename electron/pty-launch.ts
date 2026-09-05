import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getTacitDataDir,
  type TacitInstance,
} from "../shared/tacit-instance";

export interface PtyLaunchOptions {
  cwd: string;
  shell?: string;
  args?: string[];
  extraPathEntries?: string[];
  envOverrides?: Record<string, string | undefined>;
  terminalId?: string;
  terminalType?: string;
  theme?: "dark" | "light";
}

export interface PtyResolvedLaunchSpec {
  cwd: string;
  file: string;
  args: string[];
  env: Record<string, string>;
}

function applyThemeHints(
  env: Record<string, string>,
  theme: "dark" | "light" | undefined,
): void {
  if (!theme) return;

  env.TACIT_THEME = theme;
  env.COLORFGBG = theme === "dark" ? "15;0" : "0;15";
}

export interface LaunchResolverDeps {
  platform: NodeJS.Platform;
  pathDelimiter: string;
  pathSeparator: string;
  existsSync: (file: string) => boolean;
  isExecutable: (file: string) => boolean;
  readFileSync: (file: string, encoding: BufferEncoding) => string;
  homeDir: () => string;
  getShellEnv: () => Promise<Record<string, string | undefined>>;
}

const LOGIN_SHELL_ENV_BLOCKLIST = new Set([
  "NO_COLOR",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_SESSION_ID",
]);

const LOGIN_SHELL_ENV_BLOCKED_PREFIXES = [
  "CODEX_",
  "P9K_",
] as const;

const TACIT_RUNTIME_ENV_BLOCKLIST = new Set([
  "TACIT_SOCKET",
  "TACIT_TERMINAL_ID",
  "TACIT_TERMINAL_TYPE",
  "TACIT_INSTANCE",
  "TACIT_PORT_FILE",
  // Claude Code sets this on processes it spawns, and switches transcript
  // saving OFF when it sees it inherited — a nested agent shouldn't litter
  // the user's session history. Launch Tacit from inside a Claude Code
  // session (or from any agent-spawned shell) and the whole app inherits the
  // marker, so every terminal it opens silently stops writing a transcript.
  // That breaks resume specifically: the session id is still captured and
  // still passed to `claude --resume`, but the transcript it points at was
  // never written, so there is nothing to restore and the agent comes back
  // as a fresh session. Terminals Tacit opens are top-level user
  // sessions, not children of whatever launched the app, so the marker must
  // not carry into them.
  "CLAUDE_CODE_CHILD_SESSION",
]);

function getEnvVarCaseInsensitive(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  if (typeof env[key] === "string") return env[key];

  const found = Object.entries(env).find(([entryKey, entryValue]) =>
    entryKey.toLowerCase() === key.toLowerCase() &&
    typeof entryValue === "string"
  );
  return found?.[1];
}

function getPlatformPath(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function defaultPathEntriesForPlatform(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  const platformPath = getPlatformPath(platform);

  if (platform === "win32") {
    return [
      "C:\\Windows\\System32",
      "C:\\Windows",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      getEnvVarCaseInsensitive(env, "LOCALAPPDATA")
        ? platformPath.join(
            getEnvVarCaseInsensitive(env, "LOCALAPPDATA")!,
            "Microsoft",
            "WindowsApps",
          )
        : "",
      getEnvVarCaseInsensitive(env, "LOCALAPPDATA")
        ? platformPath.join(
            getEnvVarCaseInsensitive(env, "LOCALAPPDATA")!,
            "OpenAI",
            "Codex",
            "bin",
          )
        : "",
      getEnvVarCaseInsensitive(env, "APPDATA")
        ? platformPath.join(getEnvVarCaseInsensitive(env, "APPDATA")!, "npm")
        : "",
      getEnvVarCaseInsensitive(env, "USERPROFILE")
        ? platformPath.join(
            getEnvVarCaseInsensitive(env, "USERPROFILE")!,
            ".local",
            "bin",
          )
        : "",
      getEnvVarCaseInsensitive(env, "USERPROFILE")
        ? platformPath.join(getEnvVarCaseInsensitive(env, "USERPROFILE")!, "bin")
        : "",
    ].filter(Boolean);
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
}

function mergePathValue(
  pathValue: string | undefined,
  platform: NodeJS.Platform,
  delimiter: string,
  env: Record<string, string | undefined>,
): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  const addEntry = (value: string) => {
    const trimmed = value.trim();
    const key = platform === "win32" ? trimmed.toLowerCase() : trimmed;
    if (!trimmed || seen.has(key)) return;
    seen.add(key);
    merged.push(trimmed);
  };

  const addEntries = (value: string | undefined) => {
    if (!value) return;
    for (const entry of value.split(delimiter)) {
      addEntry(entry);
    }
  };

  addEntries(pathValue);
  for (const entry of defaultPathEntriesForPlatform(platform, env)) {
    addEntry(entry);
  }

  return merged.join(delimiter);
}

export function sanitizeEnv(
  env: Record<string, string | undefined>,
  deps: Pick<LaunchResolverDeps, "platform" | "pathDelimiter">,
): Record<string, string> {
  const cleaned: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      cleaned[key] = value;
    }
  }

  for (const key of TACIT_RUNTIME_ENV_BLOCKLIST) {
    delete cleaned[key];
  }

  cleaned.PATH = mergePathValue(
    getEnvVarCaseInsensitive(env, "PATH"),
    deps.platform,
    deps.pathDelimiter,
    env,
  );
  return cleaned;
}

function shouldStripFromLoginShellSeed(key: string): boolean {
  if (LOGIN_SHELL_ENV_BLOCKLIST.has(key)) {
    return true;
  }

  return LOGIN_SHELL_ENV_BLOCKED_PREFIXES.some((prefix) =>
    key.startsWith(prefix)
  );
}

export function sanitizeLoginShellSeedEnv(
  env: Record<string, string | undefined>,
  deps: Pick<LaunchResolverDeps, "platform" | "pathDelimiter">,
): Record<string, string> {
  const cleaned = sanitizeEnv(env, deps);
  for (const key of Object.keys(cleaned)) {
    if (shouldStripFromLoginShellSeed(key)) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

function hasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function pathEntryExists(
  entries: string[],
  target: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedTarget = platform === "win32"
    ? target.toLowerCase()
    : target;
  return entries.some((entry) =>
    (platform === "win32" ? entry.toLowerCase() : entry) === normalizedTarget
  );
}

function getWindowsCommandCandidates(command: string): string[] {
  const lower = command.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return [command];
  }
  return [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command];
}

function getWindowsPathCandidates(target: string): string[] {
  const lower = target.toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return [target];
  }
  return [`${target}.exe`, `${target}.cmd`, `${target}.bat`, target];
}

function resolveExactExecutable(
  target: string,
  deps: Pick<LaunchResolverDeps, "existsSync" | "isExecutable">,
): string | null {
  if (!deps.existsSync(target)) return null;
  if (!deps.isExecutable(target)) return null;
  return target;
}

export function resolveExecutable(
  command: string,
  env: Record<string, string>,
  deps: Pick<
    LaunchResolverDeps,
    "platform" | "pathDelimiter" | "existsSync" | "isExecutable"
  >,
): string | null {
  if (!command) return null;

  const platformPath = getPlatformPath(deps.platform);

  if (platformPath.isAbsolute(command) || hasPathSeparator(command)) {
    const candidates =
      deps.platform === "win32" ? getWindowsPathCandidates(command) : [command];

    for (const candidate of candidates) {
      const resolved = resolveExactExecutable(candidate, deps);
      if (resolved) return resolved;
    }

    return null;
  }

  const pathEntries = (env.PATH ?? "")
    .split(deps.pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const commandNames =
    deps.platform === "win32" ? getWindowsCommandCandidates(command) : [command];

  for (const dir of pathEntries) {
    for (const name of commandNames) {
      const candidate = platformPath.join(dir, name);
      const resolved = resolveExactExecutable(candidate, deps);
      if (resolved) return resolved;
    }
  }

  return null;
}

function isWindowsBatchScript(file: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const lower = file.toLowerCase();
  return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

export function resolveUserShell(
  env: Record<string, string>,
  deps: Pick<
    LaunchResolverDeps,
    "platform" | "pathDelimiter" | "existsSync" | "isExecutable"
  >,
): string {
  const candidates =
    deps.platform === "win32"
      ? [env.ComSpec, "pwsh.exe", "powershell.exe", "cmd.exe"]
      : [env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = resolveExecutable(candidate, env, deps);
    if (resolved) return resolved;
  }

  throw new Error("Could not resolve a usable shell executable");
}

function parseNullDelimitedEnv(output: Buffer): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const entry of output.toString("utf-8").split("\0")) {
    if (!entry) continue;
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = entry.slice(0, separatorIndex);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    const value = entry.slice(separatorIndex + 1);
    parsed[key] = value;
  }
  return parsed;
}

async function captureLoginShellEnv(
  shell: string,
  baseEnv: Record<string, string>,
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ["-lic", "/usr/bin/env -0"],
      {
        env: baseEnv,
        encoding: "buffer",
        maxBuffer: 1024 * 1024 * 4,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(parseNullDelimitedEnv(stdout as Buffer));
      },
    );
  });
}

let cachedShellEnvPromise: Promise<Record<string, string>> | null = null;

const defaultDeps: LaunchResolverDeps = {
  platform: process.platform,
  pathDelimiter: path.delimiter,
  pathSeparator: path.sep,
  existsSync: (file) => fs.existsSync(file),
  readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
  homeDir: () => os.homedir(),
  isExecutable: (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  getShellEnv: async () => {
    if (cachedShellEnvPromise) {
      return cachedShellEnvPromise;
    }

    const baseEnv = sanitizeLoginShellSeedEnv(process.env, {
      platform: process.platform,
      pathDelimiter: path.delimiter,
    });

    if (process.platform === "win32") {
      return baseEnv;
    }

    const shell = resolveUserShell(baseEnv, {
      platform: process.platform,
      pathDelimiter: path.delimiter,
      existsSync: (file) => fs.existsSync(file),
      isExecutable: (file) => {
        try {
          fs.accessSync(file, fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      },
    });

    cachedShellEnvPromise = captureLoginShellEnv(shell, baseEnv)
      .then((loginEnv) =>
        sanitizeEnv(loginEnv, {
          platform: process.platform,
          pathDelimiter: path.delimiter,
        }),
      )
      .catch((error) => {
        console.warn(
          `[Tacit] Failed to capture login shell environment via ${shell}; falling back to process env.`,
          error,
        );
        return baseEnv;
      });

    return cachedShellEnvPromise;
  },
};

export class PtyLaunchError extends Error {
  readonly code: string;
  readonly command: string;

  constructor(code: string, message: string, command: string) {
    super(message);
    this.name = "PtyLaunchError";
    this.code = code;
    this.command = command;
  }
}

export async function buildLaunchSpec(
  options: PtyLaunchOptions,
  deps: LaunchResolverDeps = defaultDeps,
): Promise<PtyResolvedLaunchSpec> {
  if (!deps.existsSync(options.cwd)) {
    throw new Error(`Directory does not exist: ${options.cwd}`);
  }

  const shellEnv = sanitizeEnv(await deps.getShellEnv(), deps);

  if (options.terminalId) {
    shellEnv.TACIT_TERMINAL_ID = options.terminalId;
  }
  if (options.terminalType) {
    shellEnv.TACIT_TERMINAL_TYPE = options.terminalType;
  }
  const instance: TacitInstance = process.env.VITE_DEV_SERVER_URL
    ? "dev"
    : "prod";
  shellEnv.TACIT_INSTANCE = instance;
  shellEnv.TACIT_PORT_FILE = path.join(
    getTacitDataDir(instance),
    "port",
  );
  applyThemeHints(shellEnv, options.theme);
  if (options.envOverrides) {
    for (const [key, value] of Object.entries(options.envOverrides)) {
      if (value === undefined) {
        delete shellEnv[key];
      } else {
        shellEnv[key] = value;
      }
    }
  }

  const launchArgs = options.args ?? [];

  if (options.extraPathEntries?.length) {
    const entries = shellEnv.PATH.split(deps.pathDelimiter);
    for (const dir of options.extraPathEntries) {
      if (!pathEntryExists(entries, dir, deps.platform)) entries.unshift(dir);
    }
    shellEnv.PATH = entries.join(deps.pathDelimiter);
  }

  if (options.shell) {
    const executable = resolveExecutable(options.shell, shellEnv, deps);
    if (!executable) {
      throw new PtyLaunchError(
        "executable-not-found",
        `Executable not found: ${options.shell}`,
        options.shell,
      );
    }

    if (isWindowsBatchScript(executable, deps.platform)) {
      const commandShell = resolveExecutable(
        shellEnv.ComSpec ?? "cmd.exe",
        shellEnv,
        deps,
      );
      if (!commandShell) {
        throw new Error("Could not resolve cmd.exe for Windows batch launch");
      }

      return {
        cwd: options.cwd,
        file: commandShell,
        args: ["/d", "/s", "/c", executable, ...launchArgs],
        env: shellEnv,
      };
    }

    return {
      cwd: options.cwd,
      file: executable,
      args: launchArgs,
      env: shellEnv,
    };
  }

  const shell = resolveUserShell(shellEnv, deps);
  return {
    cwd: options.cwd,
    file: shell,
    args: deps.platform === "win32" ? launchArgs : ["-l", ...launchArgs],
    env: shellEnv,
  };
}
