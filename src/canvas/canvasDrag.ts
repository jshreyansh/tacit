/**
 * While something on the canvas is being dragged (a tile, a drawing, a box
 * being drawn, a section's edge), a browser's page doesn't take the pointer:
 * a drag crossing one lost its moves, and its release, to the page.
 */
let running = 0;

/** A drag began; call what it returns when it ends. It ends itself if the window loses the mouse. */
export function beginCanvasDrag(): () => void {
  let over = false;
  running += 1;
  document.body.classList.add("tc-canvas-dragging");
  const end = () => {
    if (over) return;
    over = true;
    running -= 1;
    window.removeEventListener("blur", end);
    if (running === 0) document.body.classList.remove("tc-canvas-dragging");
  };
  window.addEventListener("blur", end);
  return end;
}
