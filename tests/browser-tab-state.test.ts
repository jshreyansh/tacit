import test from "node:test";
import assert from "node:assert/strict";
import { keepableFavicon, useBrowserTabStateStore } from "../src/stores/browserTabStateStore";
import { buildWorkdeskSections } from "../src/workdesk/workdeskModel";

test("a page's icon is kept when it's https or a small data URL", () => {
  assert.equal(keepableFavicon("https://www.youtube.com/s/desktop/favicon.ico"), "https://www.youtube.com/s/desktop/favicon.ico");
  assert.equal(keepableFavicon("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
  assert.equal(keepableFavicon("http://example.com/favicon.ico"), null);
  assert.equal(keepableFavicon("javascript:alert(1)"), null);
  assert.equal(keepableFavicon(`data:image/png;base64,${"A".repeat(20_000)}`), null);
  assert.equal(keepableFavicon(undefined), null);
});

test("a tab's state: loading, sound and mute, forgotten when the node goes", () => {
  const store = useBrowserTabStateStore.getState();
  store.set("b1", { loading: true });
  store.set("b1", { audible: true });
  assert.deepEqual(useBrowserTabStateStore.getState().tabs.b1, { loading: true, audible: true, muted: false });
  const before = useBrowserTabStateStore.getState().tabs;
  store.set("b1", { loading: true });
  assert.equal(useBrowserTabStateStore.getState().tabs, before, "an unchanged state leaves the store alone");
  store.forget("b1");
  assert.equal(useBrowserTabStateStore.getState().tabs.b1, undefined);
});

test("recent downloads: newest first, five at most, no repeats", () => {
  const store = useBrowserTabStateStore.getState();
  for (let i = 1; i <= 6; i += 1) store.addDownload(`f${i}.zip`, `tok${i}`);
  store.addDownload("f3.zip", "tok3");
  assert.deepEqual(useBrowserTabStateStore.getState().downloads.map((d) => d.filename), ["f3.zip", "f6.zip", "f5.zip", "f4.zip", "f2.zip"]);
});

test("a browser card in the grid carries its page's icon", () => {
  const sections = buildWorkdeskSections({
    projects: [],
    telemetry: new Map(),
    browsers: [{ id: "b1", url: "https://youtube.com", title: "YouTube", identityId: "i1", favicon: "https://youtube.com/favicon.ico" }],
    identityNames: {},
    tasks: [],
    notes: [],
    managerTerminalId: null,
  });
  assert.equal(sections.browserGroups[0].cards[0].favicon, "https://youtube.com/favicon.ico");
});
