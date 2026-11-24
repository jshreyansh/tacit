/** The board's icons: 16-unit glyphs drawn in the current text colour. Static markup only. */
const ST = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

export const BOARD_ICON = {
  select: '<path d="M4 2.5l8.5 5.2-3.7 1 2.2 4-1.6.8-2.2-4-3.2 2.6z" fill="currentColor"/>',
  hand: `<path d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V2.8a1 1 0 0 1 2 0V7M9.5 7.2V3.6a1 1 0 0 1 2 0V9c0 3-1.8 5-4.4 5-1.8 0-2.8-.9-3.8-2.4L1.9 9.4a1 1 0 0 1 1.6-1.1L5.5 10" ${ST} stroke-width="1.3"/>`,
  text: `<path d="M3 3.5h10M8 3.5V13M6 13h4" ${ST} stroke-width="1.6"/>`,
  section: `<rect x="2" y="4.5" width="12" height="9" rx="2" ${ST} stroke-width="1.4"/><path d="M2 2.2h5" ${ST} stroke-width="1.8"/>`,
  rect: `<rect x="2.5" y="3.5" width="11" height="9" rx="2" ${ST}/>`,
  ellipse: `<ellipse cx="8" cy="8" rx="5.8" ry="4.6" ${ST}/>`,
  diamond: `<path d="M8 2.2 13.8 8 8 13.8 2.2 8z" ${ST}/>`,
  arrow: `<path d="M3 13L13 3M7 3h6v6" ${ST} stroke-width="1.6"/>`,
  pen: `<path d="M2.5 12c2-1 2.5-4 4.5-4s1.5 3 3.5 3 2-2.5 3-4" ${ST} stroke-width="1.6"/>`,
  sticky: `<path d="M3 2.8h10v6.6L9.4 13.2H3z" ${ST} stroke-width="1.4"/><path d="M13 9.4H9.4v3.8" ${ST} stroke-width="1.4"/>`,
  file: `<path d="M4 1.8h5l3.2 3.2V13a1.2 1.2 0 0 1-1.2 1.2H4A1.2 1.2 0 0 1 2.8 13V3A1.2 1.2 0 0 1 4 1.8z" ${ST} stroke-width="1.4"/><path d="M8.8 1.9V5.2h3.3" ${ST} stroke-width="1.4"/>`,
  task: `<rect x="2.5" y="2.5" width="11" height="11" rx="2.5" ${ST} stroke-width="1.4"/><path d="M5.5 8.2l1.7 1.7 3.3-3.6" ${ST} stroke-width="1.4"/>`,
  round: `<path d="M3 13V7a4 4 0 0 1 4-4h6" ${ST} stroke-width="1.6"/>`,
  sharp: `<path d="M3 13V3h10" ${ST} stroke-width="1.6" stroke-linejoin="miter"/>`,
  straight: `<path d="M3 13L13 3" ${ST} stroke-width="1.6"/>`,
  curve: `<path d="M3 13C4 6 8 4 13 3" ${ST} stroke-width="1.6"/>`,
  elbow: `<path d="M3 13V8h10V3" ${ST} stroke-width="1.6"/>`,
  frame: `<rect x="2" y="3" width="12" height="10" rx="2" ${ST} stroke-dasharray="2.4 2"/>`,
  dup: `<rect x="5" y="5" width="8.5" height="8.5" rx="2" ${ST} stroke-width="1.4"/><path d="M11 3.5V3a.5.5 0 0 0-.5-.5H3a.5.5 0 0 0-.5.5v7.5a.5.5 0 0 0 .5.5h.5" ${ST} stroke-width="1.4"/>`,
  trash: `<path d="M2.8 4.5h10.4M6.2 4.5V3h3.6v1.5M4.2 4.5l.6 8.5h6.4l.6-8.5" ${ST} stroke-width="1.4"/>`,
  fillNone: `<rect x="3" y="3" width="10" height="10" rx="2.5" ${ST} stroke-width="1.6"/>`,
  fillSoft: `<rect x="3" y="3" width="10" height="10" rx="2.5" fill="currentColor" fill-opacity=".3" stroke="currentColor" stroke-width="1.6"/>`,
  fillSolid: `<rect x="3" y="3" width="10" height="10" rx="2.5" fill="currentColor" stroke="currentColor" stroke-width="1.6"/>`,
  solid: `<path d="M2 8h12" ${ST} stroke-width="2"/>`,
  dashed: `<path d="M2 8h12" ${ST} stroke-width="2" stroke-dasharray="2.6 2.4" stroke-linecap="butt"/>`,
  endOne: `<path d="M2 8h11M9.5 4.5 13 8l-3.5 3.5" ${ST} stroke-width="1.6"/>`,
  endBoth: `<path d="M3 8h10M9.8 4.8 13 8l-3.2 3.2M6.2 4.8 3 8l3.2 3.2" ${ST} stroke-width="1.6"/>`,
  endNone: `<path d="M2.5 8h11" ${ST} stroke-width="1.6"/>`,
  thin: `<path d="M2 8h12" ${ST} stroke-width="1"/>`,
  medium: `<path d="M2 8h12" ${ST} stroke-width="2"/>`,
  bold: `<path d="M2 8h12" ${ST} stroke-width="3.4"/>`,
  alignLeft: `<path d="M2.5 4h11M2.5 8h7M2.5 12h9" ${ST} stroke-width="1.5"/>`,
  alignCenter: `<path d="M2.5 4h11M4.5 8h7M3.5 12h9" ${ST} stroke-width="1.5"/>`,
  alignRight: `<path d="M2.5 4h11M6.5 8h7M4.5 12h9" ${ST} stroke-width="1.5"/>`,
  fit: `<path d="M1.5 5V2.5a1 1 0 0 1 1-1H5M10 1.5h2.5a1 1 0 0 1 1 1V5M13.5 10v2.5a1 1 0 0 1-1 1H10M5 13.5H2.5a1 1 0 0 1-1-1V10" ${ST} stroke-width="1.4"/>`,
} as const;

export type BoardIconName = keyof typeof BOARD_ICON;

export function BoardIcon({ name, size = 17 }: { name: BoardIconName; size?: number }) {
  // The markup is this file's own constants, never anything typed or loaded.
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" dangerouslySetInnerHTML={{ __html: BOARD_ICON[name] }} />;
}
