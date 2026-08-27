import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildBrowserContextMenu,
  type BrowserContextMenuEntry,
} from "../electron/browser-context-menu";
import {
  MAX_DOWNLOAD_FILENAME_LENGTH,
  resolveDownloadSavePath,
  safeDownloadFilename,
} from "../electron/browser-downloads";
import { resolveGuestShortcut, type GuestKeyInput } from "../electron/browser-guest-shortcuts";
import {
  BROWSER_ZOOM_STEPS,
  DEFAULT_BROWSER_ZOOM,
  MAX_BROWSER_ZOOM,
  MIN_BROWSER_ZOOM,
  clampBrowserZoom,
  formatBrowserZoom,
  isDefaultBrowserZoom,
  stepBrowserZoom,
} from "../src/browser/pageZoom";
import {
  downloadDoneNotice,
  downloadStartedNotice,
} from "../src/browser/downloadNotice";

/**
 * The comfort features from step 2 of the browser adoption plan: context menu,
 * find-in-page, page zoom and downloads. Everything here is the decision half
 * of a feature whose other half is an Electron callback — the split exists so
 * these can be asserted without a live guest to right-click on.
 */

function menuInput(overrides: Partial<Parameters<typeof buildBrowserContextMenu>[0]> = {}) {
  return {
    linkUrl: "",
    isEditable: false,
    canCopy: false,
    canPaste: false,
    canGoBack: false,
    canGoForward: false,
    hasProfile: true,
    isDev: false,
    ...overrides,
  };
}

function actions(entries: BrowserContextMenuEntry[]): string[] {
  return entries.map((entry) =>
    entry.kind === "separator" ? "---" : entry.action,
  );
}

test("the context menu always offers navigation, greyed rather than absent", () => {
  const entries = buildBrowserContextMenu(menuInput());
  assert.deepEqual(actions(entries), ["back", "forward", "reload", "---", "copy"]);

  const back = entries.find((e) => e.kind === "item" && e.action === "back");
  assert.equal(back?.kind === "item" && back.enabled, false);

  const withHistory = buildBrowserContextMenu(
    menuInput({ canGoBack: true, canGoForward: true }),
  );
  const forward = withHistory.find((e) => e.kind === "item" && e.action === "forward");
  assert.equal(forward?.kind === "item" && forward.enabled, true);
});

test("link items appear only on a link, and need a profile to inherit", () => {
  const onPage = buildBrowserContextMenu(menuInput());
  assert.ok(!actions(onPage).includes("open-link-in-node"));
  assert.ok(!actions(onPage).includes("copy-link"));

  const onLink = buildBrowserContextMenu(
    menuInput({ linkUrl: "https://example.com/doc" }),
  );
  assert.deepEqual(actions(onLink), [
    "back",
    "forward",
    "reload",
    "---",
    "open-link-in-node",
    "copy-link",
    "---",
    "copy",
  ]);

  // A guest with no profile of ours has no partition for a new node to open
  // as — but the address is still worth copying.
  const orphan = buildBrowserContextMenu(
    menuInput({ linkUrl: "https://example.com/doc", hasProfile: false }),
  );
  const openItem = orphan.find((e) => e.kind === "item" && e.action === "open-link-in-node");
  assert.equal(openItem?.kind === "item" && openItem.enabled, false);
  const copyLink = orphan.find((e) => e.kind === "item" && e.action === "copy-link");
  assert.equal(copyLink?.kind === "item" && copyLink.enabled, true);
});

test("paste is offered only where it can land, and Inspect only in dev", () => {
  const readOnly = buildBrowserContextMenu(menuInput({ canCopy: true }));
  assert.ok(!actions(readOnly).includes("paste"));

  const field = buildBrowserContextMenu(
    menuInput({ isEditable: true, canPaste: true }),
  );
  const paste = field.find((e) => e.kind === "item" && e.action === "paste");
  assert.equal(paste?.kind === "item" && paste.enabled, true);

  assert.ok(!actions(buildBrowserContextMenu(menuInput())).includes("inspect"));
  assert.ok(actions(buildBrowserContextMenu(menuInput({ isDev: true }))).includes("inspect"));
});

test("the menu never renders a leading, trailing or doubled separator", () => {
  const cases = [
    menuInput(),
    menuInput({ isDev: true }),
    menuInput({ linkUrl: "https://example.com", isEditable: true, isDev: true }),
    menuInput({ linkUrl: "https://example.com" }),
  ];
  for (const input of cases) {
    const rendered = actions(buildBrowserContextMenu(input));
    assert.notEqual(rendered[0], "---");
    assert.notEqual(rendered[rendered.length - 1], "---");
    for (let i = 1; i < rendered.length; i += 1) {
      assert.ok(
        !(rendered[i] === "---" && rendered[i - 1] === "---"),
        `doubled separator in ${rendered.join(",")}`,
      );
    }
  }
});

