import { useEffect, useRef } from "react";
import { cursorDone, useAgentOps } from "./agentOps";

/** An agent's cursor, going to each thing as it's drawn. Inside the board's layer, so in canvas units. */
export function AgentCursors() {
  const cursors = useAgentOps((s) => s.cursors);
  return (
    <>
      {cursors.map((c) => (
        <Cursor key={c.key} cursor={c} />
      ))}
    </>
  );
}

function Cursor({ cursor }: { cursor: ReturnType<typeof useAgentOps.getState>["cursors"][number] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const at = (s: { x: number; y: number }) => `translate(${s.x}px, ${s.y}px)`;
    const first = cursor.stops[0];
    const last = cursor.stops[cursor.stops.length - 1];
    if (!first || !last) return cursorDone(cursor.key);
    const run = node.animate(
      [
        { transform: at({ x: first.x - 40, y: first.y + 60 }), opacity: 0, offset: 0 },
        ...cursor.stops.map((s) => ({ transform: at(s), opacity: 1, offset: Math.min(0.97, (s.at + 60) / cursor.total), easing: "cubic-bezier(0.4, 0, 0.2, 1)" })),
        { transform: at(last), opacity: 1, offset: 0.985 },
        { transform: at({ x: last.x + 24, y: last.y + 36 }), opacity: 0, offset: 1 },
      ],
      { duration: cursor.total, fill: "both" },
    );
    run.onfinish = () => cursorDone(cursor.key);
    return () => run.cancel();
  }, [cursor]);
  return (
    <div ref={ref} className="tc-bd-cursor" aria-hidden="true" style={{ "--c": cursor.color } as React.CSSProperties}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <path d="M2.5 1.8l12.6 5.6-5.4 1.9-2.4 5.3z" />
      </svg>
      <span>{cursor.name}</span>
    </div>
  );
}
