/**
 * What Tacit itself saw an agent do, for a task's finish. It must never say
 * "saw" for something it can't stand behind, so a command counts as a test run
 * only when its own exit is the tests' exit: `npm test | tail` succeeds even
 * when the tests fail, so it counts for nothing.
 */
import type { CheckpointFileChange } from "../shared/turns";
import type { Observed, Report } from "../shared/task";

const RUNNERS =
  /^(?:npx\s+(?:--yes\s+|-y\s+)?|pnpm\s+(?:exec|dlx)\s+|yarn\s+(?:exec|dlx)\s+|bunx?\s+x?\s*|uv\s+run\s+|poetry\s+run\s+|bundle\s+exec\s+|python3?\s+-m\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:-{1,2}\S+\s+)*t(?:est)?(?:[:\s]|$)|(?:vitest|jest|mocha|ava|pytest|unittest|rspec|phpunit|ctest|tox|nox)(?:\s|$)|playwright\s+test|(?:tsx|node)\s+(?:\S+\s+)*--test(?:\s|$)|(?:go|cargo|swift|deno|dotnet|mix|flutter|dart|xcodebuild)\s+(?:\S+\s+)*test(?:\s|$)|(?:\.\/)?(?:gradlew?|mvnw?)\s+(?:\S+\s+)*test(?:\s|$)|make\s+(?:\S+\s+)*test(?:\s|$))/;

