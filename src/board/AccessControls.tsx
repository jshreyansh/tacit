import { useRef, useState } from "react";
import { PickerHeading, PickerPopover } from "../agents/AgentPicker";
import { useT } from "../i18n/useT";
import { useBoardStore } from "../stores/boardStore";
import type { BoardAgentAccess, BoardElement } from "../types/board";
import { accessOf, isAgents } from "./boardAccess";
import { agentsDefault, setAgentsDefault } from "./accessDefault";
import { setAccess } from "./agentOps";

export const ACCESS: readonly BoardAgentAccess[] = ["ask", "edit", "mine"];

/** Ask first, can edit, only me. */
export function AccessIcon({ access, size = 13 }: { access: BoardAgentAccess; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {access === "ask" && <path d="M5.8 6a2.2 2.2 0 114 1.4c-.7.6-1.6.9-1.6 2.1M8.2 12.4v.01" />}
      {access === "edit" && <path d="M3 13h2.4l7.2-7.2-2.4-2.4L3 10.6zM8.8 4.8l2.4 2.4" />}
      {access === "mine" && <path d="M4.5 7.5V5.6a3.5 3.5 0 017 0v1.9M3.6 7.5h8.8v6H3.6z" />}
    </svg>
  );
}

/** Where agents stand on what's selected. One thing's, or several's. */
export function AccessRow({ els }: { els: readonly BoardElement[] }) {
  const t = useT();
  const elements = useBoardStore((s) => s.elements);
  const first = els[0] ? accessOf(els[0], elements) : "ask";
  const same = els.every((e) => accessOf(e, elements) === first);
  return (
    <>
      <div className="tc-bd-caption">{t.board_agents}</div>
      <div className="tc-bd-access" role="radiogroup" aria-label={t.board_agents}>
        {ACCESS.map((a) => (
          <button key={a} type="button" role="radio" aria-checked={same && first === a} title={t.board_access_title[a]} onClick={() => setAccess(els.map((e) => e.id), a)}>
            <AccessIcon access={a} />
            {t.board_access[a]}
          </button>
        ))}
      </div>
    </>
  );
}

/** Where agents stand, on a section's or drawing's name: only when it isn't the usual. */
export function AccessBadge({ e }: { e: BoardElement }) {
  const t = useT();
  const elements = useBoardStore((s) => s.elements);
  const access = accessOf(e, elements);
  if (access === (isAgents(e) ? "edit" : "ask")) return null;
  return (
    <span className="tc-bd-accessbadge" title={t.board_access_title[access]}>
      <AccessIcon access={access} size={12} />
      {t.board_access_full[access]}
    </span>
  );
}

/** The gear at the foot of the rail: what your new drawings start as, and the same for the ones here. */
export function AccessSettings() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(agentsDefault);
  const [done, setDone] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <span className="tc-bd-rail-sep" />
      <button
        ref={button}
        type="button"
        className="tc-bd-tool"
        aria-label={t.board_settings}
        title={t.board_settings}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setDone(false);
          setValue(agentsDefault());
          setOpen((v) => !v);
        }}
      >
        <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 4.5h6M12 4.5h1.5M2.5 11.5H4M7.5 11.5h6M10.2 2.8a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4zM5.8 9.8a1.7 1.7 0 110 3.4 1.7 1.7 0 010-3.4z" />
        </svg>
      </button>
      {open && button.current && (
        <PickerPopover
          anchor={button.current}
          align="right"
          width={288}
          label={t.board_settings}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
        >
          <PickerHeading>{t.board_settings_new}</PickerHeading>
          {ACCESS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={value === a}
              data-pick=""
              data-first={value === a ? "" : undefined}
              className="tc-ap-row"
              onClick={() => {
                setAgentsDefault(a);
                setValue(a);
                setDone(false);
              }}
            >
              <AccessIcon access={a} size={15} />
              <span className="flex min-w-0 flex-1 flex-col text-left">
                <span>{t.board_access_full[a]}</span>
                <span className="tc-ap-detail">{t.board_access_title[a]}</span>
              </span>
              {value === a && (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
                  <path d="M3.5 8.5l3 3 6-7" />
                </svg>
              )}
            </button>
          ))}
          <div className="tc-ap-rule" />
          <button
            type="button"
            data-pick=""
            className="tc-ap-row"
            disabled={done}
            onClick={() => {
              setAccess(useBoardStore.getState().elements.filter((e) => !isAgents(e)).map((e) => e.id), value);
              setDone(true);
            }}
          >
            {done ? t.board_settings_applied : t.board_settings_apply(t.board_access_full[value])}
          </button>
        </PickerPopover>
      )}
    </>
  );
}
