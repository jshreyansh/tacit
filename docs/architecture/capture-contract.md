# Canonical capture contract

Tacit's record is an append-only JSONL event stream owned by the user. Schema version 2 is the common envelope for human actions, agents, terminals, browsers, and system observations. The original event payload remains at the top level so existing prompt and canvas-topology provenance is not discarded.

Every entry carries:

- `event_id`, `at`, `canvas`, `task_id`, and `session_id` for identity and ordering.
- `actor_identity` and `node_ref` to distinguish who caused an action from where it happened.
- `input_refs`, `output_refs`, and `evidence` as typed references. Large transcripts, files, screenshots, and artifacts are referenced rather than duplicated.
- `intent` as `observation`, `decision`, or `correction`.
- `privacy_scope` as `workspace`, `private`, or `redacted`.
- `provenance.method` to state whether a hook, renderer interaction, main process, or migration produced it.

Writers use `buildCaptureEnvelope` through `CaptureService`. New adapters should supply a `CaptureRecordContext` when they know task identity, evidence, privacy, or input/output references; safe defaults keep partial observations valid.

## Migration

Version 1 files are never rewritten. Readers call `normalizeCaptureEntry`, which upgrades each old line in memory, preserves its original event fields, and marks `provenance.method` as `migration` with `source_schema_version: 1`. New lines are always version 2. This keeps the record append-only and permits future migrations to follow the same read-time pattern.
