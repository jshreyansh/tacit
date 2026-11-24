/**
 * Files put on the canvas: chosen with the File tool, pasted, or dropped
 * from outside. Everything on the canvas that
 * shows a file is a file tile (one preview, in the canvas, the grid and the
 * panels), so these become files too: one already in the workdesk's folders
 * is shown where it is; anything else is saved by main in the workdesk's
 * folder under `.tacit/media/` (electron/workdesk-media.ts) and shown from
 * there, where agents can open it like any other file.
 */
import { getTranslations } from "../i18n/useT";
import { insideThisWorkdesk, showFilesOnCanvas } from "../files/fileTileActions";
import { useFileTileStore } from "../stores/fileTileStore";
import { useNotificationStore } from "../stores/notificationStore";
import { useProjectStore } from "../stores/projectStore";
import type { Point } from "./boardModel";
import { tileDropped } from "./boardActions";


function warn(message: string) {
  useNotificationStore.getState().notify("warn", message);
}

/** Pasted or dropped files, without folders (a dropped folder is added to the workdesk instead). */
export function mediaFiles(list: FileList | readonly File[] | null | undefined, items?: DataTransferItemList | null): File[] {
  if (!list) return [];
  const folders = new Set<string>();
  if (items) {
    for (const item of [...items]) {
      const entry = item.kind === "file" && typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
      if (entry?.isDirectory) folders.add(entry.name);
    }
  }
  return [...list].filter((f) => !folders.has(f.name));
}

/**
 * The folder you last worked in: that of the terminal or agent you last
 * clicked into or typed in. Remembered while the app runs.
 */
let lastFolder: string | null = null;
useProjectStore.subscribe((state) => {
  for (const project of state.projects) {
    for (const worktree of project.worktrees) {
      if (worktree.terminals.some((tt) => tt.focused && !tt.stashed)) {
        lastFolder = worktree.path;
        return;
      }
    }
  }
});

/**
 * Where a file from outside is kept: the folder you last worked in, if it's
 * still one of this workdesk's; otherwise the workdesk's first folder.
 */
function homeFolder(): string | null {
  const { projects } = useProjectStore.getState();
  const folders = projects.flatMap((p) => [p.path, ...p.worktrees.map((w) => w.path)]);
  if (lastFolder && folders.includes(lastFolder)) return lastFolder;
  return projects[0]?.path ?? null;
}

/** The file's path in the workdesk: where it already is, or where it was just saved. */
async function fileInWorkdesk(file: File, folder: string | null): Promise<{ path: string; saved: boolean } | null> {
  const t = getTranslations();
  const own = window.tacit.fs.getFilePath(file);
  if (own && insideThisWorkdesk(own)) return { path: own, saved: false };
  if (!folder) {
    warn(t.board_media_no_folder);
    return null;
  }
  const saved = await window.tacit.fileTiles.saveMedia(folder, new Uint8Array(await file.arrayBuffer()), file.name);
  if (saved.ok) return { path: saved.path, saved: true };
  const name = file.name || t.board_media_pasted;
  warn(saved.reason === "too_large" ? t.board_media_too_large(name) : saved.reason === "unsupported" ? t.board_media_mismatch(name) : t.file_tile_cant_show(name));
  return null;
}

/**
 * Show files as tiles, from `at` (canvas units) or in the middle of the
 * view. A tile let go inside a board section joins it.
 */
export async function placeMediaFiles(files: readonly File[], at?: Point | null): Promise<void> {
  const folder = homeFolder();
  const paths: string[] = [];
  const saved: string[] = [];
  for (const file of files) {
    const got = await fileInWorkdesk(file, folder);
    if (!got) continue;
    paths.push(got.path);
    if (got.saved) saved.push(got.path);
  }
  if (paths.length === 0) return;
  await showFilesOnCanvas(paths, at ?? undefined);
  // Say where what came from outside was saved, so it's never a mystery.
  if (saved.length > 0 && folder) {
    const t = getTranslations();
    const where = `${folder.split("/").pop() ?? folder}/.tacit/media`;
    useNotificationStore.getState().notify("info", t.board_media_saved(saved.length, where), {
      label: t.ctx_reveal(window.tacit.app.platform),
      run: () => void window.tacit.fs.reveal(saved[saved.length - 1]),
    });
  }
  const tiles = Object.values(useFileTileStore.getState().tiles);
  for (const p of paths) {
    const tile = tiles.find((tt) => tt.path === p);
    if (tile) tileDropped(tile.id, tile);
  }
}

let input: HTMLInputElement | null = null;
/** The File tool: choose any files; they land at `at`, or mid-view. */
export function pickMedia(at?: Point | null): void {
  if (!input) {
    input = Object.assign(document.createElement("input"), { type: "file", multiple: true, hidden: true });
    document.body.append(input);
  }
  const el = input;
  el.value = "";
  el.onchange = () => {
    const files = mediaFiles(el.files);
    if (files.length > 0) void placeMediaFiles(files, at);
  };
  el.click();
}
