import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

function getSkillLinkType(platform = process.platform): "junction" | "dir" {
  return platform === "win32" ? "junction" : "dir";
}

export function getSkillsSourceDir(
  resourcesPath: string,
  currentDir: string,
): string {
  const prodDir = path.join(resourcesPath, "skills");
  if (fs.existsSync(prodDir)) return prodDir;
  return path.resolve(currentDir, "..", "skills");
}

function getCodexSkillsDir(home: string): string {
  return path.join(home, ".codex", "skills");
}

function getCodexConfigDir(home: string): string {
  return path.join(home, ".codex");
}

function getClaudeSkillsDir(home: string): string {
  return path.join(home, ".claude", "skills");
}

function getClaudePluginsFile(home: string): string {
  return path.join(home, ".claude", "plugins", "installed_plugins.json");
}

function getClaudeSettingsFile(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

function getClaudeGlobalConfigFile(home: string): string {
  return path.join(home, ".claude.json");
}

const PLUGIN_KEY = "tacit@tacit";
const CODEX_COMPUTER_USE_MCP_SERVER_NAME = "computer-use";
const CLAUDE_COMPUTER_USE_MCP_SERVER_NAME = "tacit-computer-use";
const CODEX_HOOKS_FEATURE_FLAG = "hooks";
const CODEX_LEGACY_HOOKS_FEATURE_FLAG = "codex_hooks";
type CodexHooksFeatureFlag =
  | typeof CODEX_HOOKS_FEATURE_FLAG
  | typeof CODEX_LEGACY_HOOKS_FEATURE_FLAG;

interface PluginEntry {
  scope: string;
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
}

interface InstalledPlugins {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

/**
 * Read installed_plugins.json safely.
 * Returns null on any failure — caller must decide whether to proceed.
 */
function readInstalledPlugins(filePath: string): InstalledPlugins | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof raw !== "object" || !raw || typeof raw.plugins !== "object") {
      return null;
    }
    return raw as InstalledPlugins;
  } catch {
    return null;
  }
}

function writeInstalledPlugins(filePath: string, data: InstalledPlugins): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function isClaudePluginCurrent(filePath: string, sourceDir: string): boolean {
  const data = readInstalledPlugins(filePath);
  if (!data) return false;
  const entries = data.plugins[PLUGIN_KEY];
  if (!Array.isArray(entries) || entries.length === 0) return false;
  return entries.some((e) => e.scope === "user" && e.installPath === sourceDir);
}

/**
 * Register the tacit plugin in installed_plugins.json.
 * Preserves all other plugin entries. Only mutates the tacit entry.
 */
function registerClaudePlugin(
  filePath: string,
  sourceDir: string,
  appVersion: string,
): boolean {
  let data = readInstalledPlugins(filePath);
  if (!data) {
    // File missing or empty — create fresh; file corrupt — skip and warn
    try {
      fs.accessSync(filePath);
      // File exists but corrupt — do not overwrite
      console.warn(
        "[SkillManager] installed_plugins.json is corrupt, skipping Claude plugin registration",
      );
      return false;
    } catch {
      // File does not exist — safe to create
      data = { version: 2, plugins: {} };
    }
  }

  const existing = data.plugins[PLUGIN_KEY];
  const userEntries = Array.isArray(existing)
    ? existing.filter((e) => e.scope !== "user")
    : [];

  userEntries.push({
    scope: "user",
    installPath: sourceDir,
    version: appVersion,
    installedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  });

  data.plugins[PLUGIN_KEY] = userEntries;
  writeInstalledPlugins(filePath, data);
  return true;
}

function unregisterClaudePlugin(filePath: string): boolean {
  const data = readInstalledPlugins(filePath);
  if (!data) return true;

  const existing = data.plugins[PLUGIN_KEY];
  if (!existing) return true;

  const remaining = Array.isArray(existing)
    ? existing.filter((e) => e.scope !== "user")
    : [];

  if (remaining.length > 0) {
    data.plugins[PLUGIN_KEY] = remaining;
  } else {
    delete data.plugins[PLUGIN_KEY];
  }

  writeInstalledPlugins(filePath, data);
  return true;
}

// Claude Code settings.json — enable plugin for hooks

