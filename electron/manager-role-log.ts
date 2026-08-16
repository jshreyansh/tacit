import fs from "node:fs";
import path from "node:path";
import {
  MANAGER_ROLE_SCHEMA_VERSION,
  toSessionRows,
  type ManagerSessionRow,
  type ManagerTenure,
} from "../shared/manager-role";

/**
 * Append-only log of workspace-manager tenures. See shared/manager-role.ts for
 * what a tenure is and why it is keyed on (terminal, session).
 *
 * Lives in main rather than the renderer because the two facts it joins arrive
 * in different places: the role assignment happens in the renderer, and the
 * session id arrives on the hook socket here. Main is the only process that
 * sees both.
 *
 * Same failure posture as the decision record — a write that fails is counted
 * and dropped, never raised. Losing a history row is a worse outcome than
 * losing the row, but it is a far better outcome than interrupting the work
 * being recorded.
 */
export class ManagerRoleLog {
  private readonly filePath: string;
  private current: ManagerTenure | null = null;
  private writeErrors = 0;
  private lastError: string | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Restores `current` from disk so a tenure survives an app restart. Without
   * this, every launch would open a second tenure for a role that never
   * actually changed hands, and the history list would fill with duplicates of
   * the same conversation.
   */
  load(): void {
    const tenures = this.readAll();
    const open = tenures.filter((t) => t.endedAt === null);
    this.current = open.length > 0 ? open[open.length - 1] : null;
  }

  getCurrent(): ManagerTenure | null {
    return this.current;
  }

  /**
   * The role moved. Closes any open tenure and opens a new one unless the role
   * was removed outright.
   */
  setRole(
    input: { terminalId: string; cli: string | null; canvasId: string | null } | null,
    now = new Date(),
  ): void {
    if (this.current && this.current.terminalId === input?.terminalId) {
      // Re-assigning the terminal that already holds it is a no-op, not a new
      // tenure — the pill re-runs this on some paths.
      return;
    }
    this.close(input ? "reassigned" : "unassigned", now);
    if (!input) return;
    this.open(input.terminalId, null, input.cli, input.canvasId, now);
  }

  /**
   * A session started in some terminal. Only interesting when it is the
   * terminal currently holding the role: either it is the session the tenure
   * was waiting for, or the conversation was replaced underneath it.
   */
  noteSessionStart(terminalId: string, sessionId: string, now = new Date()): void {
    const current = this.current;
    if (!current || current.terminalId !== terminalId) return;
    if (current.sessionId === sessionId) return;

    if (current.sessionId === null) {
      // The tenure was opened before the agent reported a session. Close the
      // placeholder and reopen with the id rather than editing the written
      // line — the file is append-only, and a reader that saw the first line
      // must still be able to reach the same conclusion.
      this.close("cleared", now);
      this.open(terminalId, sessionId, current.cli, current.canvasId, now);
      return;
    }

    // Same terminal, different conversation — a /clear or a compact restart.
    this.close("cleared", now);
    this.open(terminalId, sessionId, current.cli, current.canvasId, now);
  }

  /** Rows for the history dropdown, newest first. */
  listSessions(): ManagerSessionRow[] {
    return toSessionRows(this.readAll());
  }

  getHealth(): { filePath: string; writeErrors: number; lastError: string | null } {
    return {
      filePath: this.filePath,
      writeErrors: this.writeErrors,
      lastError: this.lastError,
    };
  }

  private open(
    terminalId: string,
    sessionId: string | null,
    cli: string | null,
    canvasId: string | null,
    now: Date,
  ): void {
    const tenure: ManagerTenure = {
      schema_version: MANAGER_ROLE_SCHEMA_VERSION,
      terminalId,
      sessionId,
      cli,
      canvasId,
      startedAt: now.toISOString(),
      endedAt: null,
    };
    this.current = tenure;
    this.append(tenure);
  }

  private close(endedBy: ManagerTenure["endedBy"], now: Date): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    this.append({ ...current, endedAt: now.toISOString(), endedBy });
  }

  private append(tenure: ManagerTenure): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(tenure)}\n`, "utf-8");
    } catch (err) {
      this.writeErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn("[ManagerRoleLog] failed to append tenure:", this.lastError);
    }
  }

  private readAll(): ManagerTenure[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      return fs
        .readFileSync(this.filePath, "utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as ManagerTenure];
          } catch {
            // One corrupt line must not cost the whole history — an append-only
            // file can be truncated mid-write by a hard kill.
            return [];
          }
        });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return [];
    }
  }
}

export function getManagerRoleLogPath(termcanvasDir: string): string {
  return path.join(termcanvasDir, "manager-sessions.jsonl");
}