test("a page-suggested download name is reduced to one safe path segment", () => {
  assert.equal(safeDownloadFilename("report.pdf"), "report.pdf");
  // Traversal is the whole reason this function exists: path.join is perfectly
  // happy to walk out of the Downloads folder when handed one of these.
  assert.equal(safeDownloadFilename("../../.ssh/authorized_keys"), ".._.._.ssh_authorized_keys");
  assert.equal(safeDownloadFilename("/etc/passwd"), "_etc_passwd");
  assert.equal(safeDownloadFilename("C:\\Windows\\system32\\evil.exe"), "C__Windows_system32_evil.exe");
  assert.equal(safeDownloadFilename(".."), "download");
  assert.equal(safeDownloadFilename("."), "download");
  assert.equal(safeDownloadFilename("   "), "download");
  assert.equal(safeDownloadFilename("bad\u0000name.txt"), "bad_name.txt");

  // A dotfile has no stem to number and no extension to protect.
  assert.equal(safeDownloadFilename(".bashrc"), ".bashrc");
  // Windows would silently drop the trailing dot, leaving us reporting a name
  // that is not the one on disk.
  assert.equal(safeDownloadFilename("notes."), "notes.");
  assert.equal(safeDownloadFilename("con.txt"), "con_file.txt");

  const long = safeDownloadFilename(`${"n".repeat(400)}.tar.gz`);
  assert.ok(long.length <= MAX_DOWNLOAD_FILENAME_LENGTH);
  assert.ok(long.endsWith(".gz"), "the extension survives, the stem is what gets cut");
});

test("downloads never overwrite, and never leave the Downloads folder", () => {
  const dir = "/Users/someone/Downloads";
  const taken = new Set([
    path.join(dir, "invoice.pdf"),
    path.join(dir, "invoice (1).pdf"),
  ]);

  const first = resolveDownloadSavePath({
    directory: dir,
    suggested: "invoice.pdf",
    exists: (candidate) => taken.has(candidate),
  });
  assert.equal(first.filename, "invoice (2).pdf");
  assert.equal(first.filePath, path.join(dir, "invoice (2).pdf"));

  const fresh = resolveDownloadSavePath({
    directory: dir,
    suggested: "notes.txt",
    exists: () => false,
  });
  assert.equal(fresh.filename, "notes.txt");

  const hostile = resolveDownloadSavePath({
    directory: dir,
    suggested: "../../../etc/cron.d/payload",
    exists: () => false,
  });
  assert.equal(path.dirname(hostile.filePath), dir);

  // Pathological case: every numbered variant taken. Still collision-free,
  // still inside the directory.
  const stamped = resolveDownloadSavePath({
    directory: dir,
    suggested: "a.txt",
    exists: (candidate) => !candidate.includes("(1700000000000)"),
    now: () => 1700000000000,
  });
  assert.equal(stamped.filename, "a (1700000000000).txt");
});

test("a cancelled download says nothing; the others say what happened", () => {
  assert.equal(downloadDoneNotice("cancelled", "x.pdf"), null);
  assert.equal(downloadDoneNotice("completed", "x.pdf")?.type, "info");
  assert.match(
    downloadDoneNotice("completed", "x.pdf")?.message ?? "",
    /Downloads folder/,
  );
  assert.equal(downloadDoneNotice("interrupted", "x.pdf")?.type, "error");
  assert.match(downloadStartedNotice("x.pdf").message, /x\.pdf/);
});

function key(overrides: Partial<GuestKeyInput> = {}): GuestKeyInput {
  return {
    type: "keyDown",
    key: "f",
    control: false,
    meta: false,
    shift: false,
    alt: false,
    ...overrides,
  };
}

test("only four chords are ever recognised inside a page", () => {
  assert.equal(resolveGuestShortcut(key({ meta: true }), "darwin"), "find");
  assert.equal(resolveGuestShortcut(key({ key: "=", meta: true }), "darwin"), "zoom-in");
  assert.equal(resolveGuestShortcut(key({ key: "+", meta: true }), "darwin"), "zoom-in");
  assert.equal(resolveGuestShortcut(key({ key: "-", meta: true }), "darwin"), "zoom-out");
  assert.equal(resolveGuestShortcut(key({ key: "_", meta: true }), "darwin"), "zoom-out");
  assert.equal(resolveGuestShortcut(key({ key: "0", meta: true }), "darwin"), "zoom-reset");

  // Everything else the user types in a page they are logged into stays there.
  for (const plain of ["a", "e", "1", "Enter", "Tab", "z"]) {
    assert.equal(resolveGuestShortcut(key({ key: plain }), "darwin"), null);
    assert.equal(resolveGuestShortcut(key({ key: plain, meta: true }), "darwin"), null);
  }
  assert.equal(resolveGuestShortcut(key({ meta: true, type: "keyUp" }), "darwin"), null);
  assert.equal(resolveGuestShortcut(key({ meta: true, alt: true }), "darwin"), null);
  // Shift+Cmd+F is the app's own star-focused chord.
  assert.equal(resolveGuestShortcut(key({ meta: true, shift: true }), "darwin"), null);
  // Ctrl+Cmd+F is macOS fullscreen, not find.
  assert.equal(resolveGuestShortcut(key({ meta: true, control: true }), "darwin"), null);
});

