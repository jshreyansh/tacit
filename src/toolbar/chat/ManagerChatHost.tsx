import { useEffect, useState } from "react";
import { useManagerChatHostStore } from "../../stores/managerChatHostStore";

/**
 * A box the manager's chat fills when it's placed on the canvas. The chat
 * itself stays one component (the docked chat's), shown here through a
 * portal, so there is never a second conversation or message box.
 */
export function ManagerChatHost() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!host) return;
    const store = useManagerChatHostStore.getState();
    store.add(host);
    return () => useManagerChatHostStore.getState().remove(host);
  }, [host]);
  // nopan / nodrag / nowheel: typing, selecting and scrolling stay in the chat, not the canvas.
  return <div ref={setHost} className="nopan nodrag nowheel relative flex min-h-0 flex-1 flex-col" />;
}
