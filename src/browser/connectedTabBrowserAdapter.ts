import { capabilityForBrowserAction } from "../../shared/browser-controller";
import type { BrowserBackendAdapter } from "./browserController";

export const connectedTabBrowserAdapter: BrowserBackendAdapter = {
  kind: "connected-tab",
  capabilities: new Set([
    "inspect",
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
  ]),
  async execute(_card, binding, request) {
    if (binding.kind !== "connected-tab") {
      throw new Error("Connected-tab adapter received an incompatible browser binding");
    }
    const capability = capabilityForBrowserAction(request.action);
    if (capability === "non_portable_eval") {
      throw new Error("Arbitrary JavaScript is not portable to connected browser tabs");
    }
    return window.tacit.browserConnection.execute({
      bindingId: binding.tabBindingId,
      action: request.action,
      params: request.params,
    });
  },
};
