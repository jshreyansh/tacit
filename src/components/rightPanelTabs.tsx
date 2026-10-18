import type { RightPanelTab } from "../stores/canvasStore";

/**
 * The right panel's four surfaces, and the marks that name them.
 *
 * Moved out of RightPanel for the same reason the left panel's tabs moved:
 * the rail owns switching now, and a rail should not have to import a panel
 * to draw its own buttons.
 */

export function IconFiles({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 2H4.5v12h7V4.5z" />
      <path d="M9 2v2.5h2.5" />
    </svg>
  );
}

export function IconDiff({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 3v10M12 3v10" />
      <path d="M2.5 6h3M10.5 10h3" />
    </svg>
  );
}

export function IconGit({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="4" r="1.6" />
      <circle cx="4.5" cy="12" r="1.6" />
      <circle cx="11.5" cy="8" r="1.6" />
      <path d="M4.5 5.6v4.8M6 4.6c3 0 4 1.4 4 2.9" />
    </svg>
  );
}

/** The rail's one mark for the code surfaces: files, diff and git. */
export function IconCode({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4.5L1.75 8 5 11.5M11 4.5L14.25 8 11 11.5M9.25 3l-2.5 10" />
    </svg>
  );
}

export function IconMemory({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3.2a2.4 2.4 0 0 0-4 1.7v.4a2.2 2.2 0 0 0 0 4.2v.4a2.4 2.4 0 0 0 4 1.7z" />
      <path d="M8 3.2a2.4 2.4 0 0 1 4 1.7v.4a2.2 2.2 0 0 1 0 4.2v.4a2.4 2.4 0 0 1-4 1.7z" />
    </svg>
  );
}

export const RIGHT_TAB_CONFIG: {
  id: RightPanelTab;
  icon: typeof IconFiles;
  labelKey:
    | "left_panel_files"
    | "left_panel_diff"
    | "left_panel_git"
    | "left_panel_memory";
}[] = [
  { id: "files", icon: IconFiles, labelKey: "left_panel_files" },
  { id: "diff", icon: IconDiff, labelKey: "left_panel_diff" },
  { id: "git", icon: IconGit, labelKey: "left_panel_git" },
  { id: "memory", icon: IconMemory, labelKey: "left_panel_memory" },
];

/**
 * Files, Diff and Git are one surface on the rail, switched by the tabs at
 * the top of the panel; Memory keeps its own button.
 */
export const CODE_TABS = RIGHT_TAB_CONFIG.filter((tab) => tab.id === "files" || tab.id === "diff" || tab.id === "git");

export function isCodeTab(tab: RightPanelTab): boolean {
  return CODE_TABS.some((c) => c.id === tab);
}
