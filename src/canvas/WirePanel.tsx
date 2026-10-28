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
  setConnectionPlainInScene,
  setConnectionPurposeInScene,
  setConnectionTwoWayInScene,
  setConnectionTypeInScene,
} from "../actions/sceneConnectionActions";
import type { ConnectionData } from "../stores/connectionStore";
import type { WireMessage } from "../stores/bridgeActivityStore";
import { abilitiesFor, endpointRole } from "./wireEnds";
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

  const describe = (node: string, other: string, abilities: Ability[], role: typeof fromRole) => {
    if (!nodeContract(role).startsThings) {
      return t.connection_starts_nothing.replace("{node}", node);
    }
    if (abilities.length === 0) return null;
    const words = abilities.map((ability) => t[`connection_ability_${ability}` as const]);
    const list =
      words.length > 1
        ? `${words.slice(0, -1).join(t.connection_can_join)}${t.connection_can_last}${words[words.length - 1]}`
        : words[0];
    return t.connection_can.replace("{node}", node).replace("{list}", list).replace("{other}", other);
  };

  const forwardLine = plain ? null : describe(fromName, toName, forward, fromRole);
  const backwardLine = plain || !twoWay ? null : describe(toName, fromName, backward, toRole);

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
