/**
 * The plumbing between an agent finishing and its answer appearing in a chat.
 *
 * The workflow this serves was done by hand first: the agent finishes, the
 * user copies its answer into a ChatGPT or Gemini tab, and then talks it
 * through — usually out loud, which is the point. A `sends-replies-to` wire
 * automates exactly the copy and the paste and stops there. Nothing reads the
 * response, nothing waits for it, nothing comes back to the agent. The
 * conversation that follows belongs to the user.
 *
 * Three rules, and each of them is a decision rather than an implementation
 * detail:
 *
 * **Once per task, not once per turn.** The completion signal is a hint; the
 * transcript decides (shared/agent-reply.ts). A reply pasted mid-task is worse
 * than no reply at all, because the user answers it and is then a turn behind.
 *
 * **The whole reply, as written.** No summarising, no stripping code blocks,
 * no "here's what the agent said" preamble. The user asked for the answer, and
 * anything added is something they then have to read past when they are trying
 * to talk to it.
 *
 * **Failures are told, never retried and never queued.** A reply that lands
 * three minutes late, after the user has moved the conversation on, reads as
 * the agent answering a question nobody asked. Saying "this did not arrive" is
 * strictly kinder than delivering it out of order.
 */

import {
  buildChatDeliveryScript,
  type ChatDeliveryScriptResult,
} from "../../shared/chat-delivery-script";
import {
  overrideForUrl,
  resolveReplyTargets,
  type ChatDeliveryOutcome,
} from "../../shared/chat-delivery";
import {
  findTerminalForSession,
  isReplyTranscriptProvider,
  replyDeliveryNotification,
  telemetrySaysBusy,
} from "../../shared/agent-reply";
import { useConnectionStore } from "../stores/connectionStore";
import { useBrowserCardStore } from "../stores/browserCardStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import { useChatInputOverrideStore } from "../stores/chatInputOverrideStore";
import { useTerminalRuntimeStore } from "../terminal/terminalRuntimeStore";
import { resolveTerminalRuntimeState } from "../stores/terminalRuntimeStateStore";
import { getTerminalDisplayTitle } from "../stores/terminalState";
import { getBrowserWebview } from "../canvas/browserWebviewRegistry";
import { checkAgentActionOnCard } from "./agentBrowserProfiles";
import { recordDecision } from "../capture";
import type { TerminalData } from "../types";

/** The action name every entry in the decision record uses for this. */
const DELIVER_ACTION = "deliver_reply";

/**
 * The last reply delivered per terminal.
 *
 * Turn completion reaches the renderer twice on Claude — once from the Stop
 * hook and once from the transcript watcher — and both are worth keeping: the
 * hook is precise, the watcher is what covers a CLI running without hooks.
 * Comparing the text is what makes them idempotent, and it costs nothing that
 * a genuinely repeated answer is delivered once, since it is the same words
 * arriving in the same chat.
 */
const lastDelivered = new Map<string, string>();

/**
 * Terminals with a delivery in progress.
 *
 * The two completion signals arrive within milliseconds of each other, and
 * comparing the reply text cannot separate them on its own: both would read
 * the transcript, both would find no previous delivery, and the user would get
 * the same paragraph pasted into their chat twice. So the second one is
 * dropped while the first is still working.
 */
const inFlight = new Set<string>();

/** Browser nodes currently waiting for the user to point at their message box. */
const armedCaptures = new Set<string>();

/**
 * How long the "click the box" mode stays armed.
 *
 * Long enough to cover reading the toast, switching canvases, and finding the
 * tab — the failure it follows is one the user answers in their own time, and
 * a mode that expires while they are still walking towards it teaches them the
 * fix does not work.
 */
const CAPTURE_WINDOW_MS = 5 * 60_000;

/** How many clicks on something that is not a text box the mode forgives. */
const MAX_CAPTURE_ATTEMPTS = 3;

function notify(
  type: "error" | "warn" | "info",
  message: string,
  action?: { label: string; run: () => void },
) {
  useNotificationStore.getState().notify(type, message, action);
}

/** Every terminal on the canvas, with the runtime's session id rather than the
 * scene's — a `/resume` swaps the session under a tile without rewriting it. */
