# Wiring model

How wires on the canvas connect nodes and what travels over them. Agreed on
2026-10-28; this file is the build plan and the record of what each step
shipped.

## The model

- **Node contract.** Each kind of node says whether it starts things, what
  it offers to whoever is wired to it, what can be sent to it, what events
  it raises and what it can send out (`shared/node-contracts.ts`). Behaviour
  comes from the contracts at the two ends, never from a table of pairs, so
  a new kind of node is one contract and one delivery adapter.
- **Wire.** Two ends, a direction, a one-line purpose, and optional limits.
  `relates-to` is a plain link: drawn and recorded, carries nothing.
- **Direction.** The tail may start; answers come back to the tail.
  Two-way lets either end start. This applies to browser control, messages,
  notes and rules alike.
- **Envelope.** One shape for everything that crosses a wire
  (`shared/wire-envelope.ts`): from, to, wire, kind, body, trust, hop,
  replyTo. Each node kind has one adapter that turns it into its own input.
- **Mailbox.** A message to a busy agent waits until its turn ends.
- **Verbs.** tell (no reply), ask (the reply comes back), hand off.
- **Rules.** "when an event happens at one end, send something to the
  other": the node's Send button pressed for you. Each rule asks the user the
  first time it fires; then runs within an hourly limit and a hop limit.
- **Record.** Every envelope is captured with its wire.

## Decisions (2026-10-28)

1. Agent-to-agent wires allow ask by default (plus tell and hand off).
2. Rules ask the first time they fire, with "always"; then run within limits.
3. Note → agent wires have two modes, Send (once) and Reread (standing
   context). New wires start on Send.
4. The workdesk manager has implicit reach to every node in its workdesk.
5. Hydra tracking switch per wire: Off / Auto / Always, default Auto. Auto
   tracks a hand-off that will change code, goes to a role, asks for a typed
   result, or comes from a Lead.

## Steps

Each step ships on its own, with unit tests, a live check in the dev app,
and hand tests.

1. **Contracts and direction.** Node contracts; abilities derived from the
   two ends, the direction and the wire's limits. Browser control obeys
   direction and plain links. Wire purpose. Browser read-only limit. A
   notice to every agent end that gains something when a wire is made.
   `list_nodes` shows the caller's neighbourhood (with purpose and what it
   can do there) unless asked for everything. Old browser → agent wires,
   whose only effect was letting the agent drive the page, are turned round
   on load so they keep working.
2. **Envelope, mailbox, Send.** Messages to busy agents queue in the main
   process and drain when the turn ends. A Send action on browser, note and
   agent nodes passes their output along a chosen wire. Content from pages
   is labelled as data.
3. **Ask, hand off, tasks.** `ask` routes the target's finished reply back
   to the asker. `hand_off`. Notes and tasks become drop targets; an agent
   wired to a task logs steps into it. Note wires get Send / Reread.
4. **Rules.** When → send, with first-time approval, hourly and hop limits.
   `sends-replies-to` and `writes-to` become rules.
5. **Hydra on the wires.** The tracking switch; a tracked hand-off uses
   Hydra's result contract; dispatch labels its worker's wire with role and
   status.

## Before the week (2026-10-29)

Three gaps found in hand testing, closed before the build that runs the
week. Same rules as the steps: unit tests, a live check, hand tests.

6. **Wires survive a restart.** What is waiting for an agent (its mailbox),
   questions still being answered, and tracked hand-offs are kept on disk
   in the Tacit data folder (`wire-state.json`, readable only by the user)
   and restored when the app starts.
   - A restored message is not typed in until the agent is known to be at
     its prompt again: its first turn after the restart ends, or the user
     presses Deliver now. A CLI that has just restarted may be showing an
     update menu or a trust question, and typed text plus Enter would answer
     it. The user is told what is waiting and for whom.
   - Delivery looks up the terminal's current PTY each time; the PTY a
     message was queued for is gone after a restart.
   - A question whose answer was being worked on when the app closed was
     interrupted with its agent. The asker is told, with the question, and
     can ask again.
   - A tracked hand-off keeps its task sheet and timeout. The receiver is
     reminded to finish and write its result, through its mailbox; the
     result is checked as before.
7. **OpenCode answers.** OpenCode keeps its turns in its database, not a
   transcript file. Its final reply is read from there: in 2.0 a turn ends
   with an `idle` entry, and the reply is the text of the last assistant
   entry before it (1.x: the last assistant message that finished with
   `stop`). With that, OpenCode can be asked a question and answer it, its
   finished turns run rules, and its replies go to chats and notes like
   Claude's and Codex's. Its turn state already comes from the database, so
   its messages wait in the mailbox like the others' (checked live).
8. **Roles, tested for real.** Each of Hydra's roles (dev, reviewer, qa,
   designer, janitor) is checked twice: given to a wire, where a tracked
   hand-off's task sheet carries the role, and dispatched by a real Hydra
   Lead, where the worker's wire shows "role · status". A wire with a role
   shows the role on its label, and a tracked hand-off along it shows how
   it's going (working, done, stuck), as a Hydra worker's wire does.
   - Found while testing: the packaged app's Hydra knew no roles (the role
     files weren't copied into its build); they ship with it now.
   - Every Hydra workbench is a new folder, and Claude and Codex ask
     whether to trust each new folder, so workers stopped at that question.
     Decided 29 Oct: Tacit trusts a workbench folder for an agent when the
     folder is inside the repo and that agent already trusts the repo
     (electron/agent-folder-trust.ts); otherwise the agent asks. A worker
     waiting at a question shows "<role> · needs you".
   - Hydra closes a worker's terminal once the Lead collects its result, so
     a worker's wire shows "working" (or "needs you") and then goes; "done"
     is seen only on wires whose worker stays open (tracked hand-offs).
