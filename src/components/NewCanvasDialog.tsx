import { useEffect, useRef, useState } from "react";

import { nextCanvasName } from "../canvas/canvasNames";
import { useT } from "../i18n/useT";
import { useCanvasManagerStore } from "../stores/canvasManagerStore";
import { useCanvasRegistryStore } from "../stores/canvasRegistryStore";
import { ConfirmDialog } from "./ui/ConfirmDialog";

/**
 * Asks for a name before making a canvas, with the next "Canvas N" filled in
 * and selected: type over it, or press Enter to keep it. Esc makes nothing.
 */
export function NewCanvasDialog() {
  const t = useT();
  const open = useCanvasManagerStore((s) => s.newCanvasOpen);
  const close = useCanvasManagerStore((s) => s.closeNewCanvas);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(nextCanvasName(useCanvasRegistryStore.getState().canvases.map((c) => c.name)));
    // Selected once the name is in, so typing replaces it.
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const create = () => {
    if (!useCanvasManagerStore.getState().newCanvasOpen) return;
    close();
    useCanvasRegistryStore.getState().createCanvas(name);
  };

  return (
    <ConfirmDialog
      open={open}
      title={t["canvas.new.title"]}
      confirmLabel={t["canvas.new.create"]}
      onCancel={close}
      onConfirm={create}
      body={
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] text-[var(--text-muted)]">{t["canvas.new.nameLabel"]}</span>
          <input
            ref={inputRef}
            autoFocus
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        </label>
      }
    />
  );
}
