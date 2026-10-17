import tacitMark from "../assets/tacit-mark.png";
import { agentIcon } from "./agentIcons";

/**
 * The workdesk manager's mark: Tacit's tile with the agent holding the seat
 * as a round badge on its corner, cut out by a ring in the surface colour.
 * One lockup for the pill, the docked header and anywhere else the manager
 * is named, so the seat always reads as "Tacit, run by this agent". An empty
 * seat shows a dashed badge where the agent will go.
 *
 * The Tacit tile is drawn as a mask filled with the text colour, as the
 * left bar's Hub icon is, so it follows the theme.
 */
export function ManagerMark({
  agent,
  size = 28,
  ring = "var(--surface)",
  working = false,
}: {
  agent: string | null;
  size?: number;
  ring?: string;
  working?: boolean;
}) {
  const badge = Math.round(size * 0.6);
  const icon = agentIcon(agent);
  return (
    <span className="relative inline-block shrink-0" style={{ width: size + badge * 0.22, height: size + badge * 0.15 }} aria-hidden="true">
      <span
        className="absolute left-0 top-0 flex items-center justify-center"
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.3,
          cornerShape: "squircle",
          background: "color-mix(in srgb, var(--text-primary) 9%, transparent)",
          border: "1px solid color-mix(in srgb, var(--text-primary) 10%, transparent)",
        } as React.CSSProperties}
      >
        <span
          className="inline-block"
          style={{
            width: size * 0.56,
            height: size * 0.56,
            backgroundColor: "var(--text-secondary)",
            maskImage: `url(${tacitMark})`,
            WebkitMaskImage: `url(${tacitMark})`,
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        />
      </span>
      <span
        className={`absolute bottom-0 right-0 flex items-center justify-center overflow-hidden rounded-full${working ? " tc-live-pip" : ""}`}
        style={{
          width: badge,
          height: badge,
          background: icon ? "#1f1f22" : ring,
          boxShadow: `0 0 0 2px ${ring}`,
          border: icon ? undefined : "1px dashed var(--text-muted)",
        }}
      >
        {icon && <img src={icon} alt="" style={{ width: badge * 0.76, height: badge * 0.76 }} className="object-contain" draggable={false} />}
      </span>
    </span>
  );
}
