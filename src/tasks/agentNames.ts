import { findAgentAdapter } from "../../shared/agent-adapters";

interface Named {
  id: string;
  type: string;
  title: string;
  customTitle?: string;
}

/**
 * What each agent on a workdesk is called: the name you gave it, else what it
 * is ("Claude Code"), numbered when there's more than one, so two can be told
 * apart wherever one is picked.
 */
export function agentNames(terminals: readonly Named[]): Map<string, string> {
  const base = (t: Named) => t.customTitle?.trim() || findAgentAdapter(t.type)?.displayName || t.title;
  const count = new Map<string, number>();
  for (const t of terminals) count.set(base(t), (count.get(base(t)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const taken = new Set(terminals.map(base).filter((name) => count.get(name) === 1));
  return new Map(
    terminals.map((t) => {
      const name = base(t);
      if (count.get(name) === 1) return [t.id, name];
      let n = (seen.get(name) ?? 0) + 1;
      // "Claude Code 2" may be a name you gave another.
      while (n > 1 && taken.has(`${name} ${n}`)) n += 1;
      seen.set(name, n);
      return [t.id, n === 1 ? name : `${name} ${n}`];
    }),
  );
}

/** Every agent on one workdesk, in the order they were added. */
export function agentsIn(projects: ReadonlyArray<{ worktrees: ReadonlyArray<{ terminals: ReadonlyArray<Named & { stashed?: boolean }> }> }>): Named[] {
  return projects.flatMap((p) => p.worktrees.flatMap((w) => w.terminals.filter((t) => !t.stashed && findAgentAdapter(t.type))));
}
