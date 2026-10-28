import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  defaultConnectionType,
  isTwoWay,
  resolveConnectionType,
} from "../../shared/connection-types";
import {
  MAX_WIRE_PURPOSE_LENGTH,
  nodeContract,
  type Ability,
} from "../../shared/node-contracts";
import {
  flipConnectionInScene,
  setConnectionBrowserAccessInScene,
  setConnectionNoteModeInScene,
  setConnectionPlainInScene,
  setConnectionPurposeInScene,
  setConnectionTwoWayInScene,
  setConnectionTypeInScene,
  addRuleInScene,
  removeRuleInScene,
} from "../actions/sceneConnectionActions";
import { rulesOffered, type RuleTrigger } from "../../shared/wire-rules";
import type { ConnectionData } from "../stores/connectionStore";
import type { WireMessage } from "../stores/bridgeActivityStore";
import { abilitiesFor, endpointRole } from "./wireEnds";
import { sendChoices, sendOverWire } from "./wireSend";
import type { PayloadKind } from "../../shared/node-contracts";
import type { ConnectionEndpoint } from "../stores/connectionStore";
import { useT } from "../i18n/useT";

/**
 * Everything about one wire, opened by clicking it or its label.
 *
 * It answers "what does this wire do?" before offering anything to change:
 * the first lines say, in words, what each end can do to the other, worked
 * out from the nodes (shared/node-contracts.ts). Below that, the few things
 * the user decides: what the wire is for, whether it is live or just a link,
 * a read-only limit for a browser, which way it runs, and whether an agent's
 * finished replies are passed on automatically.
 *
 * Same surface and dismissal contract as ContextMenu: viewport flip, Escape
 * and click-away close it.
 */