function ensurePluginEnabled(settingsFile: string, sourceDir: string): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  } catch {}

  let changed = false;

  const enabled = (data.enabledPlugins ?? {}) as Record<string, boolean>;
  if (enabled[PLUGIN_KEY] !== true) {
    enabled[PLUGIN_KEY] = true;
    data.enabledPlugins = enabled;
    changed = true;
  }

  const scriptPath = path.join(sourceDir, "scripts", "memory-session-start.sh");
  const hooks = (data.hooks ?? {}) as Record<string, unknown[]>;
  const sessionStart = (hooks.SessionStart ?? []) as Array<{
    matcher?: string;
    hooks?: Array<{ type: string; command: string; timeout?: number }>;
  }>;

  const hookCommand = `bash '${scriptPath}'`;
  const scriptName = "memory-session-start.sh";

  const filtered = sessionStart.filter(
    (entry) => !entry.hooks?.some((h) => h.command.includes(scriptName)),
  );
  const needsUpdate = filtered.length !== sessionStart.length;

  filtered.push({
    matcher: "startup|clear|compact",
    hooks: [
      {
        type: "command",
        command: hookCommand,
        timeout: 10,
      },
    ],
  });
  hooks.SessionStart = filtered;
  data.hooks = hooks;
  changed = true;

  if (!changed) return;

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const tmp = settingsFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, settingsFile);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    try {
      fs.accessSync(filePath);
      return null;
    } catch {
      return {};
    }
  }
  return null;
}

function writeJsonAtomic(
  filePath: string,
  data: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function removeClaudeComputerUseMcp(globalConfigFile: string): void {
  const data = readJsonObject(globalConfigFile);
  if (!data) return;
  if (
    typeof data.mcpServers !== "object" ||
    data.mcpServers === null ||
    Array.isArray(data.mcpServers)
  ) {
    return;
  }

  const mcpServers = { ...(data.mcpServers as Record<string, unknown>) };
  if (!(CLAUDE_COMPUTER_USE_MCP_SERVER_NAME in mcpServers)) return;
  delete mcpServers[CLAUDE_COMPUTER_USE_MCP_SERVER_NAME];
  if (Object.keys(mcpServers).length === 0) {
    delete data.mcpServers;
  } else {
    data.mcpServers = mcpServers;
  }
  writeJsonAtomic(globalConfigFile, data);
}

const TACIT_COMPUTER_USE_SIGNATURE_RE =
  /mcp[-/\\]+computer-use-server|TACIT_COMPUTER_USE_|computer-use-instructions\.md/;

function isTacitComputerUseConfig(lines: string[]): boolean {
  return lines.some((line) => TACIT_COMPUTER_USE_SIGNATURE_RE.test(line));
}

// Strip a `[tableName]` block only when its content matches a known legacy
// Tacit Computer Use signature. This keeps user-managed MCPs that happen
// to use the generic `computer-use` server name.
function removeTomlTableIf(
  content: string,
  tableName: string,
  shouldRemove: (lines: string[]) => boolean,
): string {
  if (!content) return content;
  const target = `[${tableName}]`;
  const lines = content.split("\n");
  const out: string[] = [];
  let targetBlock: string[] | null = null;

  const flushTargetBlock = () => {
    if (!targetBlock) return;
    if (!shouldRemove(targetBlock)) out.push(...targetBlock);
    targetBlock = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (targetBlock && trimmed.startsWith("[")) {
      flushTargetBlock();
    }

    if (!targetBlock && trimmed === target) {
      targetBlock = [line];
      continue;
    }

    if (targetBlock) {
      targetBlock.push(line);
    } else {
      out.push(line);
    }
  }

  flushTargetBlock();
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

function removeTomlDottedKeysIf(
  content: string,
  tableName: string,
  shouldRemove: (lines: string[]) => boolean,
): string {
  if (!content) return content;
  const keyPrefix = `${tableName}.`;
  const lines = content.split("\n");
  const dottedLines = lines.filter((line) => line.trim().startsWith(keyPrefix));
  if (dottedLines.length === 0 || !shouldRemove(dottedLines)) return content;
  return lines
    .filter((line) => !line.trim().startsWith(keyPrefix))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

// Earlier versions of removeTomlTable used a regex with the `m` flag and a
// `$` lookahead, which only consumed the table header plus the first body
// line. The remaining `args = …` / `env = { … }` lines were left orphaned in
// whichever section they had been written under and accumulated across runs,
// eventually triggering TOML duplicate-key errors that prevented Codex from
// starting. This helper repairs already-polluted config.toml files on upgrade.
//
// The signatures are scoped to Tacit computer-use entries — either the
// MCP server path component (`mcp-computer-use-server` or
// `mcp/computer-use-server`, including `\\`-escaped variants on Windows) or
// the env-var prefix (`TACIT_COMPUTER_USE_*`) — so unrelated user keys
// remain untouched.
const LEGACY_ORPHAN_ARGS_RE =
  /^\s*args\s*=\s*\[[^\n]*mcp[-/\\]+computer-use-server[^\n]*\]\s*$/;
const LEGACY_ORPHAN_ENV_RE =
  /^\s*env\s*=\s*\{[^\n]*TACIT_COMPUTER_USE_[^\n]*\}\s*$/;

function removeLegacyComputerUseOrphans(content: string): string {
  if (!content) return content;
  const lines = content.split("\n");
  const kept = lines.filter(
    (line) =>
      !LEGACY_ORPHAN_ARGS_RE.test(line) && !LEGACY_ORPHAN_ENV_RE.test(line),
  );
  if (kept.length === lines.length) return content;
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

function removeCodexComputerUseMcp(home: string): void {
  const configFile = path.join(getCodexConfigDir(home), "config.toml");
  let content = "";
  try {
    content = fs.readFileSync(configFile, "utf-8");
  } catch {
    return;
  }

  const nextContent =
    removeLegacyComputerUseOrphans(
      removeTomlDottedKeysIf(
        removeTomlTableIf(
          content,
          `mcp_servers.${CODEX_COMPUTER_USE_MCP_SERVER_NAME}`,
          isTacitComputerUseConfig,
        ),
        `mcp_servers.${CODEX_COMPUTER_USE_MCP_SERVER_NAME}`,
        isTacitComputerUseConfig,
      ),
    ).trimEnd() + "\n";
  if (nextContent === content) return;
  const tmp = configFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, nextContent, "utf-8");
  fs.renameSync(tmp, configFile);
}

function removeComputerUseMcpRegistration(home: string): void {
  removeClaudeComputerUseMcp(getClaudeGlobalConfigFile(home));
  removeCodexComputerUseMcp(home);
}

// Skill manifest — tracks which skills we installed and at which version

const MANIFEST_FILE = ".tacit-skills.json";

interface SkillManifest {
  version: string;
  skills: string[];
}

function readManifest(targetDir: string): SkillManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(targetDir, MANIFEST_FILE), "utf-8"),
    ) as SkillManifest;
  } catch {
    return null;
  }
}

