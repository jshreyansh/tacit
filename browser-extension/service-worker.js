const PROTOCOL_VERSION = 1;
const CAPABILITIES = ["inspect", "navigate", "back", "forward", "reload", "click"];
let polling = false;

async function stored() {
  return chrome.storage.local.get(["endpoint", "connectionId", "token", "browser", "profileLabel"]);
}

function browserFamily() {
  if (navigator.userAgent.includes("Edg/")) return "edge";
  // Brave intentionally identifies as Chromium; its extension API exposes this marker.
  if (navigator.brave) return "brave";
  return "chrome";
}

async function post(endpoint, path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Tacit returned ${response.status}`);
  return payload;
}

async function pair(offer, profileLabel) {
  const split = offer.lastIndexOf("#");
  if (split < 1 || !profileLabel) throw new Error("Connection and profile label are required");
  const endpoint = offer.slice(0, split).replace(/\/$/, "");
  const code = offer.slice(split + 1);
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error("Connection must point to local Tacit");
  const browser = browserFamily();
  const result = await post(endpoint, "/browser-connect/complete", {
    code,
    browser,
    profileLabel,
    extensionId: chrome.runtime.id,
    protocolVersion: PROTOCOL_VERSION,
  });
  await chrome.storage.local.set({
    endpoint,
    connectionId: result.connection.id,
    token: result.token,
    browser,
    profileLabel,
  });
  void pollLoop();
}

async function connectTab(tab) {
  const state = await stored();
  if (!state.connectionId || !state.token) throw new Error("Pair this browser first");
  return post(state.endpoint, "/browser-connect/tab", {
    connectionId: state.connectionId,
    token: state.token,
    tab: { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title || tab.url },
    capabilities: CAPABILITIES,
  });
}

async function forget() {
  const state = await stored();
  if (state.endpoint && state.connectionId && state.token) {
    await post(state.endpoint, "/browser-connect/revoke", {
      connectionId: state.connectionId,
      token: state.token,
    }).catch(() => {});
  }
  await chrome.storage.local.clear();
}

async function execute(command) {
  const target = { tabId: command.tabId };
  const describeTab = async () => {
    const tab = await chrome.tabs.get(command.tabId);
    return { url: tab.url || "", title: tab.title || tab.url || "" };
  };
  switch (command.action) {
    case "navigate":
      await chrome.tabs.update(command.tabId, { url: command.params.url });
      return describeTab();
    case "back": await chrome.tabs.goBack(command.tabId); return describeTab();
    case "forward": await chrome.tabs.goForward(command.tabId); return describeTab();
    case "reload": await chrome.tabs.reload(command.tabId); return describeTab();
  }
  await chrome.debugger.attach(target, "1.3");
  try {
    let expression;
    if (command.action === "read") {
      expression = "({url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 200000)})";
    } else if (command.action === "click") {
      expression = `(() => { const el = document.querySelector(${JSON.stringify(command.params.selector)}); if (!el) return {ok:false}; el.click(); return {ok:true}; })()`;
    } else {
      throw new Error(`Unsupported connected-browser action: ${command.action}`);
    }
    const response = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const value = response?.result?.value;
    if (command.action === "click" && !value?.ok) throw new Error("No element matched selector");
    return value;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const state = await stored();
      if (!state.connectionId || !state.token) return;
      let command;
      try {
        command = await post(state.endpoint, "/browser-connect/poll", {
          connectionId: state.connectionId,
          token: state.token,
          waitMs: 20_000,
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        continue;
      }
      if (!command?.commandId) continue;
      let result;
      try { result = { ok: true, data: await execute(command) }; }
      catch (error) { result = { ok: false, error: error.message }; }
      await post(state.endpoint, "/browser-connect/result", {
        connectionId: state.connectionId,
        token: state.token,
        commandId: command.commandId,
        result,
      }).catch(() => {});
    }
  } finally { polling = false; }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (message.type === "state") {
        const state = await stored();
        return { paired: Boolean(state.connectionId), browser: state.browser, profileLabel: state.profileLabel };
      }
      if (message.type === "pair") { await pair(message.offer, message.profileLabel); return { ok: true }; }
      if (message.type === "connect-tab") return { ok: true, binding: await connectTab(message.tab) };
      if (message.type === "forget") { await forget(); return { ok: true }; }
      return { ok: false, error: "Unknown extension request" };
    } catch (error) { return { ok: false, error: error.message }; }
  })().then(sendResponse);
  return true;
});

chrome.runtime.onStartup.addListener(() => { void pollLoop(); });
chrome.runtime.onInstalled.addListener(() => { void pollLoop(); });
void pollLoop();