/** The test command in a shell line whose exit tells whether the tests passed, or null. */
export function testCommandIn(line: unknown): string | null {
  if (typeof line !== "string" || line.length > 2000) return null;
  const command = line.trim();
  // Output redirects don't change the exit; anything that could hides it.
  const bare = command.replace(/\s\d?>(?:>|&)?\s*\S+/g, " ").replace(/\s&>>?\s*\S+/g, " ");
  if (/\n|`|\$\(|\|\||;|(?<!&)&(?!&)|\|/.test(bare)) return null;
  const parts = bare.split("&&").map((p) => p.trim());
  // Run before others in a chain, its failure still fails the whole; its success isn't hidden either.
  for (const part of parts) {
    const words = part.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").replace(/^(?:time|timeout\s+\S+)\s+/, "");
    if (/(?:^|\s)(?:--help|--version|--listTests|--collect-only|--no-run|--passWithNoTests|--watch(?:All)?)(?=\s|=|$)/.test(words)) continue;
    if (RUNNERS.test(words)) return words.replace(/\s+/g, " ").slice(0, 80);
  }
  return null;
}

/** A tool's use, as its hook says it: whether a command ran, and how it ended. Null when that isn't told. */
export function commandFrom(event: { hook_event_name: string; tool_name?: unknown; tool_input?: unknown; tool_response?: unknown; is_interrupt?: unknown }): { command: string; ok: boolean } | null {
  if (event.hook_event_name !== "PostToolUse" && event.hook_event_name !== "PostToolUseFailure") return null;
  if (typeof event.tool_name !== "string" || !/^(Bash|shell|local_shell|exec_command|shell_command)$/i.test(event.tool_name)) return null;
  const input = (event.tool_input ?? {}) as Record<string, unknown>;
  // Left running in the background, how it ended isn't known.
  if (input.run_in_background === true || event.is_interrupt === true) return null;
  const raw = input.command ?? input.cmd;
  const command = Array.isArray(raw) ? (typeof raw[2] === "string" && /^(ba|z)?sh$/.test(String(raw[0]).split("/").pop() ?? "") ? raw[2] : raw.join(" ")) : raw;
  if (typeof command !== "string") return null;
  if (event.hook_event_name === "PostToolUseFailure") return { command, ok: false };
  const response = event.tool_response;
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (r.interrupted === true || r.backgroundTaskId !== undefined) return null;
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    for (const code of [r.exit_code, r.exitCode, meta.exit_code]) if (typeof code === "number") return { command, ok: code === 0 };
    // Claude tells of a command that failed through PostToolUseFailure, so this one didn't.
    return "stdout" in r ? { command, ok: true } : null;
  }
  // Codex gives its output as text, with how it exited only sometimes in it.
  if (typeof response === "string") {
    const code = /(?:exit(?:ed)?(?: with)?(?: code)?|"exit_code")\s*:?\s*(\d+)/i.exec(response);
    return code ? { command, ok: code[1] === "0" } : null;
  }
  return null;
}

const EDITS = /^(Edit|MultiEdit|Write|NotebookEdit|apply_patch|str_replace_editor|write_file|edit_file)$/i;

/** A shell command that writes files: agents edit with these too. Only ones that plainly do. */
const WRITES = /(^|[;&|(\n]\s*|\bxargs\s+(?:-\S+\s+)*)(?:sudo\s+)?(?:sed\s+(?:-\S+\s+)*-i|perl\s+(?:-\S*\s+)*-\S*i|tee\b|mv\b|cp\b|rm\b|patch\b|touch\b|truncate\b|git\s+(?:apply|checkout|restore|stash|reset|merge|rebase|pull|cherry-pick)\b)|(?<![0-9&<>=-])>{1,2}\s*(?!&|\/dev\/null)[\w./~"'$-]|\b(?:write_text|writeFileSync|writeFile|open\([^)]*["'][wa]b?["'])/;
export const shellWrites = (command: unknown): boolean => typeof command === "string" && WRITES.test(command);

export interface EvidenceDeps {
  mark: (terminal: string, dir: string, name: string) => Promise<string | null>;
  changedFrom: (terminal: string, dir: string, commit: string) => Promise<CheckpointFileChange[] | null>;
  changedSince: (terminal: string, dir: string, since: number) => Promise<CheckpointFileChange[] | null>;
  othersChangedSince: (terminal: string, dir: string, since: number, except: ReadonlySet<string>) => Promise<boolean>;
  now: () => number;
}

interface TestRun {
  at: number;
  command: string;
  passed: boolean;
  dir: string;
  /** The folder as the run ended; null where it can't be kept. */
  mark: Promise<string | null>;
}

const KIND: Record<CheckpointFileChange["kind"], Report["files"][number]["kind"]> = { added: "new", modified: "changed", deleted: "deleted" };

export class TaskEvidence {
  /** The last test run seen in each terminal. */
  private readonly runs = new Map<string, TestRun>();

  /** When each terminal last used a tool that edits files, and where. */
  private readonly edits = new Map<string, { at: number; dir: string }>();
  /** Terminals that say which tools they use: the rest are judged by what changed while they worked. */
  private readonly tells = new Set<string>();

  constructor(private readonly deps: EvidenceDeps) {}

  /** Another agent edited files here. Being busy here, as a manager waiting on its workers is, isn't that. */
  private editedBeside(terminal: string, dir: string, since: number): boolean {
    for (const [other, edit] of this.edits) if (other !== terminal && edit.dir === dir && edit.at >= since) return true;
    return false;
  }

  /** A tool was used in a terminal; a test run is kept, with the folder as it was when it ended. */
  toolUsed(terminal: string, dir: string | null, event: Parameters<typeof commandFrom>[0]): void {
    if (typeof event.tool_name === "string") {
      this.tells.add(terminal);
      const input = (event.tool_input ?? {}) as Record<string, unknown>;
      const shell = /^(Bash|shell|local_shell|exec_command|shell_command)$/i.test(event.tool_name) && shellWrites(Array.isArray(input.command) ? input.command.join(" ") : (input.command ?? input.cmd));
      if (dir && event.hook_event_name === "PreToolUse" && (shell || EDITS.test(event.tool_name))) this.edits.set(terminal, { at: this.deps.now(), dir });
    }
    const ran = commandFrom(event);
    const command = ran && testCommandIn(ran.command);
    if (!ran || !command || !dir) return;
    this.runs.set(terminal, {
      at: this.deps.now(),
      command,
      passed: ran.ok,
      dir,
      mark: this.deps.mark(terminal, dir, "tests").catch(() => null),
    });
  }

  forget(terminal: string): void {
    this.runs.delete(terminal);
    this.edits.delete(terminal);
    this.tells.delete(terminal);
  }

  /** What Tacit saw of a try: never anything the agent says. */
  async of(terminal: string, dir: string | null, since: number): Promise<Observed> {
    if (!dir) return { files: [], known: false, shared: false };
    const [changed, shared] = await Promise.all([
      this.deps.changedSince(terminal, dir, since).catch(() => null),
      this.editedBeside(terminal, dir, since) || this.deps.othersChangedSince(terminal, dir, since, this.tells).catch(() => false),
    ]);
    const run = this.runs.get(terminal);
    let tests: Observed["tests"];
    if (run && run.at >= since && run.dir === dir) {
      const mark = await run.mark;
      const later = mark ? await this.deps.changedFrom(terminal, dir, mark).catch(() => null) : null;
      // Whether anything changed after can't be told: then neither can that they passed on what's there now.
      if (!run.passed) tests = { command: run.command, passed: false, after: true };
      else if (later) tests = { command: run.command, passed: true, after: later.length === 0 };
    }
    return { files: (changed ?? []).map((f) => ({ path: f.path, kind: KIND[f.kind] })), known: changed !== null, shared, ...(tests ? { tests } : {}) };
  }
}