function writeManifest(targetDir: string, manifest: SkillManifest): void {
  const filePath = path.join(targetDir, MANIFEST_FILE);
  const tmp = filePath + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function removeManifest(targetDir: string): void {
  try {
    fs.unlinkSync(path.join(targetDir, MANIFEST_FILE));
  } catch {}
}

function isSymlinkCurrent(linkPath: string, expectedTarget: string): boolean {
  try {
    return fs.readlinkSync(linkPath) === expectedTarget;
  } catch {
    return false;
  }
}

function listBundledSkills(sourceDir: string): string[] {
  const skillsRoot = path.join(sourceDir, "skills");
  if (!fs.existsSync(skillsRoot)) return [];

  const names: string[] = [];
  for (const name of fs.readdirSync(skillsRoot)) {
    try {
      if (fs.statSync(path.join(skillsRoot, name)).isDirectory()) {
        names.push(name);
      }
    } catch {}
  }
  return names;
}

/**
 * Install skill symlinks into a target directory.
 * Compares manifest version to decide between fast-path verification and
 * full reconciliation (create/update symlinks + remove stale ones).
 */
function installSkillLinksTo(
  targetDir: string,
  sourceDir: string,
  appVersion: string,
): void {
  const skillsRoot = path.join(sourceDir, "skills");
  const currentSkills = listBundledSkills(sourceDir);
  if (currentSkills.length === 0) return;

  fs.mkdirSync(targetDir, { recursive: true });

  const oldManifest = readManifest(targetDir);

  if (oldManifest?.version === appVersion) {
    let allCurrent = true;
    for (const name of currentSkills) {
      if (
        !isSymlinkCurrent(
          path.join(targetDir, name),
          path.join(skillsRoot, name),
        )
      ) {
        allCurrent = false;
        break;
      }
    }
    if (allCurrent) return;
  }

  const linkType = getSkillLinkType();

  for (const name of currentSkills) {
    const skillDir = path.join(skillsRoot, name);
    const link = path.join(targetDir, name);

    if (isSymlinkCurrent(link, skillDir)) continue;

    try {
      const stat = fs.lstatSync(link);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(link);
      } else {
        console.warn(
          `[SkillManager] skipping ${link}: not a symlink, may be user-managed`,
        );
        continue;
      }
    } catch {}

    fs.symlinkSync(skillDir, link, linkType);
  }

  if (oldManifest) {
    const currentSet = new Set(currentSkills);
    for (const name of oldManifest.skills) {
      if (currentSet.has(name)) continue;
      const link = path.join(targetDir, name);
      try {
        if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      } catch {}
    }
  }

  writeManifest(targetDir, { version: appVersion, skills: currentSkills });
}

