# 23 August — Tacit Brainstorm

## Why this document exists

This is a structured record of the product discussion around Tacit: its long-term thesis, the local-first product wedge, the voice/HUD idea, workflow learning, team collaboration, privacy boundaries, and commercial direction. It is intentionally not a transcript. It captures the decisions, tensions, and open questions that should guide future product work.

## One-sentence thesis

**Tacit is a local-first control plane for people and teams to run, understand, govern, and reuse work performed across agents, terminals, browsers, APIs, and later cloud compute.**

It should help work compound into inspectable systems instead of disappearing into scattered prompts, tabs, and model-specific histories.

## The three layers

The foundational framing has three layers:

1. **Model intelligence** — frontier and specialist models from OpenAI, Anthropic, Google, open-source providers, and future vendors. These will keep changing; users should be able to choose the right one for each task.
2. **A person's universe** — their accumulated knowledge, judgment, preferences, relationships, context, methods, working style, and lived history. This is far larger than a chat-memory feature or a project folder.
3. **The harness/control plane** — the system that combines a task-specific projection of the person's context with external model intelligence to produce outcomes.

Tacit should be a provider-neutral control plane above individual model harnesses. It should not try to replace every model or claim that no data ever leaves a machine. Its honest promise is:

> Only the minimum necessary context should leave, the user should be able to see where it went and why, and useful operating knowledge should remain portable.

## Product principle: explicit boundaries, not false privacy

The product must distinguish clearly between:

- **Personal vault** — private skills, methods, preferences, personal notes, and personal context that the individual owns.
- **Workspace** — a shared project boundary containing team-owned work, agents, artifacts, project decisions, and agreed policies.
- **Task projection** — the small, purpose-specific packet of files, instructions, permissions, and context a selected agent receives for one step.
- **Execution evidence** — output artifacts, logs, diffs, screenshots, test results, sources, and approvals that establish what happened.

Cloud models can still observe whatever is sent to them. Tacit cannot make cloud use magically private. It can make data flow explicit, reduce unnecessary disclosure, keep raw context locally controlled where possible, and keep a provenance trail.

Avoid security-through-obscurity. Do not make workflows deliberately complex merely so an external model cannot infer them. Use deliberate scoping, credential isolation, redaction, permissions, and auditable policy instead.

## What already exists and what it proves

Tacit already has the important primitive: an interactive canvas with terminal and browser nodes, coding-agent invocation, connections, lifecycle handling, and resource management.

The current browser ↔ terminal ↔ agent loop proves that nodes can do real work together:

- a terminal can launch an agent or browser job;
- a browser can perform work and emit an output/event;
- an agent or terminal can receive that event and continue;
- inactive resources can be hibernated and resumed while preserving useful state such as links and cookies.

This is not merely a visual canvas. It establishes a node protocol with state, inputs, outputs, capabilities, lifecycle, and connections. A remote computer or GPU node is an extension of the same protocol, not a new product architecture.

## Node architecture: make nodes observable and composable

Every node should be **observable and controllable**. Not every node needs its own independent intelligence.

Each node should expose a standard contract:

- **State:** idle, running, waiting, completed, failed, paused, hibernated.
- **Typed events:** for example `upload_completed`, `page_changed`, `file_created`, `agent_needs_input`, `test_failed`.
- **Inputs and outputs:** files, URLs, structured data, text, screenshots, artifacts, and references.
- **Capabilities:** browse, upload, run command, call API, read/write approved files, pause, resume, destroy.
- **Evidence:** logs, screenshots, diffs, emitted artifacts, and references to source data.
- **Policy:** permissions, data mounts, cost limits, approval gates, and allowed destinations.

### Foundational connective nodes

Prioritize a small set of nodes that make the existing terminal/browser/agent canvas reliable and reusable:

