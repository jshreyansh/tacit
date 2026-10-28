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
