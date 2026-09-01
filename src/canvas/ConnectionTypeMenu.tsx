import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  MAX_CUSTOM_PROMPT_LENGTH,
  connectionTypeSpec,
  validConnectionTypes,
  type ConnectionEndpointKind,
  type ConnectionType,
} from "../../shared/connection-types";
import { setConnectionTypeInScene } from "../actions/sceneConnectionActions";
import { useT } from "../i18n/useT";

/**
 * Choose what a wire means.
 *
 * Opened by clicking a wire's own type label, so the thing you change is the
 * thing you were just reading. The rows are exactly
 * `validConnectionTypes(from, to)` — no greyed-out entries for combinations that
 * can never apply, which is a menu teaching you about restrictions instead of
 * offering you choices. `custom` is always last, beneath the presets rather than
 * a peer of them, and is the only row that asks for anything.
 *
 * Modelled on ContextMenu (same surface, same viewport flip, same Escape and
 * click-away contract) rather than reusing it, because it needs a second state:
 * picking `custom` swaps the list for one text field without closing, so the
 * user does not lose their place by choosing the option that needs more input.
 */

interface Props {
  /** Screen coordinates of the label that opened this. */
  x: number;
  y: number;
  connectionId: string;
  fromKind: ConnectionEndpointKind;
  toKind: ConnectionEndpointKind;
  /** Resolved, so the inferred meaning of an untyped wire shows as current. */
  current: ConnectionType;
  currentPrompt?: string;
  onClose: () => void;
}

const VIEWPORT_MARGIN = 8;

export function ConnectionTypeMenu({
  x,
  y,
  connectionId,
  fromKind,
  toKind,
  current,
  currentPrompt,
  onClose,
}: Props) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ x, y });
  // Entered by picking `custom`, or opened straight into it when the wire is
  // already custom — there is nothing to choose in that case, only a sentence
  // to edit.
  const [editingCustom, setEditingCustom] = useState(current === "custom");
  const [draft, setDraft] = useState(currentPrompt ?? "");

  const types = validConnectionTypes(fromKind, toKind);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (nx + rect.width + VIEWPORT_MARGIN > window.innerWidth) {
      nx = Math.max(
        VIEWPORT_MARGIN,
        window.innerWidth - rect.width - VIEWPORT_MARGIN,
      );
    }
    if (ny + rect.height + VIEWPORT_MARGIN > window.innerHeight) {
      ny = Math.max(
        VIEWPORT_MARGIN,
        window.innerHeight - rect.height - VIEWPORT_MARGIN,
      );
    }
    setPos({ x: nx, y: ny });
  }, [x, y, editingCustom]);

  // Capture phase, for the same reason ContextMenu does it: React Flow's pane
  // handlers call stopPropagation, which would leave this stuck open.
  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
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

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (editingCustom) {
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const first = node.querySelector<HTMLElement>("[role='menuitem']");
    if (first) requestAnimationFrame(() => first.focus());
  }, [editingCustom]);

  const apply = (type: ConnectionType, prompt?: string) => {
    setConnectionTypeInScene(connectionId, type, prompt);
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    const node = ref.current;
    if (!node || editingCustom) return;
    const items = Array.from(
      node.querySelectorAll<HTMLElement>("[role='menuitem']"),
    );
    const active = document.activeElement as HTMLElement | null;
    const index = active ? items.indexOf(active) : -1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const remaining = MAX_CUSTOM_PROMPT_LENGTH - draft.length;

  return (
    <div
      ref={ref}
      data-scene-box-select-block
      role="menu"
      aria-label={t.connection_type_menu_aria_label}
      className="fixed z-[100] py-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg"
      style={{
        left: pos.x,
        top: pos.y,
        minWidth: editingCustom ? 260 : 170,
        maxWidth: 300,
        fontFamily: '"Geist Mono", monospace',
      }}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {!editingCustom && (
        <>
          {types.map((type) => {
            const spec = connectionTypeSpec(type);
            const isCurrent = type === current;
            return (
              <button
                key={type}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-checked={isCurrent}
                className={`w-full px-3 py-1.5 text-left text-[12px] transition-colors duration-quick ${
                  isCurrent
                    ? "text-[var(--accent)] bg-[var(--accent)]/10"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border)]"
                }`}
                onClick={() => {
                  // `custom` is the one row that cannot be applied by clicking
                  // it: without a sentence it means nothing, so it opens the
                  // field instead of committing an empty rule.
                  if (spec.needsInput) {
                    setEditingCustom(true);
                    return;
                  }
                  apply(type);
                }}
              >
                {spec.label}
                {spec.needsInput ? "…" : ""}
              </button>
            );
          })}
          {/* Honest about how much of this is wired up. Only `controls` has a
              behaviour today; the rest are recorded and drawn, which is real
              but is not the same as running. Kept to one faint line rather
              than a badge per row. */}
          <div className="mt-1 pt-1 border-t border-[var(--border)] px-3 py-1 text-[10px] leading-snug text-[var(--text-faint)]">
            {t.connection_type_inactive_note}
          </div>
        </>
      )}

      {editingCustom && (
        <div className="px-3 py-1.5">
          <div className="text-[11px] text-[var(--text-secondary)] mb-1.5">
            {t.connection_type_custom_title}
          </div>
          <input
            ref={inputRef}
            value={draft}
            maxLength={MAX_CUSTOM_PROMPT_LENGTH}
            placeholder={t.connection_type_custom_placeholder}
            aria-label={t.connection_type_custom_title}
            className="w-full bg-transparent border-b border-[var(--accent)]/40 outline-none text-[12px] py-1"
            style={{ color: "var(--text-primary)" }}
            onChange={(event) =>
              setDraft(event.target.value.slice(0, MAX_CUSTOM_PROMPT_LENGTH))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (draft.trim()) apply("custom", draft);
              }
            }}
          />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-[var(--text-faint)]">
              {t.connection_type_custom_remaining.replace(
                "{n}",
                String(remaining),
              )}
            </span>
            <button
              type="button"
              disabled={!draft.trim()}
              className="text-[11px] px-2 py-0.5 rounded border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--border)] disabled:opacity-40 disabled:hover:bg-transparent transition-colors duration-quick"
              onClick={() => {
                if (draft.trim()) apply("custom", draft);
              }}
            >
              {t.connection_type_custom_apply}
            </button>
          </div>
          {/* Says plainly what a custom rule is and costs. It is a sentence
              handed to a model, not a transform anyone verified. */}
          <div className="mt-2 text-[10px] leading-snug text-[var(--text-faint)]">
            {t.connection_type_custom_caveat}
          </div>
        </div>
      )}
    </div>
  );
}