function removeSkillLinksFrom(targetDir: string, sourceDir: string): void {
  const skillsRoot = path.join(sourceDir, "skills");

  if (fs.existsSync(skillsRoot)) {
    for (const name of fs.readdirSync(skillsRoot)) {
      const link = path.join(targetDir, name);
      try {
        if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      } catch {}
    }
  }

  const manifest = readManifest(targetDir);
  if (manifest) {
    for (const name of manifest.skills) {
      const link = path.join(targetDir, name);
      try {
        if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
      } catch {}
    }
  }

  removeManifest(targetDir);
}

function installAllSkillLinks(
  sourceDir: string,
  home: string,
  appVersion: string,
): void {
  installSkillLinksTo(getClaudeSkillsDir(home), sourceDir, appVersion);
  installSkillLinksTo(getCodexSkillsDir(home), sourceDir, appVersion);
}

function removeAllSkillLinks(sourceDir: string, home: string): void {
  removeSkillLinksFrom(getClaudeSkillsDir(home), sourceDir);
  removeSkillLinksFrom(getCodexSkillsDir(home), sourceDir);
}

const LIFECYCLE_HOOK_EVENTS = [
  "SessionStart",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "PreToolUse",
  "Notification",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
] as const;

const LIFECYCLE_MARKER = "tacit-hook.mjs";

function ensureLifecycleHooks(settingsFile: string, scriptPath: string): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  } catch {}

  const hooks = (data.hooks ?? {}) as Record<string, unknown[]>;
  const hookCommand = `node '${scriptPath}'`;

  for (const eventName of LIFECYCLE_HOOK_EVENTS) {
    const existing = (hooks[eventName] ?? []) as Array<{
      matcher?: string;
      hooks?: Array<{
        type: string;
        command: string;
        timeout?: number;
        async?: boolean;
      }>;
    }>;

    const filtered = existing.filter(
      (entry) =>
        !entry.hooks?.some((h) => h.command.includes(LIFECYCLE_MARKER)),
    );

    // SessionStart blocks briefly to capture session_id; all others are async
    const isAsync = eventName !== "SessionStart";

    filtered.push({
      matcher: "",
      hooks: [
        {
          type: "command",
          command: hookCommand,
          timeout: 5,
          ...(isAsync ? { async: true } : {}),
        },
      ],
    });

    hooks[eventName] = filtered;
  }

  data.hooks = hooks;

  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const tmp = settingsFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, settingsFile);
}

function removeLifecycleHooks(settingsFile: string): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
  } catch {
    return;
  }

  const hooks = (data.hooks ?? {}) as Record<string, unknown[]>;
  let changed = false;

  for (const eventName of LIFECYCLE_HOOK_EVENTS) {
    const existing = (hooks[eventName] ?? []) as Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string }>;
    }>;

    const filtered = existing.filter(
      (entry) =>
        !entry.hooks?.some((h) => h.command.includes(LIFECYCLE_MARKER)),
    );

    if (filtered.length !== existing.length) {
      changed = true;
      if (filtered.length === 0) {
        delete hooks[eventName];
      } else {
        hooks[eventName] = filtered;
      }
    }
  }

  if (Object.keys(hooks).length === 0) {
    delete data.hooks;
  } else {
    data.hooks = hooks;
  }

  if (!changed) return;

  const tmp = settingsFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, settingsFile);
}

const CODEX_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "Stop",
  "UserPromptSubmit",
] as const;

const CODEX_HOOK_EVENT_KEY_LABELS: Record<(typeof CODEX_HOOK_EVENTS)[number], string> = {
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  SessionStart: "session_start",
  Stop: "stop",
  UserPromptSubmit: "user_prompt_submit",
};

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return Object.fromEntries(
      entries.map(([key, val]) => [key, canonicalJson(val)]),
    );
  }
  return value;
}

