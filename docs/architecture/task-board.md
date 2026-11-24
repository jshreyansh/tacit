# The task board

Agreed 24 Nov 2026, after the interactive prototype
(https://claude.ai/artifact/HHnhjC7h4nfB7ZXTdn67RU) and a read-only review by
Codex. Linear: T22 (SHR-182) in M1.

One board for the whole workdesk. A task is the brief an agent works from, and
then the record of what it did. The board answers three questions: what needs
me, what's running, what's next.

**Built** 24 Nov 2026, all six steps; not yet released. Changed on the way, by
the user: no migration (nobody was using the old tasks and notes), no Tasks
under each folder, and the old tasks and notes are gone from the app. Their
files (`~/.tacit/pins`) are left where they are.

## What it replaces

One record, `Pin` (`shared/pin.ts`), is both a task and a note, told apart by
`kind`. It's saved per folder (`electron/pin-store.ts`,
`~/.tacit/pins/<hash>/<id>.md`).

What's wrong with it today:

- **Thin:** a name, text, steps and a status. Across both instances, 19 of 37
  tasks had no description and 7 of 14 notes were empty.
- **Working isn't known.** Putting an owner on a task sets In progress
  (`statusFromSteps`); handing it to the manager only fills its message box
  (`handTaskToManager`).
- **Done isn't checked.** An agent sets it, and that ticks every unfinished
  step (`PinStore.update`).
- **One question** (`ask`). A second replaces the first, and an answer is
  saved before it's delivered (`answerTask`).
- **Lost edits.** Steps and owners are saved as whole lists with no revision,
  and `tacit task step` reads then writes.
- **A folder at a time.** All tasks shows one folder (`TasksView`), and a task
  can't have none: `repo` is required, and an agent's scope comes from its
  terminal's folder (`ApiServer.terminalTasks`).
- **Three look-alikes:** a note, a board sticky and a task.

Kept: wires to tasks and notes, tiles on the canvas, and sections that hold
them. `tacit pin` still adds a task. `tacit pin render` is gone.

## What becomes a task

Work with a clear end that you'd mind losing.

- **Yes:** handed to an agent by you or the manager; put off for later; a goal
  with several parts; an imported issue.
- **No:** a question, a loose thought, one step.
- Chatting with an agent makes no card; **Track as task** does, in one click.
- A goal given to the manager is one card. Each worker's share is a part of it.
- Something an agent finds on the way is offered as a follow-up. You decide.

## The board

- Columns: **Later, Next, Working, Needs you, Done.** Dropped is kept, and
  filtered out until asked for.
- **One Needs you column**, filtered by reason. No separate In review.
- Every folder of the workdesk, plus tasks with no folder. Board or List,
  search, folder filter. Order is by priority, then by how long it has waited.
- Drag a card to Later, Next or Done. Dragging to Working asks which terminal.
  Nothing can be dragged into Needs you.
- Drop a card on a terminal to hand it over. A busy one offers Queue or
  Interrupt. A closed one offers Start it again.
- Done cards stay marked until you've seen them.
- A column is never narrower than its cards can be read at; the board scrolls
  sideways. An empty column is narrow.
- Whom to hand it to is the picker every agent is chosen with
  (`src/agents/AgentPicker.tsx`).

It opens where All tasks does: the pane on the canvas, a tab in the grid.

## The task

Only the name is required. An agent may draft the rest, for you to accept
before it starts.

