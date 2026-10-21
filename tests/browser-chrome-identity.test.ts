import test from "node:test";
import assert from "node:assert/strict";
import {
  chromeIdentity,
  clientHintValues,
  isSecureForHints,
  parseAcceptCh,
  SIGN_IN_ORIGINS_HINTS,
  withChromeHeaders,
} from "../electron/browser-chrome-identity";

const mac = chromeIdentity({ chromeVersion: "146.0.7680.188", platform: "darwin", platformVersion: "26.3.0", arch: "arm64", locale: "en-US" });

test("a browser node presents as the Chrome it's built from, as Chrome 146 on a Mac does (SHR-130)", () => {
  assert.equal(mac.userAgent, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36");
  assert.ok(!mac.userAgent.includes("Electron"));
  // The GREASE brand Electron itself reports for 146, measured: Not-A.Brand, version 24.
  assert.deepEqual(mac.metadata.brands, [
    { brand: "Chromium", version: "146" },
    { brand: "Not-A.Brand", version: "24" },
    { brand: "Google Chrome", version: "146" },
  ]);
  assert.deepEqual(mac.metadata.fullVersionList.map((b) => b.version), ["146.0.7680.188", "24.0.0.0", "146.0.7680.188"]);
  assert.equal(mac.metadata.platform, "macOS");
  assert.equal(mac.metadata.architecture, "arm");
  assert.equal(mac.metadata.bitness, "64");
  assert.equal(mac.navigatorPlatform, "MacIntel");
  assert.equal(mac.acceptLanguage, "en-US,en");
});

test("the headers say what the page says: one brand list, one platform", () => {
  const hints = clientHintValues(mac);
  assert.equal(hints["sec-ch-ua"], `"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"`);
  assert.equal(hints["sec-ch-ua-mobile"], "?0");
  assert.equal(hints["sec-ch-ua-platform"], `"macOS"`);
  assert.equal(hints["sec-ch-ua-platform-version"], `"26.3.0"`);
  assert.equal(hints["sec-ch-ua-full-version-list"], `"Chromium";v="146.0.7680.188", "Not-A.Brand";v="24.0.0.0", "Google Chrome";v="146.0.7680.188"`);
});

test("requests carry the low-entropy hints always, the rest only where asked, and Electron's user agent never", () => {
  const sent = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.188 Electron/41.2.1 Safari/537.36",
    Accept: "text/html",
    "sec-ch-ua": `"Not-A.Brand";v="24", "Chromium";v="146"`,
  };
  const plain = withChromeHeaders(sent, "https://example.com/", mac, new Set());
  assert.equal(plain["User-Agent"], mac.userAgent);
  assert.equal(plain.Accept, "text/html");
  assert.equal(plain["sec-ch-ua"], clientHintValues(mac)["sec-ch-ua"]);
  assert.equal(plain["sec-ch-ua-platform"], `"macOS"`);
  assert.equal(plain["sec-ch-ua-arch"], undefined);
  assert.equal(Object.keys(plain).filter((k) => k.toLowerCase() === "sec-ch-ua").length, 1);

  const asked = withChromeHeaders(sent, "https://accounts.google.com/", mac, new Set(SIGN_IN_ORIGINS_HINTS["https://accounts.google.com"]));
  assert.equal(asked["sec-ch-ua-arch"], `"arm"`);
  assert.equal(asked["sec-ch-ua-full-version"], `"146.0.7680.188"`);

  // Not over plain http, as Chrome doesn't.
  const insecure = withChromeHeaders(sent, "http://example.com/", mac, new Set(["sec-ch-ua-arch"]));
  assert.equal(insecure["sec-ch-ua"], undefined);
  assert.equal(insecure["User-Agent"], mac.userAgent);
  assert.ok(isSecureForHints("http://localhost:5173/"));
});

test("Accept-CH is read as Google sends it, and only client hints are taken", () => {
  assert.deepEqual(parseAcceptCh(["Sec-CH-UA-Arch, Sec-CH-UA-Bitness", " sec-ch-ua-model"]), ["sec-ch-ua-arch", "sec-ch-ua-bitness", "sec-ch-ua-model"]);
  assert.deepEqual(parseAcceptCh("Viewport-Width, DPR"), []);
  assert.deepEqual(parseAcceptCh(undefined), []);
});

test("on Windows and Linux the identity matches those Chromes", () => {
  const win = chromeIdentity({ chromeVersion: "146.0.7680.188", platform: "win32", platformVersion: "15.0.0", arch: "x64", locale: "en-GB" });
  assert.ok(win.userAgent.includes("(Windows NT 10.0; Win64; x64)"));
  assert.equal(win.metadata.platform, "Windows");
  assert.equal(win.metadata.architecture, "x86");
  assert.equal(win.acceptLanguage, "en-GB,en");
  const linux = chromeIdentity({ chromeVersion: "146.0.7680.188", platform: "linux", platformVersion: "6.8.0", arch: "x64", locale: "de" });
  assert.ok(linux.userAgent.includes("(X11; Linux x86_64)"));
  assert.equal(linux.acceptLanguage, "de");
});
