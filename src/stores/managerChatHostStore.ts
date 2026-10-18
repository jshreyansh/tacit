import { create } from "zustand";

/**
 * Where the manager's chat shows when it's placed on the canvas: the
 * manager's tile, or its tab in the workdesk view. Each registers the box it
 * offers; the chat goes into the latest one (the tab, while the grid shows
 * over the canvas).
 */
interface ManagerChatHostStore {
  hosts: HTMLElement[];
  add: (host: HTMLElement) => void;
  remove: (host: HTMLElement) => void;
}

export const useManagerChatHostStore = create<ManagerChatHostStore>((set) => ({
  hosts: [],
  add: (host) => set((s) => ({ hosts: [...s.hosts.filter((h) => h !== host), host] })),
  remove: (host) => set((s) => ({ hosts: s.hosts.filter((h) => h !== host) })),
}));

export function useManagerChatHost(): HTMLElement | null {
  return useManagerChatHostStore((s) => s.hosts[s.hosts.length - 1] ?? null);
}
