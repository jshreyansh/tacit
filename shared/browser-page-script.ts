/**
 * The helper Tacit installs in each frame of a page an agent drives, in a
 * script world of its own (CDP Page.createIsolatedWorld), so the page's own
 * scripts never see it and it never sees theirs. It reads the page as a
 * person would use it: what can be clicked, typed into or read, named the way
 * assistive technology names it, across open shadow roots, with a stable handle
 * (`ref`) for each thing so the agent can point at it.
 *
 * Kept as source text, not a function: it runs in the page, and a bundler's
 * helpers or renamed globals must not leak into it.
 */
export const PAGE_SCRIPT = String.raw`
(() => {
  if (globalThis.__tacit) return true;
  const refs = new Map();
  const ids = new WeakMap();
  let next = 1;
  let gen = 0;
  const refOf = (el) => { let r = ids.get(el); if (!r) { r = "e" + next++; ids.set(el, r); refs.set(r, new WeakRef(el)); } return r; };
  const el = (ref) => { const w = refs.get(ref); const e = w && w.deref(); return e && e.isConnected ? e : null; };

  const INTERACTIVE = new Set(["link","button","textbox","searchbox","checkbox","radio","combobox","listbox","option","slider","spinbutton","switch","tab","menuitem","menuitemcheckbox","menuitemradio","treeitem","gridcell","columnheader","rowheader"]);
  const STRUCTURE = new Set(["heading","img","dialog","alertdialog","alert","navigation","main","form","search","banner","contentinfo","complementary","region","table","row","grid","tablist","menu","menubar","toolbar","tree","list","status","iframe","canvas","progressbar","separator"]);

  function implicitRole(e) {
    const t = e.tagName;
    if (t === "A") return e.hasAttribute("href") ? "link" : null;
    if (t === "BUTTON") return "button";
    if (t === "SELECT") return e.multiple || e.size > 1 ? "listbox" : "combobox";
    if (t === "TEXTAREA") return "textbox";
    if (t === "INPUT") {
      const ty = (e.getAttribute("type") || "text").toLowerCase();
      if (ty === "hidden") return null;
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      if (ty === "range") return "slider";
      if (ty === "number") return "spinbutton";
      if (ty === "search") return "searchbox";
      if (ty === "button" || ty === "submit" || ty === "reset" || ty === "image") return "button";
      if (ty === "file") return "button";
      return "textbox";
    }
    if (/^H[1-6]$/.test(t)) return "heading";
    if (t === "IMG") return e.getAttribute("alt") ? "img" : null;
    if (t === "NAV") return "navigation";
    if (t === "MAIN") return "main";
    if (t === "FORM") return "form";
    if (t === "DIALOG") return "dialog";
    if (t === "TABLE") return "table";
    if (t === "IFRAME" || t === "FRAME") return "iframe";
    if (t === "CANVAS") return "canvas";
    if (t === "SUMMARY") return "button";
    if (t === "PROGRESS") return "progressbar";
    if (t === "HR") return null;
    if (e.isContentEditable && (!e.parentElement || !e.parentElement.isContentEditable)) return "textbox";
    return null;
  }
  function role(e) {
    const r = (e.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (r && r !== "none" && r !== "presentation" && r !== "generic") return r;
    return implicitRole(e);
  }
  const clean = (s, n) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  function textOf(e) { return clean(e.innerText !== undefined ? e.innerText : e.textContent, 200); }
  function labelText(e) {
    const by = e.getAttribute("aria-labelledby");
    if (by) {
      const root = e.getRootNode();
      const t = by.split(/\s+/).map((id) => { const x = root.getElementById ? root.getElementById(id) : document.getElementById(id); return x ? textOf(x) : ""; }).join(" ");
      if (t.trim()) return t;
    }
    const aria = e.getAttribute("aria-label");
    if (aria && aria.trim()) return aria;
    // A label's own words, not the control inside it (a <select>'s options, a field's value).
    if (e.labels && e.labels.length) return Array.from(e.labels).map((l) => { const c = l.cloneNode(true); c.querySelectorAll("input,select,textarea,button,option").forEach((x) => x.remove()); return clean(c.textContent, 200); }).join(" ");
    return "";
  }
  function name(e, r) {
    const l = labelText(e);
    if (l) return clean(l, 120);
    const t = e.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      const ty = (e.getAttribute("type") || "").toLowerCase();
      if ((ty === "submit" || ty === "button" || ty === "reset") && e.value) return clean(e.value, 120);
      return clean(e.getAttribute("placeholder") || e.getAttribute("title") || e.getAttribute("name") || "", 120);
    }
    if (t === "IMG") return clean(e.getAttribute("alt") || e.getAttribute("title") || "", 120);
    if (t === "IFRAME") return clean(e.getAttribute("title") || e.getAttribute("name") || "", 120);
    if (r === "checkbox" || r === "radio" || r === "switch") return clean(textOf(e) || e.getAttribute("title") || besideText(e), 120);
    if (r === "link" || r === "button" || r === "heading" || r === "tab" || r === "menuitem" || r === "option" || r === "gridcell" || r === "columnheader" || r === "rowheader" || r === "treeitem") return clean(textOf(e) || e.getAttribute("title") || "", 120);
    return clean(e.getAttribute("title") || "", 120);
  }
  // A tick box with no label of its own, its words beside it (Google Forms' "Other:"):
  // the nearest wrapper's text, while that wrapper holds no other choice it could be about.
  const CHOICE = "input[type=checkbox],input[type=radio],[role=checkbox],[role=radio],[role=switch]";
  function besideText(e) {
    let p = e.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      if (p.querySelectorAll(CHOICE).length > 1) return "";
      const c = p.cloneNode(true);
      c.querySelectorAll("input,select,textarea,button,option,script,style,[role=textbox],[contenteditable]").forEach((x) => x.remove());
      const t = clean(c.textContent, 200);
      if (t) return t.length <= 80 ? t : "";
    }
    return "";
  }
  function visible(e) {
    const s = getComputedStyle(e);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 || e.tagName === "INPUT" && s.opacity !== "0";
  }
  function isPassword(e) { return e.tagName === "INPUT" && (e.getAttribute("type") || "").toLowerCase() === "password" || /password|passwd|otp|one-time-code/i.test(e.getAttribute("autocomplete") || ""); }
  function states(e, r) {
    const out = [];
    if (e.disabled || e.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (r === "checkbox" || r === "radio" || r === "switch" || r === "menuitemcheckbox" || r === "menuitemradio") {
      const c = e.tagName === "INPUT" ? e.checked : e.getAttribute("aria-checked") === "true";
      out.push(c ? "checked" : "unchecked");
    }
    const ex = e.getAttribute("aria-expanded"); if (ex) out.push(ex === "true" ? "expanded" : "collapsed");
    if (e.getAttribute("aria-selected") === "true" || (e.tagName === "OPTION" && e.selected)) out.push("selected");
    if (e.required || e.getAttribute("aria-required") === "true") out.push("required");
    if (e.readOnly || e.getAttribute("aria-readonly") === "true") out.push("readonly");
    if (e.getAttribute("aria-invalid") === "true") out.push("invalid");
    const active = e.getRootNode().activeElement || document.activeElement;
    if (active === e) out.push("focused");
    if (isPassword(e)) out.push("password");
    return out;
  }
  function value(e, r) {
    if (isPassword(e)) return e.value ? "(hidden)" : "";
    if (e.tagName === "SELECT") return clean(Array.from(e.selectedOptions).map((o) => o.textContent).join(", "), 120);
    if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") { const ty = (e.getAttribute("type") || "").toLowerCase(); if (["checkbox","radio","button","submit","reset","image","file"].includes(ty)) return ty === "file" && e.files && e.files.length ? Array.from(e.files).map((f) => f.name).join(", ") : ""; return clean(e.value, 200); }
    if (r === "textbox" && e.isContentEditable) return clean(e.innerText, 200);
    if (r === "slider" || r === "spinbutton" || r === "progressbar") return clean(e.getAttribute("aria-valuenow") || e.value || "", 40);
    return "";
  }
  const SKIP_TAGS = new Set(["SCRIPT","STYLE","NOSCRIPT","TEMPLATE"]);
  const flows = (e) => { const d = getComputedStyle(e).display; return d.startsWith("inline") || d === "contents"; };
  // The words of a block as a person reads them: its own text and that of everything
  // inside it that runs on the same line (links, bold, code, kbd), up to the next
  // block. "plain" is the part that isn't a link's own words.
  function lineText(e) {
    let all = "", plain = "";
    for (const n of kids(e)) {
      if (n.nodeType === 3) { all += n.textContent; plain += n.textContent; continue; }
      if (n.nodeType !== 1 || SKIP_TAGS.has(n.tagName) || n.getAttribute("aria-hidden") === "true") continue;
      if (n.tagName === "BR") { all += " "; plain += " "; continue; }
      if (!flows(n)) continue;
      const s = getComputedStyle(n);
      if (s.display === "none" || s.visibility === "hidden") continue;
      // A field's label is its name already.
      if (n.tagName === "LABEL" && n.control) continue;
      const r = role(n);
      // A link is part of the sentence it's in; a button or a field has its own line.
      if (r === "link") { all += name(n, r) || n.textContent; continue; }
      if (r && INTERACTIVE.has(r)) continue;
      if (n.tagName === "IMG") { const a = n.getAttribute("alt") || ""; all += a; plain += a; continue; }
      const inner = lineText(n);
      all += inner.all; plain += inner.plain;
    }
    return { all, plain };
  }
  // Worth a line: has a letter or a digit (not a lone "|" or "·").
  const wordy = (t) => /[\p{L}\p{N}]/u.test(t);
  function kids(e) {
    if (e.shadowRoot) return Array.from(e.shadowRoot.childNodes);
    if (e.tagName === "SLOT") { const a = e.assignedNodes({ flatten: true }); return a.length ? a : Array.from(e.childNodes); }
    return Array.from(e.childNodes);
  }

  function snapshot(opts) {
    gen++;
    const max = (opts && opts.max) || 4000;
    const entries = [];
    const vw = innerWidth, vh = innerHeight;
    let truncated = false;
    const offscreen = (e) => { const rect = e.getBoundingClientRect(); return rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw; };
    // said: the words here were already given, as an ancestor's name or line of text.
    function walk(node, depth, insideInteractive, said) {
      if (entries.length >= max) { truncated = true; return; }
      if (node.nodeType !== 1) return;
      const e = node;
      if (e.getAttribute("aria-hidden") === "true" || SKIP_TAGS.has(e.tagName)) return;
      if (!visible(e) && e.tagName !== "SLOT" && !e.shadowRoot && getComputedStyle(e).display === "none") return;
      const r = role(e);
      const show = visible(e);
      let included = false;
      let saysText = false;
      if (show && r && (INTERACTIVE.has(r) || STRUCTURE.has(r))) {
        const entry = { ref: refOf(e), depth, role: r, name: name(e, r), value: value(e, r), states: states(e, r) };
        if (r === "heading") entry.level = e.getAttribute("aria-level") || (e.tagName.match(/^H([1-6])$/) || [])[1] || "";
        if (offscreen(e)) entry.offscreen = true;
        if (r === "iframe") entry.iframe = true;
        if (e.tagName === "INPUT" && (e.getAttribute("type") || "").toLowerCase() === "file") entry.file = true;
        entries.push(entry);
        included = true;
        saysText = r === "heading" && !!entry.name;
      } else if (show && !insideInteractive && !said && e.getAttribute("draggable") === "true") {
        // Something to drag that isn't a link or a picture (a card, a column, a list item).
        const entry = { ref: refOf(e), depth, role: "draggable", name: clean(e.getAttribute("aria-label") || textOf(e), 80), value: "", states: [] };
        if (offscreen(e)) entry.offscreen = true;
        entries.push(entry);
        included = true;
        saysText = true;
      } else if (show && !insideInteractive && !said && !flows(e) && !(e.tagName === "LABEL" && e.control)) {
        // A block of text: one line, links and all. Not when it's only a link's or a button's words.
        const { all, plain } = lineText(e);
        const t = clean(all, 200);
        if (t && wordy(plain)) {
          const entry = { ref: refOf(e), depth, role: "text", name: t, value: "", states: [] };
          if (getComputedStyle(e).cursor === "pointer") entry.states.push("clickable");
          entries.push(entry);
          saysText = true;
        }
      }
      const interactive = insideInteractive || (included && INTERACTIVE.has(r) && r !== "gridcell");
      if (r === "iframe" || (included && (r === "button" || r === "link" || r === "textbox" || r === "combobox" || r === "searchbox" || r === "option"))) return;
      // Below a line of text, only what's on its own line again (another block) speaks for itself.
      for (const k of kids(e)) walk(k, included ? depth + 1 : depth, interactive, said || (saysText && included));
    }
    walk(document.documentElement, 0, false, false);
    return { gen, url: location.href, title: document.title, entries, truncated, focused: document.activeElement && document.activeElement !== document.body ? refOf(document.activeElement) : null };
  }

  // Ready to act on: in the document, shown, enabled, scrolled into view, and
  // still for two frames. Returns its middle in this frame's viewport.
  async function actionable(ref, opts) {
    const e = el(ref);
    if (!e) return { ok: false, reason: "stale", message: "That ref is gone: the page changed since the snapshot. Take a new snapshot." };
    if (opts && opts.scroll !== false) e.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    let prev = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const r = e.getBoundingClientRect();
      const key = [r.x, r.y, r.width, r.height].map((n) => Math.round(n)).join(",");
      if (key === prev) break;
      prev = key;
    }
    if (!visible(e)) return { ok: false, reason: "hidden", message: describe(e) + " isn't shown." };
    if (opts && opts.enabled && (e.disabled || e.getAttribute("aria-disabled") === "true")) return { ok: false, reason: "disabled", message: describe(e) + " is disabled." };
    const r = e.getBoundingClientRect();
    return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }
  function describe(e) {
    const r = role(e);
    const n = r ? name(e, r) : clean(e.getAttribute("aria-label") || textOf(e), 60);
    return (r || e.tagName.toLowerCase()) + (n ? ' "' + n + '"' : "");
  }
  // A label stands for its field.
  function control(e) { return e && e.tagName === "LABEL" && e.control ? e.control : e; }
  function isEditable(e) {
    if (!e) return false;
    if (e.tagName === "TEXTAREA") return !e.disabled && !e.readOnly;
    if (e.tagName === "INPUT") { const ty = (e.getAttribute("type") || "text").toLowerCase(); return !["checkbox","radio","button","submit","reset","image","file","range","color","hidden"].includes(ty) && !e.disabled && !e.readOnly; }
    return e.isContentEditable || ["textbox","searchbox","combobox"].includes(e.getAttribute("role") || "");
  }
  // What is actually under that point: the element, something inside it, or what covers it.
  function hit(ref, x, y) {
    const e = el(ref);
    if (!e) return { ok: false, message: "stale" };
    let top = document.elementFromPoint(x, y);
    while (top && top.shadowRoot) { const inner = top.shadowRoot.elementFromPoint(x, y); if (!inner || inner === top) break; top = inner; }
    if (!top) return { ok: false, message: describe(e) + " is outside the visible page." };
    if (top === e || e.contains(top) || (top.getRootNode() !== document && e.contains(top.getRootNode().host)) || (e.tagName === "LABEL" && e.control === top) || top.tagName === "IFRAME" && e.tagName === "IFRAME") return { ok: true };
    return { ok: false, message: describe(e) + " is covered by " + describe(top) + "." };
  }
  function textIncludes(t) { return (document.body ? document.body.innerText : "").includes(t); }
  function refVisible(ref) { const e = el(ref); return !!e && visible(e); }
  function refFor() { return refOf(this); }
  // Handles go on from where the last document's stopped (the driver says where), so a
  // handle from a page that's gone never names something on the new one.
  const startAt = (n) => { if (Number.isInteger(n) && n > next) next = n; return next; };
  // The element with the keyboard, through open shadow roots.
  function focused() { let e = document.activeElement; while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement; return e; }
  globalThis.__tacit = { startAt, focusedIsPassword: () => document.hasFocus() && !!focused() && isPassword(focused()), snapshot, el, actionable, hit, describe: (ref) => { const e = el(ref); return e ? describe(e) : null; }, textIncludes, refVisible, refFor, isPassword: (ref) => { const e = control(el(ref)); return !!e && isPassword(e); }, isEditable: (ref) => isEditable(control(el(ref))), control: (ref) => control(el(ref)) };
  return true;
})()
`;