test("the primary modifier follows the platform", () => {
  assert.equal(resolveGuestShortcut(key({ control: true }), "darwin"), null);
  assert.equal(resolveGuestShortcut(key({ control: true }), "win32"), "find");
  assert.equal(resolveGuestShortcut(key({ control: true }), "linux"), "find");
  assert.equal(resolveGuestShortcut(key({ meta: true }), "win32"), null);
});

test("page zoom steps through Chrome's ladder and stops at both ends", () => {
  assert.equal(stepBrowserZoom(1, "in"), 1.1);
  assert.equal(stepBrowserZoom(1, "out"), 0.9);
  assert.equal(stepBrowserZoom(MAX_BROWSER_ZOOM, "in"), MAX_BROWSER_ZOOM);
  assert.equal(stepBrowserZoom(MIN_BROWSER_ZOOM, "out"), MIN_BROWSER_ZOOM);

  // A value between steps — a snapshot written against a different ladder —
  // still moves by exactly one visible step.
  assert.equal(stepBrowserZoom(1.05, "in"), 1.1);
  assert.equal(stepBrowserZoom(1.05, "out"), 1);

  // Every step is reachable by repeated pressing, in both directions.
  let up = MIN_BROWSER_ZOOM;
  const climbed = [up];
  for (let i = 0; i < BROWSER_ZOOM_STEPS.length; i += 1) {
    const next = stepBrowserZoom(up, "in");
    if (next === up) break;
    up = next;
    climbed.push(up);
  }
  assert.deepEqual(climbed, [...BROWSER_ZOOM_STEPS]);

  assert.equal(clampBrowserZoom(99), MAX_BROWSER_ZOOM);
  assert.equal(clampBrowserZoom(0), DEFAULT_BROWSER_ZOOM);
  assert.equal(clampBrowserZoom(Number.NaN), DEFAULT_BROWSER_ZOOM);
  assert.equal(formatBrowserZoom(1.25), "125%");
  assert.equal(isDefaultBrowserZoom(1), true);
  assert.equal(isDefaultBrowserZoom(1.1), false);
});

function installBrowserGlobals() {
  const storage = new Map<string, string>();
  const navigator = { language: "en-US", userAgent: "node-test" };
  const localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerHeight: 900,
      innerWidth: 1440,
      localStorage,
      navigator,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
      termcanvas: undefined,
    },
  });
}

/** Stands in for the guest; Chromium's search is not ours to reimplement. */
function stubWebview() {
  const calls: Array<{ text: string; forward: boolean; findNext: boolean }> = [];
  const stops: string[] = [];
  return {
    calls,
    stops,
    tag: {
      findInPage(text: string, options: { forward?: boolean; findNext?: boolean }) {
        calls.push({
          text,
          forward: options.forward !== false,
          findNext: options.findNext === true,
        });
        return calls.length;
      },
      stopFindInPage(action: string) {
        stops.push(action);
      },
    },
  };
}

