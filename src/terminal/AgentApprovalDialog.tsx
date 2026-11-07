import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { useT } from "../i18n/useT";
import { answerAgentApproval, useAgentApprovalStore } from "../stores/agentApprovalStore";
import { usePreferencesStore } from "../stores/preferencesStore";
import type { AgentApprovalChoice } from "./agentApprovals";

/**
 * Asks once per project whether agents started for the person (Hydra
 * workers, the manager's) may run without approvals (T15.1). Their
 * launches wait until it's answered; the answer is kept for the project.
 */
export function AgentApprovalDialog() {
  const t = useT();
  const first = useAgentApprovalStore((s) => s.pending[0]);
  if (!first) return null;

  // Dismissing counts as Ask each time: the safe answer.
  const answer = (choice: AgentApprovalChoice) => {
    usePreferencesStore.getState().setAgentApproval(first.projectPath, choice);
    answerAgentApproval(first.projectPath, choice);
  };

  return (
    <ConfirmDialog
      open
      title={t["agentApproval.title"](first.projectName)}
      body={
        <div className="space-y-2 text-xs">
          <p>{t["agentApproval.intro"]}</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>{t["agentApproval.claude"]}</li>
            <li>{t["agentApproval.codex"]}</li>
          </ul>
          <p className="text-[var(--text-secondary)]">{t["agentApproval.waiting"](first.waiting)}</p>
          <p className="text-[var(--text-secondary)]">{t["agentApproval.kept"]}</p>
        </div>
      }
      confirmLabel={t["agentApproval.allow"]}
      confirmTone="danger"
      cancelLabel={t["agentApproval.ask"]}
      focusCancel
      onConfirm={() => answer("bypass")}
      onCancel={() => answer("ask")}
    />
  );
}
