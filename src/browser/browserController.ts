import {
  capabilityForBrowserAction,
  isBrowserActionName,
  managedBrowserBinding,
  validateBrowserActionRequest,
  type BrowserActionName,
  type BrowserActionRequest,
  type BrowserActionResult,
  type BrowserBackendKind,
  type BrowserControllerCapability,
  type BrowserNodeBinding,
} from "../../shared/browser-controller";
import type { BrowserCardData } from "../stores/browserCardStore";

export interface BrowserBackendAdapter {
  kind: BrowserBackendKind;
  capabilities: ReadonlySet<BrowserControllerCapability>;
  execute(
    card: BrowserCardData,
    binding: BrowserNodeBinding,
    request: BrowserActionRequest,
  ): Promise<unknown>;
}

export class BrowserController {
  private readonly adapters = new Map<BrowserBackendKind, BrowserBackendAdapter>();

  register(adapter: BrowserBackendAdapter): void {
    this.adapters.set(adapter.kind, adapter);
  }

  async execute(
    card: BrowserCardData,
    actionInput: string,
    params: Record<string, unknown> = {},
  ): Promise<BrowserActionResult> {
    const binding = resolveBrowserNodeBinding(card);
    if (!isBrowserActionName(actionInput)) {
      return failure(binding.kind, "navigate", "invalid_request", `Unknown browser action: ${actionInput}`, false);
    }
    const action = actionInput;
    const capability = capabilityForBrowserAction(action);
    const adapter = this.adapters.get(binding.kind);
    if (!adapter) {
      return failure(binding.kind, capability, "backend_unavailable", `Browser backend is unavailable: ${binding.kind}`, true);
    }
    if (!adapter.capabilities.has(capability)) {
      return failure(
        binding.kind,
        capability,
        "capability_missing",
        `The ${binding.kind} browser backend does not support ${capability}`,
        false,
      );
    }
    const invalid = validateBrowserActionRequest(action, params);
    if (invalid) {
      return failure(binding.kind, capability, "invalid_request", invalid, false);
    }
    try {
      const data = await adapter.execute(card, binding, { action, params });
      return { ok: true, backend: binding.kind, capability, data };
    } catch (error) {
      return failure(
        binding.kind,
        capability,
        "execution_failed",
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }
}

export function resolveBrowserNodeBinding(card: BrowserCardData): BrowserNodeBinding {
  return card.backend ?? managedBrowserBinding(card.identityId);
}

function failure(
  backend: BrowserBackendKind,
  capability: BrowserControllerCapability,
  code: Extract<BrowserActionResult, { ok: false }>["error"]["code"],
  message: string,
  retryable: boolean,
): BrowserActionResult {
  return { ok: false, backend, capability, error: { code, message, retryable } };
}