- **Event/trigger node** — waits for a typed condition or external event.
- **Condition/router node** — selects an explicit path based on structured state.
- **Transform/observer node** — receives an event or multimodal output, applies a deterministic rule or bounded agentic instruction, and produces a typed next output.
- **HTTP/API node** — makes authenticated, policy-controlled API calls. This is foundational for a genuine workflow substrate.
- **Artifact/file handoff node** — moves declared output between approved nodes.
- **Approval/checkpoint node** — holds a workflow until a person gives a decision.
- **Notification/presenter node** — turns a salient event into a HUD card, voice update, or navigation action.
- **Resource-policy node** — hibernate, resume, limit concurrency, or enforce a budget.

The compositional pattern is:

`Browser event → observer/transform → condition or approval → API/browser/agent action`

Use deterministic events and rules first. Escalate to an agentic interpretation only where the input is ambiguous, visual, or otherwise cannot be expressed deterministically.

## The voice/HUD: an operating interface, not a talking terminal

The floating HUD/voice companion should be more than a notification pill. It is the presenter and interaction boundary for work occurring inside and outside the canvas.

When the user is in another application, it should be able to say concise, useful things such as:

> “The checkout worker failed at the upload step. The browser session is preserved. Priya's approval is needed. Say ‘show evidence,’ ‘retry with fallback,’ or ‘take me there.’”

The user should be able to ask:

- What is running, blocked, or complete?
- Which of the seven Claude/Codex terminals finished?
- What changed? Show a short summary, diff, source, screenshot, artifact, or evidence card.
- Pause the idle browser; resume the research worker; redirect the agent.
- Take me to the relevant canvas node or visually highlight it.

Voice should report only salient events: blockers, decisions, failures, milestones, approval requests, resource risk, and completion summaries. It should not narrate every tool call. The underlying system needs profiles or policies such as quiet, normal, brief, and verbose, plus deduplication and burst summaries.

The HUD can also become a lightweight presenter: expand a long response into a scrollable card, artifact preview, deck, diff, source list, or evidence bundle without forcing the user to hunt through a terminal transcript.

## Learning workflows by demonstration

The ambition is not merely “record a macro.” Tacit should help a person turn repeated work into a reviewable, reusable system.

The best flow is:

1. A user explicitly scopes the screens, apps, or canvas resources Tacit may observe.
2. They work normally and can narrate short pieces of intent by voice or text.
3. Tacit records events, decisions, declared evidence, and outcome criteria locally.
4. After repeated examples, Tacit proposes a **draft skill/workflow**, including uncertain steps and human checkpoints.
5. The user reviews, edits, approves, and publishes the workflow to a personal vault or shared workspace.

Two or three demonstrations can create a useful hypothesis, but not a trustworthy fully automatic skill. Research and knowledge work vary. The system should say:

> “I think your pattern is broad source discovery → evidence extraction → comparison → plan → decision. Here is the proposed workflow and the steps I am uncertain about.”

Capture three layers:

- **Events:** pages, queries, commands, files, tool outputs.
- **Decisions:** why a source was chosen/rejected, what standard was used, what changed the plan.
- **Outcomes:** what counted as a good result, decision, artifact, or completed task.

Short user annotations such as “I am checking primary sources now” are far more useful than attempting to infer every intention from clicks and screen capture alone.

## Skills: portable intent, provider-specific execution

A native Claude Code skill, Codex skill, browser-agent workflow, or other harness configuration will not run identically in every environment. Tacit should not promise that it will.

Tacit should own a canonical, user-controlled skill specification containing:

- goal and success criteria;
- typed inputs and expected outputs;
- ordered steps and dependencies;
- required capabilities: browser, terminal, filesystem, HTTP, agent;
- policies: allowed domains, credential scopes, redactions, approvals;
- validation conditions;
- evidence expected on completion.

Adapters compile this canonical skill into provider-specific execution plans:

`Tacit skill → Codex plan`  
`Tacit skill → Claude Code plan`  
`Tacit skill → Gemini/browser/API plan`

The portable asset is the intent, workflow specification, validations, and evidence contract. The provider-specific binding is replaceable. When an environment lacks a required capability, Tacit should say “portable with changes” and identify the missing piece.

## Local-first resource management and cloud extension

