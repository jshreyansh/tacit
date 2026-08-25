import { create } from "zustand";
import { useBrowserCardStore } from "./browserCardStore";
import { useWorkspaceStore } from "./workspaceStore";
import type { BrowserIdentity } from "../types/workspace";
import {
  DEFAULT_IDENTITY_ID,
  DEFAULT_IDENTITY_NAME,
} from "../types/workspace";
import { managedBrowserBinding } from "../../shared/browser-controller";

export function partitionForIdentity(identityId: string): string {
  return `persist:identity-${identityId}`;
}

let identityIdCounter = 0;

function generateIdentityId(): string {
  return `identity-${Date.now().toString(36)}-${++identityIdCounter}`;
}

function uniqueIdentityName(
  baseName: string,
  identities: readonly BrowserIdentity[],
): string {
  const trimmed = baseName.trim() || DEFAULT_IDENTITY_NAME;
  const taken = new Set(identities.map((i) => i.name.toLowerCase()));
  if (!taken.has(trimmed.toLowerCase())) return trimmed;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${trimmed} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${trimmed} ${Date.now()}`;
}

function seedDefaultIdentity(): {
  identities: Record<string, BrowserIdentity>;
  activeIdentityId: string;
} {
  return {
    identities: {
      [DEFAULT_IDENTITY_ID]: {
        id: DEFAULT_IDENTITY_ID,
        name: DEFAULT_IDENTITY_NAME,
        createdAt: Date.now(),
      },
    },
    activeIdentityId: DEFAULT_IDENTITY_ID,
  };
}

interface IdentityState {
  identities: Record<string, BrowserIdentity>;
  activeIdentityId: string;
}

interface IdentityActions {
  /** Replace the entire registry from a persisted document. */
  hydrate: (identities: BrowserIdentity[], activeIdentityId: string) => void;
  createIdentity: (name?: string) => string;
  renameIdentity: (id: string, name: string) => void;
  /**
   * Delete an identity. No-op if it's the last remaining one. Reassigns
   * any browser card currently on this identity to the fallback (the
   * remaining identity that was active, or the first remaining one), then
   * wipes the underlying session's cookies/storage via the main process —
   * the caller is responsible for awaiting that IPC before calling this,
   * since this store has no IPC access itself; see IdentityManagerModal.
   */
  deleteIdentity: (id: string) => void;
  setActiveIdentity: (id: string) => void;
}

export type IdentityStore = IdentityState & IdentityActions;

function markDirty() {
  useWorkspaceStore.getState().markDirty();
}

export const useIdentityStore = create<IdentityStore>((set, get) => ({
  ...seedDefaultIdentity(),

  hydrate: (identities, activeIdentityId) => {
    if (identities.length === 0) {
      set(seedDefaultIdentity());
      return;
    }
    const byId: Record<string, BrowserIdentity> = {};
    for (const identity of identities) byId[identity.id] = identity;
    const activeId = byId[activeIdentityId]
      ? activeIdentityId
      : identities[0].id;
    set({ identities: byId, activeIdentityId: activeId });
  },

  createIdentity: (name) => {
    const { identities } = get();
    const list = Object.values(identities);
    const id = generateIdentityId();
    const finalName = uniqueIdentityName(
      name?.trim() || `Identity ${list.length + 1}`,
      list,
    );
    const identity: BrowserIdentity = {
      id,
      name: finalName,
      createdAt: Date.now(),
    };
    set({
      identities: { ...identities, [id]: identity },
      activeIdentityId: id,
    });
    markDirty();
    return id;
  },

  renameIdentity: (id, name) => {
    const { identities } = get();
    const target = identities[id];
    if (!target) return;
    const others = Object.values(identities).filter((i) => i.id !== id);
    const finalName = uniqueIdentityName(name, others);
    if (finalName === target.name) return;
    set({
      identities: {
        ...identities,
        [id]: { ...target, name: finalName },
      },
    });
    markDirty();
  },

  deleteIdentity: (id) => {
    const { identities, activeIdentityId } = get();
    const list = Object.values(identities);
    if (list.length <= 1) return;
    const remaining = list.filter((i) => i.id !== id);
    const fallback =
      activeIdentityId !== id && identities[activeIdentityId]
        ? identities[activeIdentityId]
        : remaining[0];

    // Any card left pointing at the deleted identity falls back so it
    // never references a partition nothing manages anymore.
    const cards = useBrowserCardStore.getState().cards;
    for (const card of Object.values(cards)) {
      if (card.identityId === id && card.backend?.kind !== "connected-tab") {
        useBrowserCardStore
          .getState()
          .updateCard(card.id, {
            identityId: fallback.id,
            backend: managedBrowserBinding(fallback.id),
          });
      }
    }

    const nextIdentities: Record<string, BrowserIdentity> = {};
    for (const identity of remaining) nextIdentities[identity.id] = identity;
    set({
      identities: nextIdentities,
      activeIdentityId:
        activeIdentityId === id ? fallback.id : activeIdentityId,
    });
    markDirty();
  },

  setActiveIdentity: (id) => {
    const { identities, activeIdentityId } = get();
    if (id === activeIdentityId || !identities[id]) return;
    set({ activeIdentityId: id });
    markDirty();
  },
}));