function versionForCodexHookIdentity(value: unknown): string {
  const serialized = JSON.stringify(canonicalJson(value));
  return `sha256:${crypto.createHash("sha256").update(serialized).digest("hex")}`;
}

function codexCommandHookHash(eventName: (typeof CODEX_HOOK_EVENTS)[number], command: string): string {
  return versionForCodexHookIdentity({
    event_name: CODEX_HOOK_EVENT_KEY_LABELS[eventName],
    hooks: [
      {
        async: false,
        command,
        timeout: 5,
        type: "command",
      },
    ],
    matcher: "",
  });
}

function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isTomlHookStateHeader(line: string): string | null {
  const match = line.match(/^\s*\[hooks\.state\."((?:\\.|[^"])*)"\]\s*(?:#.*)?$/);
  if (!match) return null;
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function ensureTrustedHashInHookStateBlock(lines: string[], trustedHash: string): string[] {
  const hashLine = `trusted_hash = "${trustedHash}"`;
  let replaced = false;
  const next = lines.map((line) => {
    if (/^\s*trusted_hash\s*=/.test(line)) {
      replaced = true;
      return hashLine;
    }
    return line;
  });
  if (!replaced) next.push(hashLine);
  return next;
}

function ensureCodexHookTrustStatesInToml(
  content: string,
  states: Record<string, string>,
): string {
  if (Object.keys(states).length === 0) return content;

  const lines = content.split("\n");
  const output: string[] = [];
  let changed = false;
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const stateKey = isTomlHookStateHeader(lines[i]);
    if (!stateKey || !(stateKey in states)) {
      output.push(lines[i]);
      continue;
    }

    const block = [lines[i]];
    let j = i + 1;
    while (j < lines.length && !isTomlTableHeader(lines[j])) {
      block.push(lines[j]);
      j += 1;
    }

    const nextBlock = ensureTrustedHashInHookStateBlock(block, states[stateKey]);
    if (nextBlock.join("\n") !== block.join("\n")) changed = true;
    output.push(...nextBlock);
    seen.add(stateKey);
    i = j - 1;
  }

  const missing = Object.entries(states).filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    const trimmed = output.join("\n").trimEnd();
    const prefix = trimmed ? `${trimmed}\n\n` : "";
    const appended = missing
      .map(
        ([key, hash]) =>
          `[hooks.state."${escapeTomlBasicString(key)}"]\ntrusted_hash = "${hash}"`,
      )
      .join("\n\n");
    return `${prefix}${appended}\n`;
  }

  return changed ? output.join("\n") : content;
}

function ensureCodexHooks(scriptPath: string, home: string): void {
  const hooksFile = path.join(getCodexConfigDir(home), "hooks.json");
  let data: { hooks?: Record<string, unknown[]> } = {};
  try {
    data = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
  } catch {}

  const hooks = (data.hooks ?? {}) as Record<string, unknown[]>;
  const hookCommand = `node '${scriptPath}'`;

  for (const eventName of CODEX_HOOK_EVENTS) {
    const existing = (hooks[eventName] ?? []) as Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string; timeout?: number }>;
    }>;

    const filtered = existing.filter(
      (entry) =>
        !entry.hooks?.some((h) => h.command.includes(LIFECYCLE_MARKER)),
    );

    filtered.push({
      matcher: "",
      hooks: [{ type: "command", command: hookCommand, timeout: 5 }],
    });

    hooks[eventName] = filtered;
  }

  data.hooks = hooks;

  const dir = path.dirname(hooksFile);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = hooksFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, hooksFile);
}

function removeCodexHooks(home: string): void {
  const hooksFile = path.join(getCodexConfigDir(home), "hooks.json");
  let data: { hooks?: Record<string, unknown[]> } = {};
  try {
    data = JSON.parse(fs.readFileSync(hooksFile, "utf-8"));
  } catch {
    return;
  }

  const hooks = (data.hooks ?? {}) as Record<string, unknown[]>;
  let changed = false;

  for (const eventName of CODEX_HOOK_EVENTS) {
    const existing = (hooks[eventName] ?? []) as Array<{
      matcher?: string;
      hooks?: Array<{ type: string; command: string }>;
    }>;

    const filtered = existing.filter(
      (entry) =>
        !entry.hooks?.some((h) => h.command.includes(LIFECYCLE_MARKER)),
    );

    if (filtered.length !== existing.length) {
      changed = true;
      if (filtered.length === 0) {
        delete hooks[eventName];
      } else {
        hooks[eventName] = filtered;
      }
    }
  }

  if (!changed) return;

  if (Object.keys(hooks).length === 0) {
    delete data.hooks;
  } else {
    data.hooks = hooks;
  }

  const tmp = hooksFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, hooksFile);
}

