#!/usr/bin/env node
// Agents driving browser tiles, end to end, in a throwaway Tacit: real input
// into real pages, checked against what the pages say happened.
//
//   pnpm test:browser-e2e            (macOS; opens a Tacit window for a few minutes)
//   pnpm test:browser-e2e --keep     leaves the temp folder for a look afterwards
//
// It starts its own Tacit (own home, data, ports) from this checkout, so a dev
// app or the installed one is never touched. An agent here is the built tool
// server (tacit-bridge) run as one of the throwaway's terminals, with that
// terminal's own credential, exactly as Claude or Codex run it.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  wait, until, freePort, serveSite, agent, actResult, refOf, evaluate, cdp, inMain, coverWindow,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const BRIDGE = join(ROOT, "tacit-bridge/dist/tacit-bridge.js");
const keep = process.argv.includes("--keep");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${!ok && detail ? `\n      ${String(detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
}
const section = (s) => console.log(`\n${s}`);
const codeOf = (r) => (/\[([a-z_]+)\]\s*(\(Quoted|$)/m.exec(r.text) ?? [])[1] ?? null;
const stepReason = (r) => actResult(r)?.steps?.find((s) => !s.ok)?.reason ?? null;

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "tacit-browser-e2e-")));
const home = join(tmp, "home");
const workdesk = join(tmp, "workdesk");
let app = null;
let site = null;
const agents = [];

async function main() {
  if (process.platform !== "darwin") throw new Error("This run needs macOS (it opens Tacit's window).");

  // The tool server agents run, as built from this checkout.
  execFileSync("npm", ["run", "build"], { cwd: join(ROOT, "tacit-bridge"), stdio: "ignore" });

  // A workdesk: a git folder with a file a page may be given.
  mkdirSync(home, { recursive: true });
  // Without one, zsh greets a new home with its setup questions instead of a prompt.
  writeFileSync(join(home, ".zshrc"), "");
  mkdirSync(workdesk, { recursive: true });
  writeFileSync(join(workdesk, "report.txt"), "quarterly report\n");
  const git = (...a) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...a], { cwd: workdesk, stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "init");

  site = await serveSite(join(here, "site"));
  const forms = `${site.pageOrigin}/forms.html`;

  // A throwaway Tacit.
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const logFile = join(tmp, "app.log");
  writeFileSync(logFile, "");
  app = spawn("npx", ["vite", "--port", String(vitePort), "--strictPort"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, TACIT_DEV_USER_DATA: join(tmp, "userdata"), TACIT_SKIP_LOCK: "1", TACIT_DEV_UI_CDP_PORT: String(cdpPort), NODE_OPTIONS: "--inspect=0" },
  });
  let log = "";
  for (const s of [app.stdout, app.stderr]) s.on("data", (d) => { log += d; writeFileSync(logFile, log); });
  const ui = (expr) => evaluate(cdpPort, `:${vitePort}`, expr);
  const portFile = join(home, ".tacit-dev", "port");
  await until("Tacit's window", async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).some((t) => t.url.includes(`:${vitePort}`)), 180_000, 1000);
  await until("Tacit's API", () => existsSync(portFile) && readFileSync(portFile, "utf8").trim().split("\n").length >= 3, 60_000);
  await until("the app to be ready", () => ui("!!window.__tcApi && typeof window.__tcApi.getProjects === 'function'"), 60_000);
  const [apiPort, , auth] = readFileSync(portFile, "utf8").trim().split("\n");
  const api = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${apiPort}${path}`, { method, headers: { "content-type": "application/json", Authorization: `Bearer ${auth}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  const inspectors = () => [...log.matchAll(/Debugger listening on (ws:\/\/\S+)/g)].map((m) => m[1]).reverse();
  const cover = (on) => inMain(inspectors(), coverWindow(ROOT, on));
  // Files pages download go to this run's own folder, never the person's Downloads.
  const downloads = join(home, "Downloads");
  mkdirSync(downloads, { recursive: true });
  await inMain(inspectors(), `(() => { const { app } = process.getBuiltinModule("module").createRequire(${JSON.stringify(ROOT + "/")})("electron"); app.setPath("downloads", ${JSON.stringify(downloads)}); return true; })()`);

  // The workdesk, two terminals and a browser tile wired to both.
  const project = await api("POST", "/project/add", { path: workdesk });
  const worktree = (project.worktrees ?? project.project?.worktrees)?.[0]?.path ?? workdesk;
  const terminal = async () => {
    const t = await api("POST", "/terminal/create", { worktree, type: "shell" });
    return t.id ?? t.terminalId ?? t.terminal?.id;
  };
  const idA = await terminal();
  const idB = await terminal();
  const tile = (await api("POST", "/browser/create", { url: forms })).id;
  for (const id of [idA, idB]) await ui(`window.__tcApi.connectNodes({kind:"terminal",id:${JSON.stringify(id)}},{kind:"browser",id:${JSON.stringify(tile)}})`);
  // A terminal's credential is in its shell's environment: the shell writes it to a
  // file of this run's, as an agent started there would read it.
  const tokenOf = async (id) => {
    const file = join(tmp, `token-${id}`);
    const pty = await until(`terminal ${id}'s shell`, () => ui(`window.__tcApi.getTerminal(${JSON.stringify(id)})?.ptyId ?? null`), 30_000);
    await wait(1500);
    await ui(`window.tacit.terminal.input(${pty}, ${JSON.stringify(`printf %s "$TACIT_TERMINAL_TOKEN" > '${file}'\r`)}), true`);
    return until(`terminal ${id}'s credential`, () => existsSync(file) && readFileSync(file, "utf8").trim(), 20_000);
  };
  const tokenA = await tokenOf(idA);
  const tokenB = await tokenOf(idB);
  const A = await agent(BRIDGE, { TACIT_TERMINAL_ID: idA, TACIT_TERMINAL_TOKEN: tokenA, TACIT_PORT_FILE: portFile });
  const B = await agent(BRIDGE, { TACIT_TERMINAL_ID: idB, TACIT_TERMINAL_TOKEN: tokenB, TACIT_PORT_FILE: portFile });
  agents.push(A, B);
  const page = (expr) => evaluate(cdpPort, "/forms.html", expr);
  const grid = (expr) => evaluate(cdpPort, "/grid.html", expr);
  const fresh = async () => {
    await A.call("browser_navigate", { browser: tile, url: forms });
    await until("the page", async () => (await page("document.readyState")) === "complete", 15_000);
    await until("the grid", async () => (await grid("typeof window.__clear")) === "function", 15_000);
    await grid("window.__clear(), true");
    return (await A.call("browser_snapshot", { browser: tile })).text;
  };

  // 1. A page, with Tacit's window covered by another.
  section("A page, with Tacit's window covered");
  await cover(true);
  let snap = await fresh();
  const r = (re) => refOf(snap, re);
  let res = await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: r(/Under the banner/) }] });
  check("a button under a cookie banner isn't clicked", stepReason(res) === "covered", res.text);
  await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: r(/Accept cookies/) }, { do: "click", ref: r(/Under the banner/) }] });
  check("after the banner is accepted it is", (await page("document.getElementById('cov').textContent")) === "covered button worked");
  res = await A.call("browser_act", { browser: tile, steps: [
    { do: "fill", ref: r(/textbox "Full name"/), text: "Ada Lovelace" },
    { do: "fill", ref: r(/textbox "Email"/), text: "ada@example.com" },
    { do: "select", ref: r(/combobox "Country"/), values: ["India"] },
    { do: "check", ref: r(/checkbox "I agree"/), checked: true },
    { do: "click", ref: r(/button "Create account"/) },
  ] });
  check("a form is filled, chosen, ticked and sent", (await page("document.getElementById('result').textContent")) === "Thanks, Ada Lovelace from in (agreed)", res.text);
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "fill", ref: r(/textbox "Password"/), text: "hunter2" }] });
  check("a password field is refused", stepReason(res) === "password" && (await page("document.querySelector('[name=secret]').value")) === "", res.text);
  await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: r(/button "Danger"/) }] });
  res = await A.call("browser_snapshot", { browser: tile });
  check("an open dialog is said, not waited on", res.isError && /dialog/i.test(res.text), res.text);
  await A.call("browser_dialog", { browser: tile, accept: false });
  check("the dialog is answered", (await page("document.getElementById('dlg').textContent")) === "cancelled");
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "upload", ref: r(/button "Attachment"/), paths: ["/etc/hosts"] }] });
  check("a file outside the workdesk isn't given to the page", stepReason(res) === "file_not_allowed", res.text);
  await A.call("browser_act", { browser: tile, steps: [{ do: "upload", ref: r(/button "Attachment"/), paths: [join(worktree, "report.txt")] }] });
  check("a workdesk file is", (await page("document.getElementById('fname').textContent")) === "report.txt");
  await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: r(/Load report/) }, { do: "wait", text: "Loaded the report" }] });
  check("waiting for content that comes later", !!(await page("document.getElementById('late')?.textContent")));
  await A.call("browser_act", { browser: tile, steps: [{ do: "fill", ref: r(/textbox "Notes"/), text: "New note" }] });
  check("editable text that isn't a field", (await page("document.querySelector('[contenteditable]').textContent")) === "New note");
  await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: r(/Inside the shadow/) }] });
  check("a button inside a shadow root", (await page("document.querySelector('tc-card').shadowRoot.getElementById('so').textContent")).includes("worked"));
  await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: r(/Far down the page/) }] });
  check("a button far down the page", (await page("[...document.querySelectorAll('button')].some(b => b.textContent === 'bottom button worked')")) === true);
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: r(/canvas/) }, { do: "type", text: "Hi there" }, { do: "press", keys: ["Tab"] }, { do: "type", text: "42" }] });
  const cells = await grid("window.__grid().cells");
  check("typing into a canvas grid in a frame from another site", Object.values(cells).join("|") === "Hi there|42", JSON.stringify(cells) + " " + res.text);
  res = await A.call("browser_screenshot", { browser: tile });
  check("a screenshot", !res.isError && res.images.length === 1, res.text);

  // 1b. Reading as a person reads, dragging, and a download.
  section("Reading, dragging and downloading");
  snap = await fresh();
  check("a sentence keeps its link and bold words", /- text "Read the terms before you sign up\." \[e\d+\]/.test(snap), snap.split("\n").filter((l) => /terms/.test(l)).join(" | "));
  check("a cookie banner's text doesn't repeat its button", /- text "We use cookies\." \[/.test(snap) && !/text "[^"]*Accept cookies/.test(snap));
  check("things to drag are listed", /- draggable "Card one" \[/.test(snap) && /- draggable "Card two" \[/.test(snap));
  await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: refOf(snap, /Accept cookies/) }] });
  snap = (await A.call("browser_snapshot", { browser: tile })).text;
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "drag", from: { ref: refOf(snap, /draggable "Card one"/) }, to: { ref: refOf(snap, /draggable "Card two"/) } }] });
  check("one card dragged past the other", (await page("[...document.querySelectorAll('.card')].map(c => c.textContent).join(',')")) === "Card two,Card one", res.text);
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: refOf(snap, /link "Export CSV"/) }, { do: "wait", download: true }] });
  const saved = join(downloads, "export.csv");
  check("a download is waited for and said, with where it went", actResult(res)?.steps?.[1]?.note === `downloaded export.csv (27 bytes) to ${saved}`, res.text);
  check("and it's there", existsSync(saved) && readFileSync(saved, "utf8") === "name,amount\nAda,42\nGrace,7\n");
  check("the result lists it", actResult(res)?.downloads?.[0]?.file === "export.csv", res.text);
  check("a radio with no label is named by the words beside it", /- radio "Other:" \[/.test(snap), snap.split("\n").filter((l) => /radio/.test(l)).join(" | "));
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "check", ref: refOf(snap, /radio "Other:"/), checked: true }] });
  check("a radio the page ticks a moment late is checked, and said so", actResult(res)?.ok === true && (await page("document.querySelectorAll('#plan [role=radio]')[1].getAttribute('aria-checked')")) === "true", res.text);

  // 2. Screenshots: their size, aiming a click with one, and many at once.
  section("Screenshots");
  snap = await fresh();
  const vw = await page("innerWidth");
  for (const maxWidth of [undefined, Math.round(vw / 2)]) {
    res = await A.call("browser_screenshot", { browser: tile, ...(maxWidth ? { maxWidth } : {}) });
    const m = /Screenshot (s\d+), (\d+)×(\d+)/.exec(res.text);
    const want = maxWidth ?? vw;
    check(`a screenshot is the page's width${maxWidth ? ", scaled" : ""} (${want}px)`, m && Math.abs(Number(m[2]) - want) <= 1, res.text.slice(0, 120));
    const at = await page("(() => { const e = document.querySelector('[name=name]'); e.blur(); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()");
    const k = Number(m?.[2]) / vw;
    await A.call("browser_act", { browser: tile, steps: [{ do: "click", x: Math.round(at.x * k), y: Math.round(at.y * k), screenshot: m?.[1] }] });
    check("a click aimed with it lands on the field", (await page("document.activeElement?.name")) === "name");
  }
  let failed = 0;
  for (let i = 0; i < 4; i++) {
    const [act, shot] = await Promise.all([
      A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: refOf(snap, /textbox "Full name"/) }, { do: "scroll", dy: i % 2 ? 200 : -200 }, { do: "wait", ms: 800 }] }),
      wait(150).then(() => A.call("browser_screenshot", { browser: tile })),
    ]);
    failed += Number(act.isError) + Number(shot.isError);
  }
  const three = await Promise.all([0, 1, 2].map(() => A.call("browser_screenshot", { browser: tile })));
  failed += three.filter((s) => s.isError).length;
  check("screenshots during actions and three at once all come back", failed === 0, `${failed} failed`);
  await cover(false);

  // 3. Keys only go to a page that has the keyboard.
  for (const covered of [false, true]) {
    section(`Keys while the keyboard is in a terminal${covered ? ", window covered" : ""}`);
    if (covered) await cover(true);
    snap = await fresh();
    await ui("(() => { window.__e2eKeys = []; if (!window.__e2eKeysOn) { window.__e2eKeysOn = 1; addEventListener('keydown', e => window.__e2eKeys.push(e.key), true); } return true; })()");
    const inTerminal = await ui("(() => { const t = document.querySelector('.xterm-helper-textarea'); t?.focus(); return document.activeElement === t; })()");
    check("the keyboard is in a terminal", inTerminal);
    res = await A.call("browser_act", { browser: tile, steps: [{ do: "press", keys: ["Escape"] }] });
    check("Escape is refused", stepReason(res) === "no_keyboard", res.text);
    res = await A.call("browser_act", { browser: tile, steps: [{ do: "type", text: "zz" }] });
    check("typing is refused", stepReason(res) === "no_keyboard", res.text);
    check("no key reached Tacit's window", (await ui("window.__e2eKeys.splice(0).length")) === 0);
    check("the keyboard is still in the terminal", await ui("document.activeElement?.classList.contains('xterm-helper-textarea') === true"));
    res = await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: refOf(snap, /textbox "Email"/) }, { do: "type", text: "a@b.c" }, { do: "press", keys: ["Escape"] }] });
    check("after a click in the page, typing and Escape go to it", actResult(res)?.ok === true && (await page("document.querySelector('[name=email]').value")) === "a@b.c", res.text);
    check("and none reached Tacit's window", (await ui("window.__e2eKeys.splice(0).length")) === 0);
    if (covered) await cover(false);
  }

  // 4. Two agents on one page; the person; Stop and Resume; a pop-up.
  section("Two agents, the person, Stop and Resume, a pop-up");
  snap = await fresh();
  await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: refOf(snap, /Accept cookies/) }, { do: "fill", ref: refOf(snap, /textbox "Full name"/), text: "from A" }] });
  const snapB = (await B.call("browser_snapshot", { browser: tile })).text;
  res = await B.call("browser_act", { browser: tile, steps: [{ do: "fill", ref: refOf(snapB, /textbox "Full name"/), text: "from B" }] });
  check("a second agent can't change the page while the first holds it", codeOf(res) === "busy", res.text);
  check("but it can read it", /from A/.test(snapB));
  check("the page has the first agent's text", (await page("document.querySelector('[name=name]').value")) === "from A");
  // Right after the agent's own clicks: the person's isn't taken for one of them.
  await wait(300);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp(cdpPort, "/forms.html", "Input.dispatchMouseEvent", { type, x: 5, y: 5, button: "left", clickCount: 1 });
  await wait(300);
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "press", keys: ["Tab"] }] });
  check("after the person clicks in the page, agents wait", codeOf(res) === "user_driving", res.text);
  await ui(`window.tacit.browser.stopDriver(${JSON.stringify(tile)})`);
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "fill", ref: refOf(snap, /textbox "Full name"/), text: "after stop" }] });
  check("after Stop, agents are kept off", res.isError && (await page("document.querySelector('[name=name]').value")) === "from A", res.text);
  await ui(`window.tacit.browser.resumeDriver(${JSON.stringify(tile)})`);
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "fill", ref: refOf(snap, /textbox "Full name"/), text: "after resume" }] });
  check("after Resume, they're back", actResult(res)?.ok === true && (await page("document.querySelector('[name=name]').value")) === "after resume", res.text);
  snap = (await A.call("browser_snapshot", { browser: tile })).text;
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: refOf(snap, /Open the helper window/) }] });
  check("the click says it opened a tile", /popup\.html/.test(actResult(res)?.opened?.[0]?.url ?? "") && /new browser tile/.test(actResult(res)?.opened?.[0]?.as ?? ""), res.text);
  const helper = await until("the pop-up's tile", async () => { const s = await A.call("browser_snapshot", { browser: "Helper" }); return s.isError ? null : s.text; }, 15_000).catch(() => null);
  check("a pop-up opens as a tile the agent can find by name", !!helper);
  if (helper) {
    await A.call("browser_act", { browser: "Helper", steps: [{ do: "click", ref: refOf(helper, /Do the helper thing/) }] });
    check("and act in", (await evaluate(cdpPort, "/popup.html", "document.querySelector('button').textContent")) === "helper clicked");
  }

  // 5. A tile far off the canvas.
  section("A tile off screen");
  snap = await fresh();
  await api("PUT", `/browser/${tile}`, { x: 40000, y: 40000 });
  await wait(800);
  res = await A.call("browser_act", { browser: tile, steps: [{ do: "click", ref: refOf(snap, /Accept cookies/) }, { do: "fill", ref: refOf(snap, /textbox "Full name"/), text: "off screen" }] });
  check("an agent fills a field in it", (await page("document.querySelector('[name=name]').value")) === "off screen", res.text);
  res = await A.call("browser_screenshot", { browser: tile });
  check("and takes a screenshot of it", !res.isError && res.images.length === 1, res.text);
  await api("PUT", `/browser/${tile}`, { x: 260, y: 140 });

  check("the window never reloaded", !/renderer reloaded/.test(log));
}

let crashed = null;
try {
  await main();
} catch (e) {
  crashed = e;
}
for (const a of agents) a.close();
site?.close();
if (app?.pid) {
  try { process.kill(-app.pid, "SIGTERM"); } catch { /* gone */ }
  await wait(3000);
  try { process.kill(-app.pid, "SIGKILL"); } catch { /* gone */ }
}
if (!keep) rmSync(tmp, { recursive: true, force: true });
else console.log(`\nKept: ${tmp}`);

const bad = results.filter((r) => !r.ok);
if (crashed) console.log(`\nThe run stopped: ${crashed.stack ?? crashed}`);
console.log(`\n${results.length - bad.length} of ${results.length} checks passed.`);
process.exit(crashed || bad.length ? 1 : 0);
