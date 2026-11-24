/**
 * The workdesk board (docs/architecture/workdesk-board.md): what people and
 * agents draw on the canvas, saved with the workdesk as `SceneDocument.board`.
 * Positions and sizes are canvas units.
 */

/** Who may change a drawing, besides you. Agents can always read it. */
export type BoardAgentAccess = "ask" | "edit" | "mine";

export type BoardAuthor =
  | { kind: "you" }
  | { kind: "agent"; agent: string; name: string; terminalId?: string };

interface BoardBase {
  id: string;
  color: string;
  author?: BoardAuthor;
  /** Who changed it last, when that wasn't its author. */
  editedBy?: BoardAuthor;
  /** The section or frame it belongs to. */
  parent?: string;
  /** Only on top-level drawings; inside a section or frame it follows that. */
  agents?: BoardAgentAccess;
}

export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Boxed = BoardBase & BoardRect;

export type BoardTextSize = "S" | "M" | "L" | "XL";
export type BoardShapeKind = "rect" | "ellipse" | "diamond";
export type BoardFill = "none" | "soft" | "solid";
export type BoardCorners = "round" | "sharp";
export type BoardRoute = "straight" | "curve" | "elbow";
export type BoardArrowEnds = "none" | "end" | "both";
export type BoardWeight = "thin" | "medium" | "bold";
/** The size of the words inside a shape or sticky. */
export type BoardLabelSize = "S" | "M" | "L" | "XL";
export type BoardAlign = "left" | "center" | "right";

export interface BoardText extends Boxed {
  type: "text";
  text: string;
  size: BoardTextSize;
}

export interface BoardShape extends Boxed {
  type: "shape";
  shape: BoardShapeKind;
  text: string;
  fill: BoardFill;
  dash: boolean;
  corners: BoardCorners;
  weight?: BoardWeight;
  /** A cell of a table an agent drew: plainer, square-cornered. */
  cell?: "head" | "body";
  /** The words inside: their size, where they sit, their colour (ink when unset). */
  label?: BoardLabelSize;
  align?: BoardAlign;
  textColor?: string;
}

export interface BoardSticky extends Boxed {
  type: "sticky";
  text: string;
  label?: BoardLabelSize;
  align?: BoardAlign;
}

export interface BoardSection extends Boxed {
  type: "section";
  title: string;
  /** The tiles it holds (their ids). Elements say which section they're in through `parent`. */
  tiles?: string[];
}

/** A drawing an agent made, in its own titled frame. */
export interface BoardFrame extends Boxed {
  type: "frame";
  title: string;
}

/** An arrow end: on an element or tile (by id), or a loose point. */
export type BoardEnd = { ref: string } | { x: number; y: number };

export interface BoardArrow extends BoardBase {
  type: "arrow";
  a: BoardEnd;
  b: BoardEnd;
  route: BoardRoute;
  ends: BoardArrowEnds;
  dash: boolean;
  weight?: BoardWeight;
  label?: string;
}

export interface BoardPoint {
  x: number;
  y: number;
  pressure?: number;
}

export interface BoardPen extends BoardBase {
  type: "pen";
  points: BoardPoint[];
  weight: BoardWeight;
}

export type BoardElement =
  | BoardText
  | BoardShape
  | BoardSticky
  | BoardSection
  | BoardFrame
  | BoardArrow
  | BoardPen;

export type BoardElementType = BoardElement["type"];
export type BoxedElement = Extract<BoardElement, BoardRect>;