export function parseCodexHooksFeatureFlag(
  featuresListOutput: string,
): CodexHooksFeatureFlag | null {
  const featureNames = new Set(
    featuresListOutput
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
  if (featureNames.has(CODEX_HOOKS_FEATURE_FLAG)) {
    return CODEX_HOOKS_FEATURE_FLAG;
  }
  if (featureNames.has(CODEX_LEGACY_HOOKS_FEATURE_FLAG)) {
    return CODEX_LEGACY_HOOKS_FEATURE_FLAG;
  }
  return null;
}

function parseCodexCliVersion(
  versionOutput: string,
): [number, number, number] | null {
  const match = versionOutput.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = left[i] - right[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function detectCodexHooksFeatureFlag(): CodexHooksFeatureFlag {
  try {
    const output = execFileSync("codex", ["features", "list"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    return parseCodexHooksFeatureFlag(output) ?? CODEX_HOOKS_FEATURE_FLAG;
  } catch {
    try {
      const output = execFileSync("codex", ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      const version = parseCodexCliVersion(output);
      if (version && compareSemver(version, [0, 129, 0]) < 0) {
        return CODEX_LEGACY_HOOKS_FEATURE_FLAG;
      }
    } catch {}
  }
  return CODEX_HOOKS_FEATURE_FLAG;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTomlTableHeader(line: string): boolean {
  return /^\s*\[+[^\]]+\]+\s*(?:#.*)?$/.test(line);
}

function isTomlTable(line: string, tableName: string): boolean {
  return new RegExp(
    `^\\s*\\[${escapeRegExp(tableName)}\\]\\s*(?:#.*)?$`,
  ).test(line);
}

function isTomlKeyAssignment(line: string, key: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line);
}

function isTomlTrueAssignment(line: string, key: string): boolean {
  return new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*true\\s*(?:#.*)?$`).test(
    line,
  );
}

function ensureCodexHooksFeatureFlagInToml(
  content: string,
  featureFlag: CodexHooksFeatureFlag,
): string {
  const hookFeatureFlags = [
    CODEX_HOOKS_FEATURE_FLAG,
    CODEX_LEGACY_HOOKS_FEATURE_FLAG,
  ];
  let cleaned = content;
  for (const flag of hookFeatureFlags) {
    cleaned = cleaned.replace(
      new RegExp(`^\\s*features\\.${escapeRegExp(flag)}\\s*=.*$`, "gm"),
      "",
    );
  }
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  const lines = cleaned.split("\n");
  const featuresStart = lines.findIndex((line) =>
    isTomlTable(line, "features"),
  );

  if (featuresStart === -1) {
    const prefix = cleaned.trimEnd();
    const section = `[features]\n${featureFlag} = true\n`;
    return prefix ? `${prefix}\n\n${section}` : section;
  }

  let featuresEnd = lines.length;
  for (let i = featuresStart + 1; i < lines.length; i += 1) {
    if (isTomlTableHeader(lines[i])) {
      featuresEnd = i;
      break;
    }
  }

  const featureLines = lines.slice(featuresStart + 1, featuresEnd);
  const matchingLines = featureLines.filter((line) =>
    hookFeatureFlags.some((flag) => isTomlKeyAssignment(line, flag)),
  );
  const alreadyCanonical =
    matchingLines.length === 1 &&
    isTomlTrueAssignment(matchingLines[0], featureFlag);

  if (alreadyCanonical) return cleaned;

  const filteredFeatureLines = featureLines.filter(
    (line) => !hookFeatureFlags.some((flag) => isTomlKeyAssignment(line, flag)),
  );

  return [
    ...lines.slice(0, featuresStart + 1),
    `${featureFlag} = true`,
    ...filteredFeatureLines,
    ...lines.slice(featuresEnd),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function ensureCodexHookTrustStates(home: string, scriptPath: string): void {
  const configFile = path.join(getCodexConfigDir(home), "config.toml");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });

  let content = "";
  try {
    content = fs.readFileSync(configFile, "utf-8");
  } catch {}

  const hooksFile = path.join(getCodexConfigDir(home), "hooks.json");
  const hookCommand = `node '${scriptPath}'`;
  const states = Object.fromEntries(
    CODEX_HOOK_EVENTS.map((eventName) => [
      `${hooksFile}:${CODEX_HOOK_EVENT_KEY_LABELS[eventName]}:0:0`,
      codexCommandHookHash(eventName, hookCommand),
    ]),
  );

  const nextContent = ensureCodexHookTrustStatesInToml(content, states);
  if (nextContent === content) return;

  const tmp = configFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, nextContent, "utf-8");
  fs.renameSync(tmp, configFile);
}

function ensureCodexFeatureFlag(home: string): void {
  const configFile = path.join(getCodexConfigDir(home), "config.toml");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });

  let content = "";
  try {
    content = fs.readFileSync(configFile, "utf-8");
  } catch {}

  const featureFlag = detectCodexHooksFeatureFlag();
  const nextContent = ensureCodexHooksFeatureFlagInToml(content, featureFlag);
  if (nextContent === content) return;

  const tmp = configFile + ".tmp." + process.pid;
  fs.writeFileSync(tmp, nextContent, "utf-8");
  fs.renameSync(tmp, configFile);
}

/**
 * Full install: register Claude plugin + create skill symlinks.
 * Called when user registers the CLI.
 */
export function installSkillLinks({
  home = os.homedir(),
  sourceDir,
  appVersion = "1.0.0",
}: {
  home?: string;
  sourceDir: string;
  appVersion?: string;
}): boolean {
  try {
    registerClaudePlugin(getClaudePluginsFile(home), sourceDir, appVersion);
    ensurePluginEnabled(getClaudeSettingsFile(home), sourceDir);
    ensureLifecycleHooks(
      getClaudeSettingsFile(home),
      path.join(sourceDir, "scripts", "tacit-hook.mjs"),
    );
    ensureCodexHooks(
      path.join(sourceDir, "scripts", "tacit-hook.mjs"),
      home,
    );
    ensureCodexHookTrustStates(
      home,
      path.join(sourceDir, "scripts", "tacit-hook.mjs"),
    );
    ensureCodexFeatureFlag(home);
    removeComputerUseMcpRegistration(home);
    installAllSkillLinks(sourceDir, home, appVersion);
    return true;
  } catch (err) {
    console.error("[SkillManager] install failed:", err);
    return false;
  }
}

/**
 * Ensure skills are current. Called on every app startup.
 * Has fast paths — skips work when state is already correct.
 */
export function ensureSkillLinks({
  home = os.homedir(),
  sourceDir,
  appVersion = "1.0.0",
}: {
  home?: string;
  sourceDir: string;
  appVersion?: string;
}): boolean {
  try {
    const pluginsFile = getClaudePluginsFile(home);

    if (!isClaudePluginCurrent(pluginsFile, sourceDir)) {
      registerClaudePlugin(pluginsFile, sourceDir, appVersion);
    }

    ensurePluginEnabled(getClaudeSettingsFile(home), sourceDir);
    ensureLifecycleHooks(
      getClaudeSettingsFile(home),
      path.join(sourceDir, "scripts", "tacit-hook.mjs"),
    );
    ensureCodexHooks(
      path.join(sourceDir, "scripts", "tacit-hook.mjs"),
      home,
    );
    ensureCodexHookTrustStates(
      home,
      path.join(sourceDir, "scripts", "tacit-hook.mjs"),
    );
    ensureCodexFeatureFlag(home);
    removeComputerUseMcpRegistration(home);
    installAllSkillLinks(sourceDir, home, appVersion);

    return true;
  } catch (err) {
    console.error("[SkillManager] ensure failed:", err);
    return false;
  }
}

export function uninstallSkillLinks({
  home = os.homedir(),
  sourceDir,
}: {
  home?: string;
  sourceDir: string;
}): boolean {
  try {
    unregisterClaudePlugin(getClaudePluginsFile(home));
    removeLifecycleHooks(getClaudeSettingsFile(home));
    removeCodexHooks(home);
    removeComputerUseMcpRegistration(home);
    removeAllSkillLinks(sourceDir, home);
    return true;
  } catch (err) {
    console.error("[SkillManager] uninstall failed:", err);
    return false;
  }
}
