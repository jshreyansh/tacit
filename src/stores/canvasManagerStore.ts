import { create } from "zustand";

interface CanvasManagerStore {
  open: boolean;
  /**
   * When set, the modal opens directly into rename mode for that canvas
   * id. Cleared on close.
   */
  renameTargetId: string | null;
  /** The "New canvas" box, which asks for a name before making one. */
  newCanvasOpen: boolean;
  openManager: () => void;
  openRename: (canvasId: string) => void;
  close: () => void;
  openNewCanvas: () => void;
  closeNewCanvas: () => void;
}

export const useCanvasManagerStore = create<CanvasManagerStore>((set) => ({
  open: false,
  renameTargetId: null,
  newCanvasOpen: false,
  openManager: () => set({ open: true, renameTargetId: null }),
  openRename: (canvasId) => set({ open: true, renameTargetId: canvasId }),
  close: () => set({ open: false, renameTargetId: null }),
  openNewCanvas: () => set({ newCanvasOpen: true }),
  closeNewCanvas: () => set({ newCanvasOpen: false }),
}));