Tacit should protect the user's laptop from the system it enables. Existing ideas around active-worker pools, browser hibernation, state preservation, and activity/resource monitoring are important product foundations.

The system should make capacity visible and bounded. If a local machine is overloaded, Tacit can propose pausing, hibernating, or closing low-priority resources rather than silently degrading or crashing.

### Remote computer and GPU nodes

Cloud capability is compatible with the local-first thesis if the local/private control plane remains authoritative.

- A **remote computer node** is leased execution capacity, not a copy of the user's entire personal vault.
- A **GPU node** is an approved, budgeted batch or interactive compute resource.
- Agents receive only scoped mounts and short-lived credentials.
- Remote nodes return declared artifacts and evidence through controlled channels.
- Ephemeral disks should be destroyed or snapshotted according to an explicit policy.

The canvas should make resources feel approachable, but it must not make serious cloud expenditure feel like a toy. Before provisioning expensive resources, show provider, location, machine type, GPU count, estimated hourly cost, lifetime, data mounts, and a hard spend cap. Require explicit confirmation for high-cost or high-risk actions and provide an obvious kill switch and automatic idle shutdown.

Remote macOS and commercial creative applications are special cases. They need authorized Apple-hardware hosting and explicit user licensing/authentication; they cannot be treated as generic arbitrary VMs.

The strongest framing is:

> Tacit is a capability graph: local devices, remote computers, GPUs, browsers, agents, tools, and human approvals—visible and governed from one workspace.

## From personal canvas to shared workspace

Tacit should begin local-first, but small-team collaboration is a natural extension. A workspace is a shared, project-scoped boundary—not a claim that team work never leaves a model provider.

For an early team product, build a shared-work contract:

- shared workspace identity and ownership;
- real-time sync and versioned canvas changes;
- basic roles and approval checkpoints;
- shared event timeline and task/agent status;
- evidence/artifact cards for verification;
- secrets stored separately from canvas definitions, with scoped access;
- failure recovery, pause/resume, retries, handoffs, and idempotent actions;
- resource and cost limits per workspace.

The required separation is:

- **Personal vault:** individual-owned knowledge and methods.
- **Workspace:** team-owned project workflows and deliverables.
- **Explicit transfer:** the user decides what is published from their personal vault to the workspace.

Do not build heavy enterprise administration first: SSO, SCIM, VPC-only deployment, extensive compliance certifications, and elaborate billing management can wait. The early product should prove that small teams can coordinate agents and inspect outcomes without chaos.

## Product positioning

Avoid fear-first language such as “buy this or you will be jobless.” The concern about AI-mediated work, surveillance, portability, and ownership is real, but fear is not a durable product promise.

### Product philosophy

> Don't let AI turn your work into disposable prompts. Build an operating system for your own capability.

### Initial user-facing wedge

> Keep your existing AI subscriptions. Tacit makes them work together, keeps the work legible, and turns results into reusable systems.

The first target users are serious individual builders, founders, developers, researchers, operators, and small AI-native teams already coordinating multiple terminals, browsers, agents, and recurring workflows.

For these users, the paid pain is not abstract privacy alone. It is:

- lost context and scattered state;
- agent completion going unnoticed;
- manual copy/paste handoffs;
- expensive verification and restarts;
- difficulty supervising parallel work;
- inability to reuse a working process with evidence.

### Small-team language

> Turn agent work into reliable team systems—not scattered prompts, tabs, and fragile automations.

### Enterprise expansion language

> A governed control plane for agent work.

Enterprise buyers care about permissions, approved tools/models, data boundaries, auditability, spending controls, reliability, and controlled rollout. This is a later expansion, not the initial product requirement.

## Market and monetization hypothesis

The immediate category is not “personal AGI for everyone.” It is a control plane for AI-native work, beginning with high-agency technical users and small teams.

There is directional willingness-to-pay evidence: developers already pay meaningful monthly amounts for coding agents and AI development tools. This does not prove Tacit demand. Tacit earns a second bill only if it produces incremental value: saves expensive time, prevents a costly mistake, enables supervision of more parallel work, or turns one-off work into a reliable reusable system.

