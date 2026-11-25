import test from "node:test";
import assert from "node:assert/strict";
import { addressFor, shownAddress, tabAddressFrom } from "../src/browser/address";

test("what's typed is an address, or a search for it", () => {
  assert.equal(addressFor("  "), null);
  assert.equal(addressFor("https://a.com/x"), "https://a.com/x");
  assert.equal(addressFor("youtube.com/watch?v=1"), "https://youtube.com/watch?v=1");
  assert.equal(addressFor("münchen.de"), "https://münchen.de");
  assert.equal(addressFor("10.0.0.4:8080/x"), "https://10.0.0.4:8080/x");
  assert.equal(addressFor("localhost:3000"), "http://localhost:3000");
  assert.equal(addressFor("app.localhost/a"), "http://app.localhost/a");
  assert.equal(addressFor("127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(addressFor("how tall is everest"), "https://www.google.com/search?q=how%20tall%20is%20everest");
  assert.equal(addressFor("react"), "https://www.google.com/search?q=react");
  assert.equal(addressFor("node.js streams"), "https://www.google.com/search?q=node.js%20streams");
  // Never run, whatever it says.
  for (const s of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) assert.match(addressFor(s)!, /^https:\/\/www\.google\.com\/search/);
});

test("an address reads as the site, then the rest", () => {
  assert.deepEqual(shownAddress("https://www.youtube.com/"), { site: "youtube.com", rest: "" });
  assert.deepEqual(shownAddress("https://youtube.com/watch?v=1#t"), { site: "youtube.com", rest: "/watch?v=1#t" });
  assert.deepEqual(shownAddress("http://localhost:3000/a"), { site: "localhost:3000", rest: "/a" });
  assert.deepEqual(shownAddress("about:blank"), { site: "about:blank", rest: "" });
  assert.deepEqual(shownAddress("nonsense"), { site: "nonsense", rest: "" });
});

test("a frame inside the page moving doesn't move the tab", () => {
  const sheet = "https://swishintranet.sharepoint.com/:x:/s/team/IQB?e=0";
  assert.equal(tabAddressFrom({ url: sheet, isMainFrame: true }), sheet);
  assert.equal(tabAddressFrom({ url: "https://webshell.suite.office.com/iframe/TokenFactoryIframe", isMainFrame: false }), null);
  // did-navigate has no isMainFrame: it's only ever the page.
  assert.equal(tabAddressFrom({ url: sheet }), sheet);
});