test("find-in-page starts a search once and then advances it", async () => {
  installBrowserGlobals();
  const { useBrowserFindStore } = await import("../src/stores/browserFindStore.ts");
  const { registerBrowserWebview, unregisterBrowserWebview } = await import(
    "../src/canvas/browserWebviewRegistry.ts"
  );

  const guest = stubWebview();
  registerBrowserWebview("card-1", guest.tag as never);
  try {
    const find = useBrowserFindStore.getState();
    find.openFor("card-1");
    assert.equal(useBrowserFindStore.getState().openCardId, "card-1");
    assert.equal(useBrowserFindStore.getState().focusNonce > 0, true);

    find.setQuery("invoice");
    assert.deepEqual(guest.calls, [{ text: "invoice", forward: true, findNext: false }]);

    // Chromium gets "next match" wrong if it never saw the first request, so
    // the first call for a query must be findNext:false and the rest true.
    find.findNext();
    find.findPrevious();
    assert.deepEqual(guest.calls.slice(1), [
      { text: "invoice", forward: true, findNext: true },
      { text: "invoice", forward: false, findNext: true },
    ]);

    // Counts come from the guest, not from us.
    useBrowserFindStore
      .getState()
      .reportResult("card-1", { activeMatchOrdinal: 2, matches: 7 });
    assert.equal(useBrowserFindStore.getState().activeMatch, 2);
    assert.equal(useBrowserFindStore.getState().matches, 7);

    // A result from a node we are not searching is stale by construction.
    useBrowserFindStore
      .getState()
      .reportResult("card-2", { activeMatchOrdinal: 1, matches: 99 });
    assert.equal(useBrowserFindStore.getState().matches, 7);

    // A new query restarts rather than advances, and blanks the counts so a
    // stale "2 / 7" cannot read as a match for what was just typed.
    useBrowserFindStore.getState().setQuery("invoice2");
    assert.deepEqual(guest.calls[guest.calls.length - 1], {
      text: "invoice2",
      forward: true,
      findNext: false,
    });
    assert.equal(useBrowserFindStore.getState().matches, 0);

    // Emptying the box clears the highlights rather than searching for "".
    useBrowserFindStore.getState().setQuery("");
    assert.deepEqual(guest.stops, ["clearSelection"]);

    useBrowserFindStore.getState().close();
    assert.equal(useBrowserFindStore.getState().openCardId, null);
    assert.equal(useBrowserFindStore.getState().query, "");
  } finally {
    unregisterBrowserWebview("card-1");
    useBrowserFindStore.getState().close();
  }
});

test("find survives a node that disappears, and re-pressing keeps the query", async () => {
  installBrowserGlobals();
  const { useBrowserFindStore } = await import("../src/stores/browserFindStore.ts");
  const { registerBrowserWebview, unregisterBrowserWebview } = await import(
    "../src/canvas/browserWebviewRegistry.ts"
  );

  const guest = stubWebview();
  registerBrowserWebview("card-1", guest.tag as never);
  try {
    useBrowserFindStore.getState().openFor("card-1");
    useBrowserFindStore.getState().setQuery("term");
    const nonce = useBrowserFindStore.getState().focusNonce;

    // Second ⌘F on the same node: re-focus the box, keep what is in it.
    useBrowserFindStore.getState().openFor("card-1");
    assert.equal(useBrowserFindStore.getState().query, "term");
    assert.equal(useBrowserFindStore.getState().focusNonce, nonce + 1);

    // The guest going away — closed, or remounted onto another profile —
    // closes the bar without trying to clear a search in a page that is gone.
    unregisterBrowserWebview("card-1");
    const stopsBefore = guest.stops.length;
    useBrowserFindStore.getState().detach("card-1");
    assert.equal(useBrowserFindStore.getState().openCardId, null);
    assert.equal(guest.stops.length, stopsBefore);

    // Searching a node with no guest attached is a no-op, not a throw.
    useBrowserFindStore.getState().openFor("card-gone");
    useBrowserFindStore.getState().setQuery("anything");
    assert.equal(useBrowserFindStore.getState().matches, 0);
  } finally {
    useBrowserFindStore.getState().close();
  }
});

test("a browser node holds the keyboard only when nothing else does", async () => {
  installBrowserGlobals();
  const { resolveFocusedBrowserCard } = await import("../src/browser/browserNodeFocus.ts");

  const managed = { isManagedCard: () => true };
  const selected = [{ type: "card" as const, cardId: "browser:card-1" }];

  assert.equal(
    resolveFocusedBrowserCard({ selectedItems: selected, anyTerminalFocused: false, ...managed }),
    "card-1",
  );

  // Activating a card clears terminal focus, but focusing a terminal does not
  // clear the selection — so without this the node would keep stealing keys
  // from the terminal the user is typing in.
  assert.equal(
    resolveFocusedBrowserCard({ selectedItems: selected, anyTerminalFocused: true, ...managed }),
    null,
  );

  // A box-select over several tiles is not one node holding the keyboard.
  assert.equal(
    resolveFocusedBrowserCard({
      selectedItems: [...selected, { type: "card", cardId: "browser:card-2" }],
      anyTerminalFocused: false,
      ...managed,
    }),
    null,
  );

  assert.equal(
    resolveFocusedBrowserCard({
      selectedItems: [{ type: "annotation", annotationId: "a1" }],
      anyTerminalFocused: false,
      ...managed,
    }),
    null,
  );

  // A connected system-browser tab renders a status panel, not a webview:
  // nothing to find in and nothing to zoom.
  assert.equal(
    resolveFocusedBrowserCard({
      selectedItems: selected,
      anyTerminalFocused: false,
      isManagedCard: () => false,
    }),
    null,
  );
});
