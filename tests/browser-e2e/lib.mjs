// Helpers for the browser end-to-end run (run.mjs): the test site, a throwaway
// Tacit, an agent's view through the real tool server, and the app's window.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { createServer as netServer } from "node:net";

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, fn, ms = 60_000, every = 500) {
  const end = Date.now() + ms;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = undefined; }
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await wait(every);
  }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/**
 * The test pages. One server, two sites: pages load from localhost and the grid
 * from 127.0.0.1, so the grid is a frame from another site (as Excel's is).
 */
export async function serveSite(dir) {
  const port = await freePort();
  const pageOrigin = `http://localhost:${port}`;
  const gridOrigin = `http://127.0.0.1:${port}`;
  const types = { ".html": "text/html; charset=utf-8", ".txt": "text/plain", ".csv": "text/csv" };
  const server = createServer((req, res) => {
    const name = new URL(req.url, pageOrigin).pathname.replace(/^\/+/, "");
    if (!/^[a-z0-9-]+\.(html|txt|csv)$/.test(name)) { res.writeHead(404).end(); return; }
    let body;
    try { body = readFileSync(join(dir, name), "utf8"); } catch { res.writeHead(404).end(); return; }
    body = body.replaceAll("{{PAGE_ORIGIN}}", pageOrigin).replaceAll("{{GRID_ORIGIN}}", gridOrigin);
    // A .csv comes as a file to save, as an app's "Export" does.
    const save = extname(name) === ".csv" ? { "content-disposition": `attachment; filename="${name}"` } : {};
    res.writeHead(200, { "content-type": types[extname(name)], "cache-control": "no-store", ...save }).end(body);
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { pageOrigin, gridOrigin, close: () => server.close() };
}

/** An agent: the built tool server over stdio, as one terminal. */
export async function agent(bridgePath, env) {
  const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const waiting = new Map();
  let id = 0;
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((r) => { const n = ++id; waiting.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "browser-e2e", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    async call(name, args = {}) {
      const res = await rpc("tools/call", { name, arguments: args });
      const content = res.result?.content ?? [];
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || (res.error ? JSON.stringify(res.error) : "");
      return { text, images: content.filter((c) => c.type === "image"), isError: !!res.result?.isError || !!res.error };
    },
    close: () => child.kill(),
  };
}

/** A browser_act result's JSON (after the "from the page" line). */
export function actResult(r) {
  if (r.isError) return null;
  const at = r.text.indexOf("{");
  try { return JSON.parse(r.text.slice(at)); } catch { return null; }
}

/** The handle of the first outline line matching. */
export const refOf = (snap, re) => {
  const line = snap.split("\n").find((l) => re.test(l));
  const m = line && /\[((?:f\d+)?e\d+)\]/.exec(line);
  return m ? m[1] : null;
};

/** Evaluates in the first target on the app's debugging port whose address contains `match`. */
export async function cdp(cdpPort, match, method, params) {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const t = list.find((x) => x.url.includes(match));
  if (!t) throw new Error(`No page at ${match}`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  return new Promise((r) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) { ws.close(); r(d.result); } };
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
}

export async function evaluate(cdpPort, match, expression) {
  const r = await cdp(cdpPort, match, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r?.result?.value;
}

/** Runs code in the app's main process, through its inspector (NODE_OPTIONS=--inspect=0). */
export async function inMain(inspectorUrls, expression) {
  for (const url of inspectorUrls) {
    try {
      const ws = new WebSocket(url);
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(j, 1500); });
      const call = (id, expr) => new Promise((r) => {
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === id) r(d.result?.result?.value); };
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      });
      if (!(await call(1, "!!process.versions.electron && process.type === 'browser'"))) { ws.close(); continue; }
      const value = await call(2, expression);
      ws.close();
      return value;
    } catch { /* the next one */ }
  }
  throw new Error("No inspector for the app's main process");
}

/** A plain window over Tacit's, so Tacit's is covered; and taking it away. */
export function coverWindow(repoRoot, on) {
  const electron = `process.getBuiltinModule("module").createRequire(${JSON.stringify(repoRoot + "/")})("electron")`;
  return on
    ? `(async () => { const { BrowserWindow } = ${electron}; const main = BrowserWindow.getAllWindows().find(w => w.getTitle() !== "e2e-cover"); const b = main.getBounds(); const w = new BrowserWindow({ x: b.x - 20, y: b.y - 20, width: b.width + 40, height: b.height + 40, title: "e2e-cover", backgroundColor: "#335", show: false, focusable: false }); w.showInactive(); w.moveTop(); return true; })()`
    : `(async () => { const { BrowserWindow } = ${electron}; for (const w of BrowserWindow.getAllWindows()) if (w.getTitle() === "e2e-cover") w.destroy(); return true; })()`;
}