| Field | Filled by | Changed while an agent has it |
|---|---|---|
| Name, Description | you or an agent | the agent is told what changed |
| Kind: Build, Bug, Research, Write, Other | you | nothing: it only picks which prompts go in the description |
| Done when (lines) | you or an agent | agents only suggest; proof on a changed line is cleared |
| Leave alone | you | told at once |
| Start from: chat, files, notes, pages, sections, issues | you or an agent | added to its context |
| Allowed: what you said it may do without asking | you | taken away at once; given again each try |
| Priority | you | nothing: it doesn't interrupt |
| Folder, or none | you | not while it works |
| Works in: same folder or own worktree, per part | you | set at hand over |
| Check it: when there's a reason, Always, Never unless I ask | you | yours alone; an agent may only ask for more |
| Parts: name, terminal, state, requests | you, manager, agents | one part at a time |
| Tries: who, when, why it ended, what it left | Tacit | never edited |
| Requests, any number | agents and Tacit | answered, withdrawn, or closed with the task |
| Decisions: what was asked, the options, what you chose | you | a new answer replaces it and says so |
| What changed | Tacit | never edited; says when others shared the folder |
| Where it landed: not committed, committed, pushed, released | Tacit | updates by itself, after Done too |
| Finish report | agent and Tacit | a later change marks its proof out of date |
| Conversation | you and agents | each message waiting, delivered or failed |
| History, Made from, Led to, Seen, Time and use | Tacit | never edited |

Left for later: due dates, labels, links between tasks. Left out: estimates,
sprints, watchers, votes, custom fields.

## How it moves

The column is worked out, never stored:

1. closed by you, or by a finish that passed the rules → **Done** or **Dropped**
2. any open request, even for one part → **Needs you**, saying what carries on
3. any part queued, being handed over, or being worked on → **Working**
4. otherwise the one you chose: **Later** or **Next**

Requests, each with who asked, since when, and what carries on:

- **Decide:** a question with options, a recommendation, and your own words.
- **Allow:** the agent's CLI is waiting on a permission. The card takes you to
  its terminal; it isn't answered on the board.
- **Approve first:** before something that can't be undone.
- **Stuck:** not delivered, quiet for 10 minutes, out of usage, closed,
  interrupted, or stopped without a report.
- **Check:** finished, with a reason to look.

A part's try: queued, handed over, has the brief, working, paused, quiet,
stopped (and why), reported. "Has the brief" isn't "working": that's seen
from its first action.

- **A turn ending is never Done.** Tacit asks once: finished, stuck, or still
  going? No answer makes it Stuck, with the last thing it said (where its hooks
  carry that).
- **Ending a turn to wait for your answer** is right: it shows as waiting for
  you, isn't asked, and isn't counted as carrying on.
- **After a restart, or when you open another workdesk** (its agents stop until
  you're back), its tries show as interrupted, saying which.
- **Typing "go on"** in its terminal picks the same try up, and it can report.
  A turn that a message about another task, or another agent's question,
  started doesn't; nor does anything once you've left it for later, but what
  you say on the task itself.
- **Given back to it, it can't finish** until it has read why.
- **An answer** leaves Needs you when it's delivered. If the asker has closed,
  it goes with the next brief.
- **A terminal has one task at a time.** Another waits, and goes when its turn
  and its task are over.
- The rules are one file (`shared/task.ts`), walked at random over several parts
  at once (`tests/task-model.test.ts`): never Working with something waiting,
  every request has a way out, closed means over.

## Finishing

A finish is a report: what was done, each Done when line, what's left. Every
line is marked **Tacit saw**, **Agent says** or **Not checked**. Only Tacit can
write the first. With no Done when lines, the agent says how it checked the
whole.

Straight to Done, unless:

- no account of how it was checked, or a line not checked;
- tests ran before the last change;
- dependency or build files changed;
- another agent was editing the same folder;
- the agent says it's unsure, a matter of taste, or touches sign-in, payments
  or data;
- you asked to check it, or always check this kind.

What Tacit can tell, and what it can't:

- **Tests** (`electron/task-evidence.ts`): from each agent's tool hooks, the
  command and how it ended. Counted only when the command's own exit is the
  tests' (`npm test | tail` succeeds whatever the tests did, so it counts for
  nothing), and with a snapshot of the folder as they ended: anything changed
  after makes it "before the last change". Works for agents whose hooks carry a
  command's exit (Claude does; Codex when its output says). Otherwise it stays
  Agent says.
- **Files changed**: from the turn snapshots, in git folders.
- **Where it landed**: not committed, committed, pushed, from git. Released
  isn't told.
