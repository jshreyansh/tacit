import type { BrowserBackendAdapter } from "./browserController";
import { getBrowserWebview } from "../canvas/browserWebviewRegistry";

export const legacyWebviewBrowserAdapter: BrowserBackendAdapter = {
  kind: "managed",
  capabilities: new Set([
    "inspect",
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "non_portable_eval",
  ]),
  async execute(card, binding, request) {
    if (binding.kind !== "managed" || binding.engine !== "legacy-webview") {
      throw new Error("Managed browser binding is incompatible with the legacy webview adapter");
    }
    const webview = getBrowserWebview(card.id);
    if (!webview) throw new Error(`Browser tile not found or not mounted: ${card.id}`);
    switch (request.action) {
      case "navigate":
        await webview.loadURL(request.params.url as string);
        return { url: webview.getURL(), title: webview.getTitle() };
      case "read": {
        const text = await webview.executeJavaScript("document.body ? document.body.innerText : ''");
        return { url: webview.getURL(), title: webview.getTitle(), text };
      }
      case "back":
        webview.goBack();
        return { ok: true };
      case "forward":
        webview.goForward();
        return { ok: true };
      case "reload":
        webview.reload();
        return { ok: true };
      case "click": {
        const selector = request.params.selector as string;
        const clicked = await webview.executeJavaScript(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
        );
        if (!clicked) throw new Error(`No element matched selector: ${selector}`);
        return { ok: true };
      }
      case "eval":
        return { result: await webview.executeJavaScript(request.params.script as string) };
    }
  },
};

