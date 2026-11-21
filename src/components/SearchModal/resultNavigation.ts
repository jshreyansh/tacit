import { openFolderPlace } from "../../actions/folderTools";
import type { SearchResult } from "../../stores/searchStore";
import { useSearchStore } from "../../stores/searchStore";
import { useCanvasStore } from "../../stores/canvasStore";
import { panToTerminal } from "../../utils/panToTerminal";
import { openFileInView, openPastSession } from "../../actions/openSession";

export function executeResult(result: SearchResult): void {
  const { data } = result;

  switch (data.type) {
    case "action":
      data.perform();
      break;

    case "file":
      // Files open in the FileEditorDrawer (full-canvas Monaco) — the
      // old "preview" right-panel tab is gone.
      openFileInView(data.filePath);
      break;

    case "terminal":
      panToTerminal(data.terminalId);
      break;

    case "git-commit":
      openFolderPlace("git");
      // The history mounts first; then it can pick the commit.
      setTimeout(() => window.dispatchEvent(new CustomEvent("tacit:select-git-commit", { detail: data.hash })), 120);
      break;

    case "git-branch":
      openFolderPlace("git");
      break;

    case "session":
      // Sessions live in the full-screen overlay now (no longer a
      // right-panel tab). Open the overlay and let it pick up the
      // loaded replay.
      openPastSession(data.filePath);
      break;

    case "memory":
      openFolderPlace("memory");
      break;
  }

  useSearchStore.getState().closeSearch();
}
