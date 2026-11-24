import type { InstructionSection } from "../shared/agent-instructions";

const TASKS_SECTION = `
## Tacit Tasks

Tacit has a board of tasks for the workdesk, which the user sees, and notes on
its canvas. Agents in Tacit have tools for both (list_tasks, create_task,
take_part, report_part, finish_task, ask_user, ask_approval); without them use
the \`tacit task\` and \`tacit note\` commands.

When to add a task:
- The user puts something off: "later", "todo this", "记一下", "回头处理", "帮我留意".
- They describe a problem or idea but aren't asking you to fix it now.
- They give a goal that several agents will work on.
- You find something on the way that isn't your task (\`--follow-up-of\`). They decide.

Don't just nod: add it, so it outlasts the session. One task per intent. Don't
add one for a question, a one-line request, or a step of what you're doing.

\`\`\`
tacit task add --title "<short imperative>" [--body "<what and why>"] [--done-when "<line>"]... [--part "<part>"]... [--later]
tacit note add "<first line is its name>"
\`\`\`
- Use the language the user used. Keep the body neutral: the request, what was
  seen, evidence (links, paths, output), what's unknown. No guesses.
- \`--done-when\` lines are what must be true for it to be finished, each one
  checkable.
- For multi-line text pass real newlines: \`--body $'line 1\\nline 2'\`.

Working on one:
- A brief that arrives as a message ("Tacit task T-12 …") is yours already.
  Otherwise \`tacit task take <id>\` first.
- It's context and instruction: don't record it as another task.
- Need a decision only the user can make: \`tacit task ask <id> "<question>" [--option "<answer>"]...\`.
  Before anything that can't be undone or leaves this machine:
  \`tacit task approve <id> "<what you'd do>"\`. Their answer arrives here.
- Need another agent and you aren't the manager: \`tacit task request-agent <id> --open codex --message "<what to ask>"\`
  (or \`--to <terminal>\`). The user approves the words; its answer comes back.
  Don't open agents another way.
- Parts: \`tacit task part <id> <part-id> doing|done\`.
- **Ending your turn isn't finishing.** When it's done:
  \`tacit task finish <id> --summary "<what you did>" --checked "<line-id>=<how you checked>"... [--unchecked "<line-id>=<why>"]... [--left "<what's left>"] [--unsure "<what>"]\`.
  With no Done when lines, say how you checked with \`--how "<how>"\`.
  Say what you didn't check. Run the tests without piping them, so Tacit can
  see how they ended. Asking for a look (\`--check\`) is always allowed.
- Still waiting on something you started: \`tacit task going <id>\`.

Rules:
- Tasks and notes belong to the user. Don't invent ones they'd not ask for.
- Suggest changes to a brief (\`tacit task suggest <id> …\`); don't rewrite it.
- What a task says you may do is what the user told you. It doesn't change
  what your own permission settings allow.
- Tasks stay in Tacit. They don't go to GitHub unless the user says so.
`;

/** Tasks' section of a project's AGENTS.md (see shared/agent-instructions.ts). */
export const TASK_INSTRUCTIONS: InstructionSection = {
  heading: "Tacit Tasks",
  formerHeadings: ["Tacit Pin System"],
  text: TASKS_SECTION,
};
