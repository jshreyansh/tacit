import { removeAnnotationFromScene } from "./annotationSceneActions";
import { removeBrowserCardFromScene } from "./sceneCardActions";
import { useSelectionStore } from "../stores/selectionStore";
import { useBoardStore } from "../stores/boardStore";

export function deleteSelectedSceneItems(): boolean {
  const selectedItems = useSelectionStore.getState().selectedItems;
  let deleted = false;

  // Board drawings go in one step you can undo.
  const boardIds = selectedItems.flatMap((item) => (item.type === "annotation" ? [item.annotationId] : []));
  const board = useBoardStore.getState();
  const onBoard = boardIds.filter((id) => board.elements.some((e) => e.id === id));
  if (onBoard.length > 0) {
    board.checkpoint();
    board.remove(onBoard);
    deleted = true;
  }

  // Browsers close only when nothing but browsers is selected: a box drawn
  // round drawings easily takes one in, and a closed browser can't be undone.
  const closeBrowsers = selectedItems.every((item) => item.type === "card");

  for (const item of selectedItems) {
    if (item.type === "annotation") {
      removeAnnotationFromScene(item.annotationId);
      deleted = true;
      continue;
    }

    if (item.type === "card" && closeBrowsers) {
      if (item.cardId.startsWith("browser:")) {
        removeBrowserCardFromScene(item.cardId.slice("browser:".length));
        deleted = true;
      } else {
        continue;
      }
    }
  }

  // Browsers left open are let go of too, or a second ⌫ would find them alone and close them.
  if (deleted) {
    useSelectionStore.setState((state) => ({
      selectedItems: state.selectedItems.filter(
        (item) => item.type !== "annotation" && item.type !== "card",
      ),
    }));
  }

  return deleted;
}
