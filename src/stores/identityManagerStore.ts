import { create } from "zustand";
import { useIdentityStore } from "./identityStore";
import type {
  BrowserPartitionEraseResult,
  OrphanPartitionSummary,
} from "../../shared/browser-partition-registry";

interface IdentityManagerStore {
  open: boolean;
  /**
   * When set, the modal opens directly into rename mode for that identity
   * id. Cleared on close.
   */
  renameTargetId: string | null;
  /**
   * Browser data on disk that no profile in this workspace claims. Main finds
   * these; nothing here acts on one on its own — they hold real sign-ins, so
   * the user decides between restoring and erasing.
   */
  orphans: OrphanPartitionSummary[];
  openManager: () => void;
  openRename: (identityId: string) => void;
  close: () => void;
  refreshOrphans: () => Promise<void>;
  eraseOrphan: (identityId: string) => Promise<BrowserPartitionEraseResult>;
}

export const useIdentityManagerStore = create<IdentityManagerStore>(
  (set, get) => ({
    open: false,
    renameTargetId: null,
    orphans: [],
    openManager: () => set({ open: true, renameTargetId: null }),
    openRename: (identityId) =>
      set({ open: true, renameTargetId: identityId }),
    close: () => set({ open: false, renameTargetId: null }),

    refreshOrphans: async () => {
      const api = window.tacit?.browserIdentity;
      if (!api?.listOrphanPartitions) return;
      const identityIds = Object.keys(useIdentityStore.getState().identities);
      try {
        set({ orphans: await api.listOrphanPartitions(identityIds) });
      } catch {
        // A diff that cannot be read is not a reason to break the manager. The
        // partitions stay on disk and the next refresh finds them again.
        set({ orphans: [] });
      }
    },

    eraseOrphan: async (identityId) => {
      // The current profile list travels with the request: main refuses to
      // erase a partition that still belongs to a profile, and this is what
      // lets it check rather than take the id on faith.
      const result = await window.tacit.browserIdentity.eraseOrphanPartition({
        identityId,
        identityIds: Object.keys(useIdentityStore.getState().identities),
      });
      set({
        orphans: get().orphans.filter((entry) => entry.identityId !== identityId),
      });
      return result;
    },
  }),
);
