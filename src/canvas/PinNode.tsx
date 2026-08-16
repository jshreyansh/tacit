import { useCallback, useEffect, useState } from "react";
import { NodeResizer, type NodeProps } from "@xyflow/react";
import { usePinStore } from "../stores/pinStore";
import { removePinFromScene, updatePinInScene } from "../actions/scenePinActions";
import type { PinFlowNode } from "./nodeProjection";
import type { Pin } from "../types";

const MIN_WIDTH = 220;
const MIN_HEIGHT = 160;

function StatusDot({ status }: { status: Pin["status"] }) {
  const color =
    status === "done"
      ? "var(--green)"
      : status === "dropped"
        ? "var(--text-faint)"
        : "var(--accent)";
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
      style={{ background: color }}
    />
  );
}

/**
 * Notes are plain markdown/DOM with no native surface to protect (unlike
 * BrowserCard's <webview>), so — per nodeProjection.ts's buildPinFlowNodes —
 * this lives directly inside React Flow's own node tree and gets its
 * drag/select/resize for free from React Flow itself; no manual
 * mousedown-drag wiring like BrowserCard needs.
 */
export function PinNode({ data }: NodeProps<PinFlowNode>) {
  const [hovered, setHovered] = useState(false);
  const pin = usePinStore((state) =>
    state.pinsByProject[data.projectPath]?.find((p) => p.id === data.pinId),
  );

  const [title, setTitle] = useState(pin?.title ?? "");
  const [body, setBody] = useState(pin?.body ?? "");

  useEffect(() => {
    if (!pin) return;
    setTitle(pin.title);
    setBody(pin.body);
  }, [pin?.id, pin?.updated]);

  const handleResizeEnd = useCallback(
    (_event: unknown, params: { width: number; height: number }) => {
      if (!pin) return;
      updatePinInScene(pin.repo, pin.id, {
        w: Math.round(params.width),
        h: Math.round(params.height),
      });
    },
    [pin],
  );

  if (!pin) return null;

  const commitTitle = () => {
    const trimmed = title.trim();
    if (trimmed && trimmed !== pin.title) {
      updatePinInScene(pin.repo, pin.id, { title: trimmed });
    } else {
      setTitle(pin.title);
    }
  };

  const commitBody = () => {
    if (body !== pin.body) {
      updatePinInScene(pin.repo, pin.id, { body });
    }
  };

  const toggleStatus = () => {
    updatePinInScene(pin.repo, pin.id, {
      status: pin.status === "open" ? "done" : "open",
    });
  };

  return (
    <div
      className="h-full w-full flex flex-col rounded-lg border overflow-hidden"
      style={{
        background: "color-mix(in srgb, var(--amber) 10%, var(--surface))",
        borderColor: "color-mix(in srgb, var(--amber) 35%, var(--border))",
        boxShadow: "var(--shadow-elev-1)",
      }}
      onMouseEnter={() => {
        setHovered(true);
        // Same reason as BrowserCard: a note wired to an agent should light
        // that wire from the note's end too.
        window.dispatchEvent(
          new CustomEvent("termcanvas:node-hover", {
            detail: { kind: "note", id: pin.id },
          }),
        );
      }}
      onMouseLeave={() => {
        setHovered(false);
        window.dispatchEvent(
          new CustomEvent("termcanvas:node-hover", { detail: null }),
        );
      }}
    >
      <NodeResizer
        isVisible={hovered}
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        handleStyle={{
          width: 8,
          height: 8,
          background: "var(--surface)",
          borderColor: "var(--border-hover)",
        }}
        onResizeEnd={handleResizeEnd}
      />

      <div
        data-scene-box-select-block
        className="flex-none flex items-center gap-1.5 px-2.5 py-1.5 border-b"
        style={{ borderColor: "color-mix(in srgb, var(--amber) 25%, var(--border))" }}
      >
        <button
          type="button"
          className="p-0.5 shrink-0"
          onClick={toggleStatus}
          title={pin.status === "open" ? "Mark done" : "Reopen"}
        >
          <StatusDot status={pin.status} />
        </button>
        <input
          data-scene-box-select-block
          className="flex-1 min-w-0 bg-transparent text-[13px] font-medium outline-none text-[var(--text-primary)]"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          onMouseDown={(e) => e.stopPropagation()}
        />
        <button
          type="button"
          className="p-0.5 shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
          onClick={() => removePinFromScene(pin.repo, pin.id)}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <textarea
        data-scene-box-select-block
        className="flex-1 min-h-0 resize-none bg-transparent px-2.5 py-2 text-[12px] leading-relaxed outline-none text-[var(--text-secondary)]"
        style={{ fontFamily: '"Geist Mono", monospace' }}
        placeholder="Write a note…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={commitBody}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  );
}