function allTerminals(): TerminalData[] {
  const out: TerminalData[] = [];
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      for (const terminal of worktree.terminals) {
        const { sessionId } = resolveTerminalRuntimeState(terminal);
        out.push({ ...terminal, sessionId });
      }
    }
  }
  return out;
}

function locateTerminal(
  terminalId: string,
): { terminal: TerminalData; cwd: string } | null {
  for (const project of useProjectStore.getState().projects) {
    for (const worktree of project.worktrees) {
      const found = worktree.terminals.find((t) => t.id === terminalId);
      if (!found) continue;
      const { sessionId } = resolveTerminalRuntimeState(found);
      return { terminal: { ...found, sessionId }, cwd: worktree.path };
    }
  }
  return null;
}

function targetLabelFor(kind: string, id: string): string {
  if (kind !== "browser") return id;
  const card = useBrowserCardStore.getState().cards[id];
  if (!card) return "that page";
  const title = card.title?.trim();
  if (title && title !== card.url) return title;
  try {
    return new URL(card.url).host || card.url;
  } catch {
    return card.url || "that page";
  }
}

function recordDelivery(
  cardId: string,
  outcome: { ok: boolean; error?: string; url?: string },
) {
  const card = useBrowserCardStore.getState().cards[cardId];
  recordDecision({
    kind: "browser_action",
    node: `browser:${cardId}`,
    action: DELIVER_ACTION,
    backend: card?.backend?.kind === "connected-tab" ? "connected-tab" : "managed",
    // The agent is the actor: the user drew the wire, but nobody pressed
    // anything at the moment this happened.
    by: "system",
    ok: outcome.ok,
    ...(outcome.url ? { url: outcome.url } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(card && card.backend?.kind !== "connected-tab"
      ? { profile: card.identityId }
      : {}),
  });
}

/**
 * Put one reply into one page.
 *
 * The script is built once and evaluated once — see chat-delivery-script.ts
 * for why splitting typing from submitting silently loses the send.
 */
async function deliverToBrowserCard(
  cardId: string,
  text: string,
): Promise<{ outcome: ChatDeliveryOutcome; reported: boolean }> {
  const label = targetLabelFor("browser", cardId);
  const card = useBrowserCardStore.getState().cards[cardId];
  if (!card) return { outcome: { ok: false, reason: "node-gone" }, reported: false };

  // Re-checked here rather than trusted from when the wire was drawn: a
  // profile withheld from agents ten seconds ago has to stop this, and a reply
  // typed into a personal chat is not something an undo can take back.
  const permission = checkAgentActionOnCard(cardId);
  if (!permission.allowed) {
    recordDelivery(cardId, {
      ok: false,
      error: `${permission.code}: ${permission.message}`,
      url: card.url,
    });
    // Said in the permission's own words rather than as a delivery failure:
    // nothing was attempted, and there is nothing on the page to fix.
    notify("warn", `Didn't send the reply to ${label}: ${permission.message}`);
    return { outcome: { ok: false, reason: "node-gone" }, reported: true };
  }

  const webview = getBrowserWebview(cardId);
  if (!webview) {
    return { outcome: { ok: false, reason: "node-gone" }, reported: false };
  }

  let url = card.url;
  try {
    url = webview.getURL() || card.url;
  } catch {
    // A guest that is still attaching answers nothing; the stored URL is the
    // best available guess at which host's override applies.
  }

  const selector = overrideForUrl(
    url,
    useChatInputOverrideStore.getState().overrides,
  );

  let result: ChatDeliveryScriptResult;
  try {
    result = (await webview.executeJavaScript(
      buildChatDeliveryScript({ text, selector, submit: true }),
    )) as ChatDeliveryScriptResult;
  } catch (err) {
    recordDelivery(cardId, {
      ok: false,
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: { ok: false, reason: "page-not-ready" }, reported: false };
  }

  if (result?.ok) {
    recordDelivery(cardId, { ok: true, url });
    return { outcome: { ok: true, targetLabel: label }, reported: false };
  }

  const reason = result?.reason ?? "page-not-ready";
  recordDelivery(cardId, { ok: false, url, error: reason });
  return { outcome: { ok: false, reason }, reported: false };
}

/**
 * Ask the user to point at the box, then remember it for that host.
 *
 * Armed automatically the moment a delivery cannot find the box, because that
 * is what the failure message promises — "click the box once and Tacit will
 * remember it" reads as a thing you do next, not as a mode you first have to
 * find. The toast that says so expires in seconds; the arming outlasts it.
 *
 * Runs entirely in the guest as a one-shot listener that resolves the
 * evaluation's promise, so it needs nothing from the preload and leaves no
 * state behind if the user walks away — the page keeps working while it is
 * armed, and Escape or the window elapsing cancels it.
 */
export async function captureChatInputSelector(
  cardId: string,
  /**
   * How many misses have already happened. A click on something that is not a
   * text box re-arms rather than giving up — telling someone to click the box
   * and then not listening when they click slightly wide of it is the app
   * blaming them for its own aim. Bounded so a page that dispatches synthetic
   * clicks cannot hold the mode open forever.
   */
  attempt = 0,
): Promise<void> {
  const label = targetLabelFor("browser", cardId);
  const webview = getBrowserWebview(cardId);
  if (!webview) {
    notify("warn", `The ${label} node closed, so there was nothing to point at.`);
    return;
  }

  // Armed twice — once automatically when the box could not be found, once
  // from the toast's button — would mean two banners and two listeners racing
  // over one click. The first arming stands.
  if (armedCaptures.has(cardId)) return;
  armedCaptures.add(cardId);
  // A page that navigates away takes its listener with it and the evaluation
  // never settles, so the armed flag needs its own way out.
  const release = setTimeout(
    () => armedCaptures.delete(cardId),
    CAPTURE_WINDOW_MS + 5_000,
  );

  let result: { ok: boolean; selector?: string; url?: string; reason?: string };
  try {
    result = (await webview.executeJavaScript(CAPTURE_SCRIPT)) as typeof result;
  } catch {
    notify("warn", `Couldn't listen for a click in ${label}.`);
    return;
  } finally {
    clearTimeout(release);
    armedCaptures.delete(cardId);
  }

  if (!result?.ok || !result.selector || !result.url) {
    if (result?.reason === "not-an-input" && attempt < MAX_CAPTURE_ATTEMPTS) {
      notify("warn", `That wasn't a message box. Click inside the box you type in.`);
      void captureChatInputSelector(cardId, attempt + 1);
    }
    // A cancelled or timed-out capture says nothing: the user changed their
    // mind, and a notification about it is just noise about a non-event.
    return;
  }

  const host = useChatInputOverrideStore
    .getState()
    .remember(result.url, result.selector);
  if (!host) {
    notify("warn", `Couldn't tell which site ${label} is, so nothing was saved.`);
    return;
  }
  notify("info", `Got it — replies will go into that box on ${host} from now on.`);
}

/**
 * The in-page half of "click the box once".
 *
 * A single string, like the delivery script and for the same reason: it has to
 * survive `executeJavaScript` intact. The selector it builds prefers whatever
 * the page's own authors gave the element a name for — an id, a test id, an
 * aria-label — and only falls back to a positional path, which is the version
 * most likely to rot on the next redesign.
 */
const CAPTURE_SCRIPT = `(async () => {
  const EDITABLE = 'textarea, input[type="text"], input[type="search"], [contenteditable="true"], [contenteditable=""]';

  const banner = document.createElement("div");
  banner.textContent = "Tacit: click the box you type messages into (Esc to cancel)";
  banner.setAttribute("style", [
    "position:fixed", "left:50%", "top:16px", "transform:translateX(-50%)",
    "z-index:2147483647", "padding:8px 14px", "border-radius:999px",
    "background:rgba(20,20,22,0.92)", "color:#fff", "font:13px/1.4 system-ui,sans-serif",
    "box-shadow:0 4px 16px rgba(0,0,0,0.3)", "pointer-events:none",
  ].join(";"));
  document.body?.appendChild(banner);

  const selectorFor = (el) => {
    const esc = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&"));
    const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
    if (el.id && unique("#" + esc(el.id))) return "#" + esc(el.id);
    const tag = el.tagName.toLowerCase();
    for (const attr of ["data-testid", "data-test-id", "name", "aria-label", "placeholder", "data-id"]) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const sel = tag + "[" + attr + '="' + value.replace(/"/g, '\\\\"') + '"]';
      if (unique(sel)) return sel;
    }
    // Positional fallback: shortest path from the element up that is unique.
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (unique(candidate)) return candidate;
      node = parent;
    }
    return parts.join(" > ");
  };

  return await new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
      banner.remove();
      resolve(value);
    };
    const onClick = (event) => {
      const el = event.target && event.target.closest ? event.target.closest(EDITABLE) : null;
      if (!el) { finish({ ok: false, reason: "not-an-input" }); return; }
      // The click is allowed through: the user meant to focus that box, and
      // swallowing it would make the page feel broken for no benefit.
      finish({ ok: true, selector: selectorFor(el), url: location.href });
    };
    const onKey = (event) => { if (event.key === "Escape") finish({ ok: false, reason: "cancelled" }); };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), ${CAPTURE_WINDOW_MS});
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  });
})()`;

/**
 * An agent went idle. Work out whether that was the end of a task, and if it
 * was, hand the answer on.
 *
 * Called from both completion signals. Everything cheap happens before
 * anything expensive: a terminal with no `sends-replies-to` wire — which is
 * nearly all of them, nearly all the time — costs one map lookup and returns.
 */
/**
 * How long an agent must stay quiet before its reply is treated as final.
 *
 * A turn boundary is not a task boundary. An agent waiting on background work
 * genuinely ends its turn — the transcript shows a complete assistant message
 * with nothing pending — and then starts a new one when the work reports back.
 * Nothing distinguishes that from being finished, so waiting for silence is the
 * only signal that actually means "done".
 *
 * Observed in the failure this fixes: three background agents reporting ~7s
 * apart produced turns the gate could not tell from a finished task, and the
 * chat received "shared/ reported in: 21. Waiting on electron/ and src/."
 * instead of the final table. The window is well clear of that spacing.
 *
 * The cost is that every delivery is late by this much, which is the right
 * trade here: these land in a chat the user comes back to, not one they are
 * watching.
 */
export const QUIET_PERIOD_MS = 30_000;

interface PendingDelivery {
  timer: ReturnType<typeof setTimeout>;
  sessionId: string | null;
}

/**
 * One pending delivery per terminal. A new turn replaces the previous timer
 * rather than queueing beside it, so a task made of many turns delivers once,
 * carrying whatever the agent said last.
 */
const pending = new Map<string, PendingDelivery>();

/** Cancel anything waiting — used on teardown so a timer cannot outlive the app. */
function cancelPending(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
}

export async function handleAgentTurnComplete(signal: {
  terminalId?: string | null;
  sessionId?: string | null;
  /** Skips the quiet period. Tests drive the debounce explicitly. */
  immediate?: boolean;
}): Promise<void> {
  const terminalId =
    signal.terminalId ??
    (signal.sessionId
      ? findTerminalForSession(allTerminals(), signal.sessionId)
      : null);
  if (!terminalId) return;

  const targets = resolveReplyTargets(
    terminalId,
    Object.values(useConnectionStore.getState().connections),
  );
  if (targets.length === 0) return;

  // Supersede any pending delivery for this terminal: the agent spoke again,
  // so whatever it said before was not its last word.
  const existing = pending.get(terminalId);
  if (existing) clearTimeout(existing.timer);

  const run = async () => {
    pending.delete(terminalId);
    if (inFlight.has(terminalId)) return;
    inFlight.add(terminalId);
    try {
      await deliverForTerminal(terminalId, targets, signal.sessionId ?? null);
    } finally {
      inFlight.delete(terminalId);
    }
  };

  if (signal.immediate) {
    await run();
    return;
  }

  pending.set(terminalId, {
    sessionId: signal.sessionId ?? null,
    timer: setTimeout(() => { void run(); }, QUIET_PERIOD_MS),
  });
}

async function deliverForTerminal(
  terminalId: string,
  targets: ReturnType<typeof resolveReplyTargets>,
  signalSessionId: string | null,
): Promise<void> {
  const located = locateTerminal(terminalId);
  if (!located) return;
  const { terminal, cwd } = located;

  // A completion event from a session this tile no longer holds. Terminal ids
  // are reused when a CLI exits and the tile falls back to a shell, so a
  // late-arriving Stop hook from the dead session would otherwise deliver the
  // wrong agent's last words.
  if (signalSessionId && terminal.sessionId && signalSessionId !== terminal.sessionId) {
    return;
  }

  const provider = terminal.type;
  if (!isReplyTranscriptProvider(provider)) return;
  if (!terminal.sessionId) return;

  // A tool still in flight contradicts the completion signal. The transcript
  // is the authority and is checked next, but it is written after the fact, so
  // this closes the window where the file has not caught up yet.
  const telemetry =
    useTerminalRuntimeStore.getState().terminals[terminalId]?.telemetry ?? null;
  if (telemetrySaysBusy(telemetry)) return;

  const reply = await window.termcanvas?.session?.finalReply?.({
    sessionId: terminal.sessionId,
    provider,
    cwd,
  });
  if (!reply) return;

  // Still working, or finished without saying anything. Neither is a failure
  // and neither is the user's problem, so neither is reported.
  if (reply.status === "mid-task" || reply.status === "no-reply") return;

  if (reply.status === "unavailable") {
    // This one *is* worth saying. The user drew a wire and is entitled to know
    // it did not fire, even though the reason is ours rather than theirs.
    const label = targets.map((t) => targetLabelFor(t.kind, t.id)).join(", ");
    notify(
      "warn",
      `Couldn't read ${getTerminalDisplayTitle(terminal)}'s reply, so nothing was sent to ${label}.`,
    );
    return;
  }

  if (lastDelivered.get(terminalId) === reply.text) return;
  lastDelivered.set(terminalId, reply.text);

  for (const target of targets) {
    if (target.kind !== "browser") {
      // A reply wire into another terminal is a different feature — it would
      // mean typing into that agent's prompt, which is a handoff, not a
      // delivery. Said out loud rather than dropped, so the wire the user drew
      // is not silently inert.
      notify(
        "warn",
        `Replies are only delivered into browser nodes; the wire to ${targetLabelFor(target.kind, target.id)} did nothing.`,
      );
      continue;
    }

    const { outcome, reported } = await deliverToBrowserCard(target.id, reply.text);
    if (reported) continue;
    const notification = replyDeliveryNotification(
      outcome,
      getTerminalDisplayTitle(terminal),
      targetLabelFor(target.kind, target.id),
    );
    notify(
      notification.type,
      notification.message,
      notification.offerCapture
        ? {
            label: "Point at the box",
            run: () => {
              void captureChatInputSelector(target.id);
            },
          }
        : undefined,
    );
    if (notification.offerCapture) {
      // Armed without being asked, because the message just told the user to
      // click the box and they should not have to catch a five-second toast to
      // be allowed to. The button re-arms it and is a no-op while it is live.
      void captureChatInputSelector(target.id);
    }
  }
}

/**
 * Subscribe to both completion signals for the lifetime of the app.
 *
 * The hook fires only for the main agent, which is exactly right; the
 * transcript watcher is the fallback for a CLI running without Tacit's hooks
 * installed, and is less precise. Both are accepted and de-duplicated by the
 * text of the reply, because missing a handoff entirely is the worse failure.
 */
export function installReplyDelivery(): () => void {
  const disposers: Array<() => void> = [];

  const session = window.termcanvas?.session;
  if (session?.onTurnComplete) {
    disposers.push(
      session.onTurnComplete((sessionId) => {
        void handleAgentTurnComplete({ sessionId });
      }),
    );
  }

  const hooks = window.termcanvas?.hooks;
  if (hooks?.onTurnComplete) {
    disposers.push(
      hooks.onTurnComplete((payload) => {
        void handleAgentTurnComplete({
          terminalId: payload.terminalId,
          sessionId: payload.sessionId,
        });
      }),
    );
  }

  return () => {
    for (const dispose of disposers) dispose();
    cancelPending();
  };
}
