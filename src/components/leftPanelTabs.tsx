import type { LeftPanelTab } from "../stores/canvasStore";

/**
 * The left panel's two surfaces, and the marks that name them.
 *
 * These lived inside LeftPanel while the panel drew its own tab strip. The
 * rail now has a button per surface and the strip is gone, so the definitions
 * moved here rather than being exported from a component the rail would
 * otherwise have to import a panel from.
 */

export function IconSessions({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 3.5h10v9H3z" />
      <path d="M5 6h6M5 8.5h4" />
    </svg>
  );
}

export function IconHistory({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 3a5 5 0 1 1-4.2 2.3" />
      <path d="M3.2 3.5v2.2h2.2" />
      <path d="M8 5.5V8l1.8 1.2" />
    </svg>
  );
}

export const LEFT_TAB_CONFIG: {
  id: LeftPanelTab;
  icon: typeof IconSessions;
  labelKey: "left_panel_sessions" | "left_panel_history";
}[] = [
  { id: "sessions", icon: IconSessions, labelKey: "left_panel_sessions" },
  { id: "history", icon: IconHistory, labelKey: "left_panel_history" },
];
