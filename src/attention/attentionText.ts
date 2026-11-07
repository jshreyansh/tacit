import type { AttentionNotice } from "../../shared/attention";
import type { en } from "../i18n/en";

type Strings = Pick<
  typeof en,
  | "attention.waitingTitle"
  | "attention.waitingLine"
  | "attention.finishedTitle"
  | "attention.finishedLine"
  | "attention.failedTitle"
  | "attention.failedLine"
  | "attention.needsYouTitle"
  | "attention.needsYouLine"
  | "attention.anAgent"
>;

/** Where an agent is: its tile's name, folder and workdesk, as the window knows them. */
export interface AttentionPlace {
  /** The tile's name ("Claude", or the name the person gave it); null if the tile is gone. */
  name: string | null;
  folder?: string | null;
  workdesk?: string | null;
}

/** The main checkout's name is its branch ("main"), which says less than the folder's. */
export function folderName(
  worktree: { name?: string; isPrimary?: boolean },
  project: { name: string },
): string {
  return (!worktree.isPrimary && worktree.name) || project.name;
}

/**
 * A notification's words (T16): who, what happened, and where. Main masks
 * secrets and shortens both lines before showing them.
 */
export function attentionText(
  notice: AttentionNotice,
  place: AttentionPlace,
  t: Strings,
): { title: string; body: string } {
  const where = [place.folder, place.workdesk].filter((part): part is string => !!part?.trim());
  const line = (first: string) => [first, ...where].join(" · ");
  const name = place.name?.trim() || t["attention.anAgent"];
  switch (notice.kind) {
    case "waiting":
      return { title: t["attention.waitingTitle"](name), body: line(t["attention.waitingLine"]) };
    case "finished":
      return { title: t["attention.finishedTitle"](name), body: line(t["attention.finishedLine"]) };
    case "failed":
      return { title: t["attention.failedTitle"](name), body: line(notice.detail || t["attention.failedLine"]) };
    case "needs_you":
      return {
        title: notice.detail ? t["attention.needsYouTitle"](notice.detail) : t["attention.needsYouLine"],
        body: notice.question || t["attention.needsYouLine"],
      };
  }
}
