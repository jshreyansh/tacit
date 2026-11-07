import { useEffect, useState } from "react";
import type { TurnListResult } from "../../shared/turns";

/** A terminal's turns (T10), kept current as turns start, end and get undone. */
export function useTurnList(terminalId: string, enabled: boolean): TurnListResult | null {
  const [list, setList] = useState<TurnListResult | null>(null);

  useEffect(() => {
    if (!enabled) {
      setList(null);
      return;
    }
    let live = true;
    const load = () => {
      void window.tacit.turns.list(terminalId).then((result) => {
        if (live) setList(result);
      });
    };
    load();
    const off = window.tacit.turns.onChanged(({ terminalId: changed }) => {
      if (changed === terminalId) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [terminalId, enabled]);

  return list;
}
