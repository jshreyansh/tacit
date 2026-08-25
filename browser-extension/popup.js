const pairing = document.querySelector("#pairing");
const connected = document.querySelector("#connected");
const status = document.querySelector("#status");
const identity = document.querySelector("#identity");

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("No connectable active tab");
  return tab;
}

async function render() {
  const state = await chrome.runtime.sendMessage({ type: "state" });
  pairing.hidden = Boolean(state?.paired);
  connected.hidden = !state?.paired;
  if (state?.paired) identity.textContent = `${state.browser} · ${state.profileLabel}`;
  try {
    const tab = await activeTab();
    document.querySelector("#tab-title").textContent = tab.title || "Untitled tab";
    document.querySelector("#tab-url").textContent = tab.url;
  } catch {}
}

document.querySelector("#pair").addEventListener("click", async () => {
  status.textContent = "Pairing…";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "pair",
      offer: document.querySelector("#offer").value.trim(),
      profileLabel: document.querySelector("#profile").value.trim(),
    });
    if (!result?.ok) throw new Error(result?.error || "Pairing failed");
    status.textContent = "Browser paired. Choose a tab to connect.";
    await render();
  } catch (error) { status.textContent = error.message; }
});

document.querySelector("#connect-tab").addEventListener("click", async () => {
  status.textContent = "Connecting tab…";
  try {
    const tab = await activeTab();
    const result = await chrome.runtime.sendMessage({ type: "connect-tab", tab });
    if (!result?.ok) throw new Error(result?.error || "Could not connect tab");
    status.textContent = "Connected. Return to Tacit to add it to the canvas.";
  } catch (error) { status.textContent = error.message; }
});

document.querySelector("#forget").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "forget" });
  status.textContent = "Browser connection removed.";
  await render();
});

void render();
