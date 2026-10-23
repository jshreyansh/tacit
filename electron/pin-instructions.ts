import type { InstructionSection } from "../shared/agent-instructions";

const PIN_SECTION = `
## Tacit Pin System

Tacit has a first-class pin store. Pins are persistent records of work
the user wants done — captured when the user expresses intent, not when the
work happens. Use the \`tacit pin\` CLI to read and write them. Any agent
terminal can record, read, and update pins.

The user sees pins as **Tasks** (and **Notes**). A task has a status
(todo, doing, needs-you, done, dropped), steps, and who's on it;
\`tacit task\` is the same CLI as \`tacit pin\`. When you work on a task,
keep its steps current: \`tacit task step <id> <n> --status doing|done\`,
\`tacit task step <id> --add "<step>"\`. When you need a decision only the
user can make, \`tacit task ask <id> "<question>" [--choices a,b]\`: it
shows as Needs you, and their answer arrives in this terminal.

When to record a pin:
- User says "记一下", "回头处理", "帮我留意", "later", "todo this", or any phrasing that defers the work.
- User describes a problem or idea but isn't asking you to fix it right now.
- User pastes a GitHub issue URL and asks you to track it (record the URL via \`--link\`).

Do NOT silently nod — capture the pin with \`tacit pin add\` so it survives the session.

When existing pin content is pasted or dropped into the conversation:
- Treat it as context from an existing Tacit pin, not as a request to create another pin.
- Use the user's surrounding instruction to decide whether to execute, investigate, or discuss it.
- If the intent is unclear, ask what to do next instead of assuming the pin should be solved immediately.

Recording a pin:
\`\`\`
tacit pin add --title "<short imperative>" --body "<detail>" [--link <url>]
\`\`\`
- \`--title\`: short, scannable. Rephrase the user's words into imperative mood. Use the same language the user used (e.g. Chinese input → Chinese title, English input → English title).
- \`--body\`: preserve enough context for a future agent or the user to resume without re-asking basic questions. Use the same language the user used.
- Keep the body neutral and task-centered. Do not write "the user said/用户说..." as the main framing; describe the request, symptom, evidence, and next step directly. Quote the user's exact words only under Evidence / References when the wording itself matters.
- For bugs, feature requests, research threads, design feedback, or follow-up engineering work, use a compact template. Include only sections that have real content; do not fill sections with guesses:
  \`Background\`: what prompted this and where it came from.
  \`Observed / Request\`: the concrete symptom, ask, or idea.
  \`Expected / Goal\`: what should be true when this is handled.
  \`Evidence / References\`: user quote, screenshot, link, file path, command output, or code location if available.
  \`Next action\`: the first useful concrete step when someone picks it up.
  \`Unknowns\`: missing decisions or facts that still need confirmation.
- If the information is thin, choose deliberately:
  If local context can answer it cheaply, inspect the relevant code, state, logs, or files before recording and include what you found.
  If the missing information changes scope, product behavior, security, or architecture, ask the user one concise question before recording.
  If the user is clearly deferring and cannot answer now, record the pin anyway but mark assumptions and unknowns explicitly.
- If it is only a personal memo or reminder, a short body is acceptable, but still include why it matters or when to revisit it if that is known.
- For multi-line bodies, pass real newlines. In shell commands, use ANSI-C quoting such as
  \`--body $'line 1\\nline 2'\`; do not put literal \`\\n\` sequences inside ordinary quotes.
- \`--link <url>\`: attach an external reference (GitHub issue, doc, etc.). Use \`--link-type github_issue\` for issue URLs.
- Repo defaults to cwd. Pass \`--repo <path>\` only if you need a different one.

Reading and updating pins:
- \`tacit pin list\` — list pins for the current repo (filter \`--status done\` etc.)
- \`tacit pin show <id>\` — read a single pin before acting on it
- \`tacit pin render <id> --json\` — render a pin's Markdown/HTML body to a PNG and print the output path
- \`tacit pin update <id> --status done\` — mark complete after finishing the work
- \`tacit pin update <id> --body "..."\` — refine the description as you learn more

Visual / HTML pins:
- If a pin contains a full HTML document, SVG diagrams, charts, mockups, visual layouts, or other content where visual understanding matters, run \`tacit pin render <id> --json\` after \`pin show\`.
- Inspect the returned \`image_path\` with whatever local image-viewing capability is available in the current agent environment. Use both the rendered screenshot and the pin source when reasoning about the artifact.
- By default, render output is written to \`<repo>/.tacit/pin-renders/<pin-id>/latest.png\` and overwritten on the next render, so it should not accumulate. Do not commit rendered pin images unless the user explicitly asks.
- Pass \`--out <png>\` only when the user asks for a specific export path.

Rules:
- Pins belong to the user. Don't invent pins the user didn't ask for.
- One pin per intent. Three deferred items = three \`pin add\` calls.
- After completing work that originated from a pin, call \`pin update <id> --status done\`.
- The pin store is local to Tacit. It does NOT auto-sync to GitHub. If the user wants something on GitHub, they will say so explicitly.
- Status values: \`open\` (default), \`done\`, \`dropped\`. Pick \`dropped\` (not delete) when a pin is abandoned, so the history is preserved.
`;

/** Tasks and Notes' section of a project's AGENTS.md (see shared/agent-instructions.ts). */
export const PIN_INSTRUCTIONS: InstructionSection = {
  heading: "Tacit Pin System",
  text: PIN_SECTION,
};
