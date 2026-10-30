import { useLayoutEffect, type RefObject } from "react";

/**
 * A text box that grows with what's written in it: from its `rows` to its
 * CSS max-height, past which it scrolls. It fits again when the text
 * changes and when the box gets wider or narrower, which rewraps the lines.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) fit(el);
  }, [ref, value]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Only a change of width: fitting changes the height, which this would otherwise hear.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fit(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}

function fit(el: HTMLTextAreaElement): void {
  // Back to its rows first, so it can shrink when text is deleted.
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