interface Props {
  /** Screen coordinates of whatever opened it. */
  x: number;
  y: number;
  connection: ConnectionData;
  /** What the two ends are called, in the wire's direction. */
  fromName: string;
  toName: string;
  /** Newest first. */
  recent: WireMessage[];
  nameOf: (endpoint: WireMessage["source"]) => string;
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

const ROW =
  "w-full px-3 py-1.5 text-left text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors duration-quick";

export function WirePanel({ x, y, connection, fromName, toName, recent, nameOf, onClose }: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [purpose, setPurpose] = useState(connection.purpose ?? "");
  const [sendStatus, setSendStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  const type = resolveConnectionType(connection);
  const plain = type === "relates-to";
  const twoWay = isTwoWay(connection);
  const fromRole = endpointRole(connection.from);
  const toRole = endpointRole(connection.to);
  const forward = abilitiesFor(connection, connection.from);
  const backward = abilitiesFor(connection, connection.to);
  const bothStart = nodeContract(fromRole).startsThings && nodeContract(toRole).startsThings;
  const browserHead = toRole === "browser" && nodeContract(fromRole).startsThings;
  const readOnly = connection.limits?.browser === "read";
  const noteIntoAgent = (fromRole === "note" || fromRole === "task") && toRole === "agent";
  const reread = connection.noteMode === "reread";
  const replyRule =
    fromRole === "agent" && toRole === "browser"
      ? ("sends-replies-to" as const)
      : fromRole === "agent" && (toRole === "note" || toRole === "task")
        ? ("writes-to" as const)
        : null;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + rect.width + VIEWPORT_MARGIN > window.innerWidth) {
      nx = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    }
    if (ny + rect.height + VIEWPORT_MARGIN > window.innerHeight) {
      ny = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN);
    }
    setPos({ x: nx, y: ny });
  }, [x, y]);

  // Capture phase, for the same reason ContextMenu does it: React Flow's pane
  // handlers call stopPropagation, which would leave this stuck open.
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (ref.current && !(target instanceof Node && ref.current.contains(target))) onClose();
    };
    window.addEventListener("mousedown", handler, true);
    return () => window.removeEventListener("mousedown", handler, true);
  }, [onClose]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  // Typed purpose is saved when the panel goes away by any route, so
  // clicking off it never loses what was written.
  const purposeRef = useRef(purpose);
  purposeRef.current = purpose;
  useEffect(
    () => () => {
      if ((purposeRef.current.trim() || undefined) !== (connection.purpose ?? undefined)) {
        setConnectionPurposeInScene(connection.id, purposeRef.current);
      }
    },
    [connection.id, connection.purpose],
  );

  const describe = (node: string, other: string, abilities: Ability[], role: typeof fromRole, canSend: boolean) => {
    if (!nodeContract(role).startsThings) {
      return (canSend ? t.connection_starts_nothing_send : t.connection_starts_nothing).replace("{node}", node);
    }
    if (abilities.length === 0) return null;
    const words = abilities.map((ability) => t[`connection_ability_${ability}` as const]);
    const list =
      words.length > 1
        ? `${words.slice(0, -1).join(t.connection_can_join)}${t.connection_can_last}${words[words.length - 1]}`
        : words[0];
    return t.connection_can.replace("{node}", node).replace("{list}", list).replace("{other}", other);
  };

  // What each end can send to the other right now, tail first.
  const sends: Array<{ from: ConnectionEndpoint; other: string; payload: PayloadKind }> = plain
    ? []
    : [
        ...sendChoices(connection, connection.from).map((payload) => ({ from: connection.from, other: toName, payload })),
        ...sendChoices(connection, connection.to).map((payload) => ({ from: connection.to, other: fromName, payload })),
      ];
  const sendLabel = (payload: PayloadKind, other: string, toBrowser: boolean) => {
    const template =
      payload === "page" ? t.connection_send_page
      : payload === "selection" ? t.connection_send_selection
      : payload === "url" ? (toBrowser ? t.connection_send_url_open : t.connection_send_url)
      : t.connection_send_text;
    return template.replace("{other}", other);
  };
  const send = async (from: ConnectionEndpoint, other: string, payload: PayloadKind) => {
    setSending(true);
    setSendStatus(null);
    const outcome = await sendOverWire(connection, from, payload);
    setSending(false);
    if (!outcome.ok) setSendStatus({ tone: "error", text: t.connection_send_failed.replace("{detail}", outcome.detail) });
    else if (outcome.queued) {
      setSendStatus({
        tone: "ok",
        text: t.connection_send_queued.replace("{other}", other).replace("{n}", String(outcome.waiting ?? 1)),
      });
    } else setSendStatus({ tone: "ok", text: t.connection_send_sent });
  };

  // Rules: what is on the wire, and what else the two ends allow.
  const rules = plain ? [] : (connection.rules ?? []);
  const offered = rulesOffered(fromRole, toRole, plain).filter(
    (o) => !rules.some((r) => r.when === o.when && r.at === o.at),
  );
  const ruleSentence = (when: RuleTrigger, at: "from" | "to") => {
    const event = at === "from" ? fromName : toName;
    const other = at === "from" ? toName : fromName;
    const template = when === "turn_finished" ? t.connection_rule_turn_finished : t.connection_rule_console_error;
    return template.replace("{event}", event).replace("{other}", other);
  };

  const forwardLine = plain
    ? null
    : describe(fromName, toName, forward, fromRole, sends.some((s) => s.from === connection.from));
  const backwardLine =
    plain || !twoWay ? null : describe(toName, fromName, backward, toRole, sends.some((s) => s.from === connection.to));

  return (
    <div
      ref={ref}
      data-scene-box-select-block
      role="dialog"
      aria-label={t.connection_panel_aria}
      className="fixed z-[100] py-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg"
      style={{ left: pos.x, top: pos.y, width: 290, fontFamily: '"Geist Mono", monospace' }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div
        className="px-3 pt-1 pb-1.5 border-b border-[var(--border)] text-[11px] text-[var(--text-muted)] truncate"
        title={`${fromName} ${twoWay ? "⇄" : "→"} ${toName}`}
      >
        {fromName} <span className="text-[var(--accent)]">{twoWay ? "⇄" : "→"}</span> {toName}
      </div>

      <div className="px-3 py-2 text-[11px] leading-snug text-[var(--text-secondary)] flex flex-col gap-1" data-testid="wire-does">
        {plain ? (
          <span className="text-[var(--text-muted)]">{t.connection_plain_note}</span>
        ) : (
          <>
            {forwardLine && <span>{forwardLine}</span>}
            {backwardLine && <span>{backwardLine}</span>}
          </>
        )}
      </div>

      <label className="block px-3 pb-2">
        <span className="block text-[10px] uppercase tracking-wide text-[var(--text-faint)] mb-1">
          {t.connection_purpose_label}
        </span>
        <input
          value={purpose}
          maxLength={MAX_WIRE_PURPOSE_LENGTH}
          placeholder={t.connection_purpose_placeholder}
          aria-label={t.connection_purpose_label}
          className="w-full bg-transparent border-b border-[var(--accent)]/40 outline-none text-[12px] py-1"
          style={{ color: "var(--text-primary)" }}
          onChange={(event) => setPurpose(event.target.value.slice(0, MAX_WIRE_PURPOSE_LENGTH))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onClose();
            }
          }}
        />
      </label>

      <Segmented
        options={[
          { key: "live", label: t.connection_live, active: !plain, onPick: () => setConnectionPlainInScene(connection.id, false) },
          { key: "plain", label: t.connection_plain, active: plain, onPick: () => setConnectionPlainInScene(connection.id, true) },
        ]}
      />

      {!plain && browserHead && (
        <Segmented
          options={[
            { key: "drive", label: t.connection_access_drive, active: !readOnly, onPick: () => setConnectionBrowserAccessInScene(connection.id, "drive") },
            { key: "read", label: t.connection_access_read, active: readOnly, onPick: () => setConnectionBrowserAccessInScene(connection.id, "read") },
          ]}
        />
      )}

      {!plain && noteIntoAgent && (
        <>
          <Segmented
            options={[
              { key: "send", label: t.connection_note_send, active: !reread, onPick: () => setConnectionNoteModeInScene(connection.id, "send") },
              { key: "reread", label: t.connection_note_reread, active: reread, onPick: () => setConnectionNoteModeInScene(connection.id, "reread") },
            ]}
          />
          {reread && (
            <div className="px-3 pb-2 -mt-1 text-[10px] leading-snug text-[var(--text-faint)]">
              {t.connection_note_reread_hint}
            </div>
          )}
        </>
      )}

      {!plain && replyRule && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={type === replyRule}
          className={ROW}
          onClick={() =>
            setConnectionTypeInScene(
              connection.id,
              type === replyRule
                ? defaultConnectionType(connection.from.kind, connection.to.kind)
                : replyRule,
            )
          }
        >
          <span className="flex items-center justify-between gap-3">
            <span>{replyRule === "sends-replies-to" ? t.connection_reply_rule_browser : t.connection_reply_rule_note}</span>
            <span className={type === replyRule ? "text-[var(--accent)]" : "text-[var(--text-faint)]"}>
              {type === replyRule ? "●" : "○"}
            </span>
          </span>
        </button>
      )}

      {(rules.length > 0 || offered.length > 0) && (
        <div className="mt-1 pt-1 border-t border-[var(--border)]" data-testid="wire-rules">
          <div className="px-3 pt-1 text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
            {t.connection_rules_heading}
          </div>
          {rules.map((rule) => (
            <div key={rule.id} className="px-3 py-1.5 flex items-start justify-between gap-2 text-[12px]">
              <span className="text-[var(--text-secondary)] leading-snug">
                {ruleSentence(rule.when, rule.at)}
                <span className="block text-[10px] text-[var(--text-faint)]">
                  {rule.consent === "always" ? t.connection_rule_always : t.connection_rule_asks}
                </span>
              </span>
              <button
                type="button"
                aria-label={t.connection_rule_remove}
                title={t.connection_rule_remove}
                className="text-[var(--text-faint)] hover:text-[var(--red)] px-1"
                onClick={() => removeRuleInScene(connection.id, rule.id)}
              >
                ×
              </button>
            </div>
          ))}
          {offered.map((o) => (
            <button
              key={`${o.when}:${o.at}`}
              type="button"
              className={ROW}
              onClick={() => addRuleInScene(connection.id, o.when, o.at)}
            >
              + {ruleSentence(o.when, o.at)}
            </button>
          ))}
        </div>
      )}

      {sends.length > 0 && (
        <div className="mt-1 pt-1 border-t border-[var(--border)]">
          <div className="px-3 pt-1 text-[10px] uppercase tracking-wide text-[var(--text-faint)]">
            {t.connection_send_heading}
          </div>
          {sends.map(({ from, other, payload }) => {
            const toBrowser = (from === connection.from ? toRole : fromRole) === "browser";
            return (
              <button
                key={`${from.kind}:${from.id}:${payload}`}
                type="button"
                className={ROW}
                disabled={sending}
                onClick={() => void send(from, other, payload)}
              >
                ↗ {sendLabel(payload, other, toBrowser)}
              </button>
            );
          })}
          {sendStatus && (
            <div
              role="status"
              className={`px-3 pb-1.5 text-[11px] leading-snug ${
                sendStatus.tone === "error" ? "text-[var(--red)]" : "text-[var(--text-muted)]"
              }`}
            >
              {sendStatus.text}
            </div>
          )}
        </div>
      )}

      <div className="mt-1 pt-1 border-t border-[var(--border)]">
        <button
          type="button"
          className={ROW}
          disabled={twoWay}
          onClick={() => {
            flipConnectionInScene(connection.id);
            onClose();
          }}
        >
          ⇆ {t.connection_flip}
        </button>
        {bothStart && (
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={twoWay}
            className={ROW}
            onClick={() => setConnectionTwoWayInScene(connection.id, !twoWay)}
          >
            <span className="flex items-center justify-between gap-3">
              <span>⇄ {t.connection_two_way}</span>
              <span className={twoWay ? "text-[var(--accent)]" : "text-[var(--text-faint)]"}>
                {twoWay ? "●" : "○"}
              </span>
            </span>
          </button>
        )}
      </div>

      {recent.length > 0 && (
        <div className="mt-1 pt-1 border-t border-[var(--border)] px-3 py-1">
          <div className="text-[10px] uppercase tracking-wide text-[var(--text-faint)] mb-1">
            {t.connection_recent_heading}
          </div>
          {recent.map((message) => (
            <div key={message.requestId} className="text-[11px] leading-snug py-0.5 truncate" title={message.preview ?? ""}>
              <span className="text-[var(--text-muted)]">
                {nameOf(message.source)} → {nameOf(message.target)}:
              </span>{" "}
              <span className={message.status === "failed" ? "text-[var(--red)]" : "text-[var(--text-secondary)]"}>
                {message.preview ?? "—"}
                {message.status === "failed" ? ` · ${t.connection_message_failed}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Segmented({
  options,
}: {
  options: Array<{ key: string; label: string; active: boolean; onPick: () => void }>;
}) {
  return (
    <div className="px-3 pb-2 flex gap-1" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="radio"
          aria-checked={option.active}
          className={`flex-1 px-2 py-1 rounded text-[11px] border transition-colors duration-quick ${
            option.active
              ? "border-[var(--accent)]/60 text-[var(--accent)] bg-[var(--accent)]/10"
              : "border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
          onClick={option.onPick}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
