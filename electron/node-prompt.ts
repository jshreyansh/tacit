import { findAgentAdapter } from "../shared/agent-adapters";

/**
 * Backs the send_prompt_to_node MCP tool: the workspace manager speaking to
 * one worker, rather than emit_event's broadcast to everything wired to it.
 *
 * Kept out of api-server.ts so the rules (validation, idempotency, what gets
 * recorded) can be tested without a window or a renderer; the server supplies
 * the lookup, delivery and recording.
 */

export interface PromptTargetNode {
  kind: "terminal" | "browser" | "pin";
  id: string;
  /** Terminal only: null while its PTY has not started or has exited. */
  ptyId?: number | null;
  terminalType?: string | null;
  worktreePath?: string | null;
}

export interface PromptDelivery {
  terminalId: string;
  ptyId: number;
  terminalType: string;
  worktreePath: string;
  text: string;
}

export interface NodePromptDeps {
  findNode: (id: string) => Promise<PromptTargetNode | null>;
  deliver: (delivery: PromptDelivery) => Promise<{ ok: boolean; detail?: string }>;
  /** Writes the decision-record entry: who told which node what. */
  recordPrompt: (entry: { target: string; by: string; text: string }) => void;
  now?: () => number;
}

export interface SendPromptResult {
  ok: true;
  id: string;
  /** True when an earlier call with the same idempotency_key already sent it. */
  duplicate: boolean;
}

/** An agent retrying a timed-out tool call arrives well inside this. */
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

/**
 * Prefixed for an agent so it can tell its manager from its user; without it
 * an instruction arriving mid-conversation reads as the person changing their
 * mind. A shell gets the text as-is: it would run the prefix as part of the
 * command (zsh: "bad pattern: [From").
 */
export function managerPromptText(prompt: string, terminalType: string): string {
  return findAgentAdapter(terminalType) ? `[From the workspace manager] ${prompt}` : prompt;
}

function fail(status: number, code: string, message: string): never {
  throw Object.assign(new Error(message), { status, code });
}

export class NodePromptSender {
  /** Keyed by manager and key, so two managers never collide. */
  private readonly sent = new Map<
    string,
    { at: number; result: Promise<SendPromptResult> }
  >();

  constructor(private readonly deps: NodePromptDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * `managerId` must already have passed the workspace-manager gate; this
   * checks only the request itself.
   */
  async send(managerId: string, body: unknown): Promise<SendPromptResult> {
    const input = (body ?? {}) as Record<string, unknown>;
    const id = input.id;
    const prompt = input.prompt;
    const key = input.idempotency_key;

    if (typeof id !== "string" || id.trim() === "") {
      fail(400, "invalid_id", "id is required: the terminal to send to (from list_nodes).");
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      fail(400, "empty_prompt", "prompt is empty; nothing was sent.");
    }
    if (key !== undefined && (typeof key !== "string" || key.trim() === "")) {
      fail(400, "invalid_idempotency_key", "idempotency_key must be a non-empty string when given.");
    }
    if (id === managerId) {
      fail(400, "self_target", "That id is you. send_prompt_to_node is for talking to another terminal.");
    }

    if (typeof key !== "string") return this.deliver(managerId, id, prompt);

    this.sweep();
    const slot = `${managerId}\0${key}`;
    const earlier = this.sent.get(slot);
    if (earlier) {
      return earlier.result.then((result) => ({ ...result, duplicate: true }));
    }
    // Stored before anything in this call awaits, so a retry that races the
    // first call joins it instead of sending a second copy.
    const result = this.deliver(managerId, id, prompt);
    this.sent.set(slot, { at: this.now(), result });
    // A failed send must stay retryable under the same key.
    result.catch(() => this.sent.delete(slot));
    return result;
  }

  private async deliver(
    managerId: string,
    id: string,
    prompt: string,
  ): Promise<SendPromptResult> {
    const node = await this.deps.findNode(id);
    if (!node) {
      fail(404, "not_found", `No node with id "${id}" on this canvas. Call list_nodes for current ids.`);
    }
    if (node.kind !== "terminal") {
      fail(
        400,
        "not_a_terminal",
        `"${id}" is a ${node.kind === "pin" ? "note" : node.kind}, not a terminal. Only terminals take prompts.`,
      );
    }
    if (node.ptyId == null || !node.terminalType || !node.worktreePath) {
      fail(409, "not_running", `Terminal "${id}" is not running, so it can't take a prompt.`);
    }

    const text = managerPromptText(prompt, node.terminalType);
    const delivered = await this.deps.deliver({
      terminalId: id,
      ptyId: node.ptyId,
      terminalType: node.terminalType,
      worktreePath: node.worktreePath,
      text,
    });
    if (!delivered.ok) {
      fail(
        409,
        "delivery_failed",
        `Couldn't deliver to "${id}": ${delivered.detail ?? "the terminal refused the input"}.`,
      );
    }
    this.deps.recordPrompt({ target: id, by: managerId, text });
    return { ok: true, id, duplicate: false };
  }

  private sweep(): void {
    const now = this.now();
    for (const [slot, entry] of this.sent) {
      if (now - entry.at > IDEMPOTENCY_TTL_MS) this.sent.delete(slot);
    }
  }
}