### Suggested packaging

- **Free/local:** usable canvas, local terminals and browsers, basic connections, bring-your-own subscriptions/keys. This creates trust and adoption.
- **Pro:** persistent private vault, skill capture/replay, cross-provider adapters, advanced event history, HUD/voice, richer artifact and evidence presentation.
- **Team:** shared workspaces, collaboration, shared agent pools, roles/approvals, workflow libraries, team audit/evidence, cloud sync.
- **Business later:** SSO, policy controls, retention, self-hosting/VPC, spend controls, compliance support, and managed deployment.
- **Usage:** optional managed remote browsers, compute, and execution infrastructure, billed transparently with limits and a platform margin where appropriate.

Do not primarily price by number of nodes. That risks taxing the complexity Tacit is supposed to tame. Prefer value-based gates: persistence, shared operation, governance, managed execution, and advanced control.

The long-term attractive revenue model is recurring control-plane software revenue plus optional infrastructure usage—not advertising and not monetizing user workflow data.

## Validation plan before a fundraising story

Do not rely on a broad TAM claim alone. Validate a narrow willingness-to-pay loop:

1. Recruit 15–20 users who already run multiple coding agents, terminals, and browsers.
2. Observe one week of real work: agent restarts, manual handoffs, missed completions, verification time, context switching, and unresolved failures.
3. Give them the smallest compelling loop: several live sessions + event digest + evidence card + pause/resume + one voice/HUD interaction.
4. Measure repeat usage and whether the system becomes part of their daily operating rhythm.
5. Ask for payment after use, not a hypothetical opinion. Test individual pricing and a small-team pilot.

Early evidence a VC should care about:

- users return without being reminded;
- they connect more than one agent/tool because the coordination value grows;
- they depend on the event/evidence layer during real work;
- they convert or commit to a paid pilot;
- they describe Tacit as difficult to remove from their workflow.

## Prioritized roadmap

### Phase 1 — make local multi-agent work operable

1. Reliable terminal/browser/agent lifecycle and hibernation.
2. Standard node event/output/evidence contract.
3. Event timeline, status digest, and artifact/evidence cards.
4. A small connective-node set: trigger, condition, transform, HTTP, approval, artifact, resource policy.
5. HUD/voice for navigation, summaries, approvals, pause/resume, and “show proof.”

### Phase 2 — make work reusable

1. Scoped workflow capture and user annotations.
2. Draft skill/workflow proposals with uncertainty and review.
3. Canonical Tacit skill specification and provider adapters.
4. Personal vault, disclosure policy, and provenance logs.

### Phase 3 — small-team collaboration

1. Shared workspace sync and versioning.
2. Ownership, permissions, approvals, secrets, and shared evidence.
3. Team-level resource/concurrency/cost controls.
4. Team workflow templates and reviewable execution history.

### Phase 4 — approved cloud capability

1. Remote Linux/browser/agent jobs.
2. Metered GPU and batch compute nodes with budgets and kill switches.
3. Higher-complexity remote desktops and licensed applications only where justified.

## Questions to keep testing

- Which single daily pain makes Tacit indispensable for the first 20 users?
- Is voice/HUD the retention driver, or the best interface to an event/evidence system that is the real driver?
- Which workflow type should be learned first: coding delivery, research, operations, or a specific vertical?
- Which data should remain personal, and which must become workspace-owned for a team to function?
- What is the smallest collaboration contract that teams trust?
- What evidence format lets a user verify an agent outcome in under a minute?
- What pricing event demonstrates value without punishing exploration?

## Closing view

The vision is large, but it is not merely philosophical. Tacit already has a technical spine: a canvas of real terminals, browsers, agents, connections, state, and lifecycle controls.

The central discipline is to avoid shipping “the whole universe” at once. Prove the local loop where a person can run several agents and tools, understand what matters, intervene naturally, and preserve the work as a reusable system. Build the team and cloud layers on that same explicit node, policy, evidence, and ownership model.