- **Can't at all:** whose change is whose when two agents share a folder; that
  code touches sign-in or payments (the agent says).

**Allowed and Approve first are not enforcement.** They're what agents are told,
and what the board shows. What stops an agent is its own CLI's permission mode
(T15). The board must never suggest otherwise.

## Notes

Note and board sticky become one **Note**: a sticky on the canvas, a page when
opened.

- Its first line is its name, so there are no untitled notes.
- It belongs to the workdesk. Any agent wired to it can read it, as today.
- It has a colour, sits in sections, and arrows attach to it.
- **Start a task from it** makes a separate task, linked. The note stays.

They're in the workdesk's board (`src/board/notes.ts`), so colour, sections,
arrows, undo and selecting are the board's. Wires end at them as at tiles
(`src/canvas/noteEnds.ts`).

## How it's saved

- Tasks: `TaskStore`, `~/.tacit/tasks/workdesk-<id>/<id>.json`, with
  `<id>.events.jsonl` beside it, append-only, and `<id>.attachments/`. Changed
  only in the main process. T-numbers are counted on each workdesk and never
  given twice.
- Notes: the workdesk's board, in its scene.
- A task's place on the canvas is the workdesk's (`recordPlaces` in its scene).
- **Edits:** every change is a narrow operation (`shared/task-ops.ts`), checked
  field by field, with an idempotency key. Text made from an old revision is a
  conflict, and the typing is kept. Updates from a try that has ended are
  refused.

## Agents

- Tools: `list_tasks`, `get_task`, `create_task`, `take_part`, `report_part`,
  `finish_task`, `ask_user`, `ask_approval`, `withdraw_question`,
  `suggest_task_text`, and for the workdesk manager `hand_over_task`.
  `update_task` is gone: it could say done with nothing behind it.
- Always the agent's own workdesk, and only its own try. An agent can't set what
  it's allowed, or loosen a check; changing a brief is a suggestion.
- `request_agent`: one that isn't the manager asks for another, opened or where
  it is. It's an Approve first that Tacit acts on (`TaskRequest.does`): you see
  the exact words, nothing happens until you pick Go ahead, and it happens once
  (`TaskRunner.doReach`). Agents only, never a shell; within the worker limit;
  the wire stays. A guardrail, not a sandbox: an agent's own shell can do what
  its CLI allows.
- `tacit task` does the same from a terminal. In a plain shell it reads and adds.
- Claude uses them without asking (`TACIT_TASK_TOOLS`, allowed per launch), all
  but `hand_over_task`, and reads the workdesk (`TACIT_READ_TOOLS`). Codex already ran Tacit's tools without asking.
- Instructions are `electron/task-instructions.ts`; projects set up before are
  offered the new section.

## Platform boundary

- `window.tacit.tasks` (`electron/task-ipc.ts`): only the app's own window,
  arguments checked, refusals as words to show.
- `electron/task-runner.ts` is told what it needs (send, interrupt, snapshot,
  git) and is tested without Electron.

## Steps

1. **Records** (T22.1), 2. **The board and the task page** (T22.2), 3. **One
Note** (T22.3), 4. **Handing over** (T22.4), 5. **Parts and requests** (T22.5),
6. **Finishing** (T22.6). All built; not yet used with real agents.

Not done from the plan: Draft the rest by an agent (they can suggest); choosing
the worktree when handing over (it's advised, and a worktree is made from the
folder's +); Tacit's own sentences in a task's history are in English only.

## Risks

- **A form nobody keeps up** (Codex's first point). Only the name is required;
  Tacit fills in what it can; nothing asks an agent for running updates. After
  step 2, count how many tasks have Done when, and cut what's unused.
- **Needs you gets ignored.** Every request says what to do and how long it has
  waited. A part waiting on another part doesn't count.
- **Agents that skip the tools.** A turn that ends without a report is asked
  once, then is Stuck. It's never quietly Done.

## Not in this

- Issues coming in and going out (T19, SHR-153) build on this.
- People sharing a board.
- Answering a permission on the board.
- Scheduled tasks (SHR-175).
