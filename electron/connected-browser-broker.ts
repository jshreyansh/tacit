import { randomUUID } from "node:crypto";
import {
  capabilityForBrowserAction,
  isBrowserActionName,
  validateBrowserActionRequest,
  type BrowserActionName,
} from "../shared/browser-controller";
import { BrowserConnectionRegistry } from "./browser-connection-registry";

export interface ConnectedBrowserCommand {
  commandId: string;
  bindingId: string;
  tabId: number;
  action: BrowserActionName;
  params: Record<string, unknown>;
}

interface PendingResult {
  connectionId: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PollWaiter {
  resolve: (command: ConnectedBrowserCommand | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ConnectedBrowserBroker {
  private readonly queues = new Map<string, ConnectedBrowserCommand[]>();
  private readonly waiters = new Map<string, PollWaiter>();
  private readonly pending = new Map<string, PendingResult>();

  constructor(
    readonly registry: BrowserConnectionRegistry,
    private readonly commandTimeoutMs = 30_000,
  ) {}

  async execute(
    bindingId: string,
    actionInput: unknown,
    paramsInput: unknown,
  ): Promise<unknown> {
    if (!isBrowserActionName(actionInput)) throw new Error("Unknown connected-browser action");
    const invalid = validateBrowserActionRequest(actionInput, paramsInput);
    if (invalid) throw new Error(invalid);
    const capability = capabilityForBrowserAction(actionInput);
    if (capability === "non_portable_eval") {
      throw new Error("Arbitrary JavaScript is not available in connected browser tabs");
    }
    const action = actionInput;
    const params = paramsInput as Record<string, unknown>;
    const binding = this.registry.requireAuthorizedTabForApp(bindingId, capability);
    const command: ConnectedBrowserCommand = {
      commandId: randomUUID(),
      bindingId,
      tabId: binding.tab.tabId,
      action,
      params,
    };
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.commandId);
        this.removeQueuedCommand(binding.connectionId, command.commandId);
        reject(new Error("Connected browser did not respond before the command timeout"));
      }, this.commandTimeoutMs);
      this.pending.set(command.commandId, {
        connectionId: binding.connectionId,
        resolve,
        reject,
        timer,
      });
    });
    this.enqueue(binding.connectionId, command);
    return result;
  }

  poll(connectionId: string, token: string, waitMs = 20_000): Promise<ConnectedBrowserCommand | null> {
    this.registry.authenticate(connectionId, token);
    const queued = this.queues.get(connectionId)?.shift();
    if (queued) return Promise.resolve(queued);
    const previous = this.waiters.get(connectionId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(connectionId);
        resolve(null);
      }, Math.min(Math.max(waitMs, 0), 25_000));
      this.waiters.set(connectionId, { resolve, timer });
    });
  }

  settle(
    connectionId: string,
    token: string,
    commandId: string,
    result: { ok: boolean; data?: unknown; error?: string },
  ): void {
    this.registry.authenticate(connectionId, token);
    const pending = this.pending.get(commandId);
    if (!pending || pending.connectionId !== connectionId) {
      throw new Error("Browser command is stale or belongs to another connection");
    }
    clearTimeout(pending.timer);
    this.pending.delete(commandId);
    if (result.ok) pending.resolve(result.data);
    else pending.reject(new Error(result.error || "Connected browser action failed"));
  }

  revokeConnection(connectionId: string, token: string): void {
    this.registry.authenticate(connectionId, token);
    this.registry.revokeConnection(connectionId, token);
    this.queues.delete(connectionId);
    const waiter = this.waiters.get(connectionId);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
      this.waiters.delete(connectionId);
    }
    for (const [commandId, pending] of this.pending) {
      if (pending.connectionId !== connectionId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("Connected browser was disconnected"));
      this.pending.delete(commandId);
    }
  }

  private enqueue(connectionId: string, command: ConnectedBrowserCommand): void {
    const waiter = this.waiters.get(connectionId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(connectionId);
      waiter.resolve(command);
      return;
    }
    const queue = this.queues.get(connectionId) ?? [];
    queue.push(command);
    this.queues.set(connectionId, queue);
  }

  private removeQueuedCommand(connectionId: string, commandId: string): void {
    const queue = this.queues.get(connectionId);
    if (!queue) return;
    const next = queue.filter((command) => command.commandId !== commandId);
    if (next.length) this.queues.set(connectionId, next);
    else this.queues.delete(connectionId);
  }
}
