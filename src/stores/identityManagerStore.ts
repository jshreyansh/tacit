import { create } from "zustand";

interface IdentityManagerStore {
  open: boolean;
  /**
   * When set, the modal opens directly into rename mode for that identity
   * id. Cleared on close.
   */
  renameTargetId: string | null;
  openManager: () => void;
  openRename: (identityId: string) => void;
  close: () => void;
}

export const useIdentityManagerStore = create<IdentityManagerStore>(
  (set) => ({
    open: false,
    renameTargetId: null,
    openManager: () => set({ open: true, renameTargetId: null }),
    openRename: (identityId) =>
      set({ open: true, renameTargetId: identityId }),
    close: () => set({ open: false, renameTargetId: null }),
  }),
);
