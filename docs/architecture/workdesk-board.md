# The workdesk board

Agreed 23 Nov 2026, after the interactive prototype
(https://claude.ai/artifact/BFWLE38aKp7HVxg5wZcWhP). Linear: T21 in M1.

The workdesk canvas becomes a board that people and agents both draw on. You
sketch with proper tools; agents draw diagrams, tables and flowcharts next to
their work; and each drawing says who may change it, with the same approvals
Tacit already uses for agents.

The voice review from the prototype is parked. It is not part of this.

## What it replaces

Tacit already has simple drawing:

- `src/toolbar/DrawingPanel.tsx`: a floating panel with select, pen, text,
  box and arrow, in 6 colours.
- `src/stores/drawingStore.ts`: the live elements.
- `src/canvas/DrawingLayer.tsx`: draws them, with `perfect-freehand` for pen
  strokes.
- `src/canvas/annotationGeometry.ts`: works out where each one is.
- `SceneDocument.annotations` (`src/types/scene.ts`): saves them with the
  workdesk.

Each annotation has an anchor: a point in the world, or a tile it sticks to
with an offset. The board keeps that idea and replaces the panel, the store's
element kinds and the layer.

Already right, and kept:

- Dragging on empty canvas draws a selection box. Hand (H) or Space pans
  (`XyFlowCanvas.tsx`, `isPanMode`).
- Selection is shared with tiles (`selectionStore`, `type: "annotation"`).
- Drawings are part of the scene document. History, canvas switching and
  restore already carry them (`canvasSceneIO.ts`, `snapshotBridge.ts`).

## How it feels

These follow the prototype, and tldraw and Excalidraw where it is silent.

- **Tool rail on the right**, floating, vertical. In order:
  - Select (V, 1)
  - Hand (H, 2)
  - Text (T, 3)
  - Sticky note (N, 4)
  - Section (S, 5)
  - Shape (R, 6; O ellipse, D diamond)
  - Arrow (A, 7)
  - Pen (P, 8)
  - File (F, 9): opens the file picker at once; what you choose lands
    mid-view as file tiles. It isn't a tool you hold.

  There's no lock button: tools go back to Select after one use, as in
  tldraw and FigJam. Q still keeps the tool for the next drawing, shown as a
  dot on the tool. Tool names show on hover after a short wait, never over
  the options panel, and go away when clicked. The board settings (gear) arrive with the
  permissions in step 3, when there's something to set. Zoom and Fit sit at
  the bottom right; Focus and Canvas/Grid stay in the left bar.
- **Options panel** unfolds beside the rail:
  - while a tool is active, it shows that tool's style;
  - while something is selected, it shows what is selected;
  - clicking the tool in hand again puts it away (Select), closing it.

  It's compact, as in tldraw: the name and key on one line, then only
  controls, each named on hover; colours in one row; two small controls share
  a row (outline and corners, size and align); a selection's actions are
  small buttons at the foot. It never runs under the zoom pill; past that
  height it scrolls.
- **One use, then Select.** After drawing, you are back on Select with the new
  thing selected. Pen and Hand stay on. Q keeps any tool on. Escape always
  goes back to Select.
- **Text and sticky** are placed when the mouse button comes up, so the
  caret stays in the new text.
- **Quick connect:**
  - Hover a shape or sticky to show four arrows. Click one for a linked copy
    in that direction, ready to type. Drag one out to connect, or to make a
    new shape where you drop it.
  - ⌘ + arrow key does the same, including while you type a label.
- **Arrows:**
  - each end attaches to a shape, sticky or tile (file tiles included);
  - routes are straight, curved or elbow;
  - each end can be dragged to re-attach it;
  - Shift snaps the angle.

  An arrow drawn within one shape stays loose.
- **Sections:**
  - a titled area; dragging its title moves everything inside;
  - drawn behind tiles.
- **Stickies:**
  - drawn above tiles;
  - "Make it a task" turns a sticky into a real Task (pin) in the same place,
    with the same id, so arrows stay attached.
- **Selecting several**, drawings and tiles (terminals, tasks, notes, files,
  browsers) alike (`canvasSelection.ts`, `useBoxSelect.ts`):
  - In Select, a drag on empty canvas draws a box. What it touches is selected
    as it goes; a section or frame only when the box goes right round it, so a
    drag inside one picks its contents.
  - ⌘ or Shift with a click adds one thing, or takes it out. With a drag it
    draws a box that adds, starting anywhere: on a drawing, on a tile's
    header, in Hand (which then goes to Select, so it can be moved). Inside a
    terminal, a note's text or a page, ⌘ and Shift stay theirs.
  - Dragging any one of them moves them all (`groupMove.ts`). A section brings
    what it holds; arrows attached to what moved follow. One ⌘Z puts drawings
    and tiles back.
  - Each tile shows a ring, and a dashed line goes round them all. A click on
    one leaves just it; Escape or a click on empty canvas lets go of all.
  - ⌫ deletes the drawings. Tiles stay: a browser closes only when nothing
    but browsers is selected, since closing one can't be undone.
- **Snapping:** moving snaps to neighbours' edges and centres, with
  `alignRect` from `tileMove.ts`. ⌘, pressed while moving, turns it off.
- **Small things:**
  - Option-drag duplicates (⌘D stays the app's: close the focused tile);
  - ⌘C and ⌘V copy and paste drawings;
  - double-clicking empty board writes text;
  - Shift draws squares and circles;
  - the hover outline shows what you would pick;
  - Enter edits the selected label.
- **Motion:**
  - Tacit's easing: enter `cubic-bezier(.05,.7,.1,1)` 240 ms, exit
    `cubic-bezier(.3,0,.8,.15)` 150 ms;
  - an afterglow on things that are just drawn or flown to;
  - agent drawings arrive one piece at a time;
  - with Reduce Motion, fades only.

## Data model

One element list per workdesk, saved as the optional `SceneDocument.board`
(`src/types/board.ts`). The scene version stays 2: an older build ignores
`board`, and the part of the board it can show (pen strokes, text, boxes,
arrows with loose ends) is also written to `annotations`, so nothing
disappears if you open the workdesk in an older Tacit. Positions are canvas
units.

```ts
type BoardElement =
  | { type: "text";    ...Box; text: string; size: "S" | "M" | "L" | "XL" }
  | { type: "shape";   ...Box; shape: "rect" | "ellipse" | "diamond"; text: string;
      fill: "none" | "soft" | "solid"; dash: boolean; corners: "round" | "sharp" }
  | { type: "sticky";  ...Box; text: string }
  | { type: "section"; ...Box; title: string }
  | { type: "frame";   ...Box; title: string }            // an agent's drawing
  | { type: "arrow";   a: End; b: End; route: "straight" | "curve" | "elbow";
      ends: "none" | "end" | "both"; dash: boolean; label?: string }
  | { type: "pen";     points: StrokePoint[]; weight: "thin" | "medium" | "bold" };

interface Common {
  id: string;
  color: string;
  author: Author;                 // who made it
  editedBy?: Author;              // who changed it last
  parent?: string;                // the section or frame it belongs to
  agents?: AgentAccess;           // only on top-level drawings; see Permissions
}
type Author = { kind: "you" } | { kind: "agent"; agent: string; terminalId: string; name: string };
type End = { ref: string } | { x: number; y: number };   // ref: element or tile id
type AgentAccess = "ask" | "edit" | "mine";
```

The `...Box` fields are `x`, `y`, `w` and `h`.

- **Frames** are what an agent draws into: a titled box with "drawn by Codex"
  and the agent's colour. A person's equivalent is a section.
- **Files (pictures, videos, PDFs, anything) are file tiles, not board elements.**
  There's one way a file shows on the canvas, so one preview everywhere: the
  canvas, the grid and the panels.
  - The File tool, ⌘V and dropping a file all end in a file tile, for any
    kind of file. A file
    already in one of the workdesk's folders is shown where it is.
  - One from outside (a screenshot, a download) is saved first, as a real
    file, in the workdesk's first folder under `.tacit/media/`
    (`electron/workdesk-media.ts`). That folder carries its own `.gitignore`
    (`*`), so it stays out of git without touching the project's. Agents can
    open these files like any other.
  - The type comes from the content, not the name: PNG, JPEG, GIF, WebP,
    AVIF, SVG; MP4, MOV, WebM; MP3, M4A, WAV, Ogg, FLAC; PDF.
  - Any other file keeps its own extension, unless the name claims media the
    content isn't (a script named photo.svg is refused).
  - Pictures up to 20 MB; everything else up to 200 MB.
  - A pasted screenshot is named by when it came ("Pasted 2026-11-23 at
    14.05.09.png"). The same bytes under the same name are one file; a
    different file with that name gets " 2".
  - Arrows attach to file tiles, and sections hold them, as with any tile.
- **Migration** from today's annotations, when a version-2 scene loads:

  | Today | Becomes |
  |---|---|
  | `pen` | pen |
  | `text` | text, with the font size mapped to S, M, L or XL |
  | `rect` | shape `rect`, `fill: none` |
  | `arrow` | arrow with loose ends |

  Old drawings never stuck to tiles in practice (nothing created a tile
  anchor), so each is placed where it was drawn, and the author is you.

## Agents draw

Agents never draw freehand. They send content, and the board lays it out.

**Bridge tools** (`tacit-bridge/src/mcp-server.ts`), any agent in the workdesk:

| Tool | Does |
|---|---|
| `board_draw({ title, flowchart? , table?, boxes?, arrows?, near?, notes? })` | Makes a frame and returns its id and link. The layout options are below. |
| `board_update({ id, ...same })` | Redraws an agent's frame, or changes one of yours (Permissions). |
| `board_read({ id? })` | Returns the board, or one drawing, as structured content: text, shapes, arrows, stickies, and the file tiles they point to. You can always read; see Permissions. |
| `board_delete({ id })` | Deletes its own drawing. Yours always asks. |

`board_draw` takes one of these layouts:

- `flowchart`: Mermaid-style text, for example `A --> B`, `A -- label --> B`
  and `A{Decision}`.
- `table`: rows of cells.
- `boxes` + `arrows`: explicit items.

It places the frame near the agent's own tile unless `near` names a tile or a
drawing. A frame never covers tiles or other drawings.

**CLI**, the same four as `tacit board draw|update|show|delete`, with JSON or
flags. The instructions that explain `tacit task` to agents
(`electron/pin-instructions.ts`) gain a short section on the board.

**Path.** A bridge tool or CLI call goes to the API server as
`POST /terminal/:id/board/...`. The server checks the terminal belongs to the
workdesk, as `requireWorkspaceManager` does but for any agent in the workdesk,
and validates the content:

- at most 200 items;
- text up to 2,000 characters per item;
- no HTML.

Then `execRenderer` runs `window.__tcApi.board*`, as `spawnNote` does today.
The renderer owns layout and the scene.

**In the chat:**

- The manager's reply carries a card with a thumbnail, the title, "Board ·
  drawn by Claude" and **Show ›**. Show flies to the frame with the afterglow.
- A drawing by a worker shows a notice ("Codex drew 'Rate limit tables'",
  with Show) and a line in its chat or terminal transcript.
- The canvas never jumps on its own. You get a link, not a jump.

## Permissions

Every top-level drawing has an **Agents** setting:

| Setting | Agents can |
|---|---|
| **Ask first** | Read it. To change it they ask, and wait for you. |
| **Can edit** | Read and change it, like you. Each change shows who made it. |
| **Only me** | Read it. They can't change it, and don't ask. |

**Agents can always read every drawing**, including Only me. Reading is the
minimum and can't be turned off; it's how an agent understands what you mean.

- **Defaults:**
  - what you draw starts as **Ask first**;
  - what an agent draws starts as **Can edit**, shared with you.

  The board settings (gear) set the default for new drawings, with **Apply to
  all** for existing ones.
- **Inherited:** things inside a section or frame follow it, unless given their
  own setting.
- **Shown:**
  - on the frame or section badge, which opens a picker;
  - in the options panel for anything selected;
  - by the border: dashed means agents can edit, solid means ask or mine.
- **Asking:**
  - `board_update` on an Ask first drawing returns `pending` at once, with a
    request id.
  - The request appears as an approval card in the agent's chat, using Tacit's
    existing approval words (`chat_approval_*`):
    - "Claude wants to change 'Sprint plan'", with a before/after preview;
    - **Allow once** / **Always allow** / **Deny**, with an optional note on
      Deny.
  - The request also appears in **Needs you**.
  - The answer reaches the agent's terminal, as `tacit task ask` answers do.
    It is also available to `board_read({ request })`.
  - **Always allow** switches that drawing to Can edit.
- **Deleting:**
  - an agent can delete its own drawings;
  - deleting anything of yours always asks, even under Can edit.
- **Undo:**
  - ⌘Z undoes only your own changes;
  - each agent change gets **Undo** on its card or notice, even under Can edit.
- **While you're editing:** an agent's change to something you're typing in,
  or have selected, waits until you finish, then applies. Nothing you type is
  lost.
- **Two agents, one drawing:** the later change wins for each item, and both
  show in its history ("edited by Codex").
- **One request per change.** "Tidy 6 shapes" is one request, not six.
  Requests for the same drawing in a row are merged while one is waiting.
- **The agent is gone:** a closed agent's frame stays, still "drawn by Codex",
  with its setting unchanged. A pending request from a closed agent is dropped.
- **Other workdesks:** an agent only reads or changes the board of its own
  workdesk. Copying a drawing to another workdesk gives it that workdesk's
  default.
- **Stickies made into tasks** follow tasks' own rules from then on.

All enforcement is in the main process, before `execRenderer`. The renderer
never decides whether an agent may change something.

## Platform boundary

- Files from outside reach the main process through one narrow IPC,
  `window.tacit.fileTiles.saveMedia(folder, bytes, name)`. It:
  - accepts calls only from the main window;
  - takes `folder` only when it is exactly one of the workdesk's folders, as
    saved (not the renderer's word);
  - checks the type by content, and the size;
  - writes into `<folder>/.tacit/media/`, with a cleaned name;
  - returns the file's path, which is then shown as an ordinary file tile
    (checked and served by `file-tile:inspect` as before).

  The renderer passes bytes, never a path to read.
- The board's state stays in renderer stores, as drawings do today. Agent
  calls reach it only through `__tcApi` after the main process's checks.

## Steps

Each step is a local release (`release:mac --local`) to try in the installed
app.

1. **Your tools** (T21.1):
   - the element model and migration;
   - the rail, options panel and every tool above;
   - quick connect, arrows that attach, sections, stickies → tasks, pasted
     and dropped files as file tiles;
   - snapping, undo and keyboard;
   - it replaces `DrawingPanel`.
2. **Agents draw** (T21.2):
   - frames and layout (flowchart, table, boxes);
   - the bridge tools, CLI and API endpoints;
   - chat cards, notices and Show;
   - instructions for agents.
3. **Permissions** (T21.3):
   - the Agents setting, defaults and inheritance;
   - approval cards and Needs you;
   - per-agent Undo, the wait-while-editing rule and delete rules.

## Not in this

- Voice review, and agents presenting diffs, sheets or PDFs in an overlay
  (parked).
- Live multi-person collaboration across machines.
- Export to PNG or SVG, and import from Excalidraw or tldraw files (later, if
  asked for).
