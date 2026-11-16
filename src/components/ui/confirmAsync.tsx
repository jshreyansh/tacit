import { createRoot } from "react-dom/client";
import { ConfirmDialog, type ConfirmTone } from "./ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel: string;
  confirmTone?: ConfirmTone;
  /** Focus Cancel first, when cancelling is the safe answer. */
  focusCancel?: boolean;
}

/**
 * Tacit's own confirmation dialog, asked from code that isn't a component
 * (a menu action, an event handler): resolves true on confirm, false on
 * cancel or Esc. Use this instead of `window.confirm`, which shows the
 * system's plain box and blocks the window.
 */
export function confirmAsync(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const finish = (answer: boolean) => {
      root.unmount();
      host.remove();
      resolve(answer);
    };
    root.render(
      <ConfirmDialog
        open
        title={options.title}
        body={options.body}
        confirmLabel={options.confirmLabel}
        confirmTone={options.confirmTone}
        focusCancel={options.focusCancel}
        onCancel={() => finish(false)}
        onConfirm={() => finish(true)}
      />,
    );
  });
}
