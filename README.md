# concerto

Concerto is a Bun-based CLI orchestrator that routes a task through a deterministic
agent pipeline: planner → implementor → reviewer → tester, with artifacts persisted
per run under `.orchestrator/runs/<task_id>/`.

## What It Does

- **Planner** produces a structured plan JSON (no code changes).
- **Implementor** applies a single plan step and emits a unified diff.
- **Reviewer** validates diffs against constraints and project rules.
- **Tester** adds/updates tests only and runs the test command.
- **Orchestrator** sequences agents, enforces guardrails, and writes artifacts.

## CLI

- `orchestrator run "<task>"` runs the full pipeline and persists artifacts.
- `orchestrator plan "<task>"` runs planning only.
- `orchestrator implement --plan <path>` runs implementor only.
- `orchestrator review --plan <path> --impl <path>` runs reviewer only.
- `orchestrator test --plan <path> --impl <path>` runs tester only.
- `orchestrator pr --from-run <path>` placeholder for PR creation.

## Artifacts

Runs are stored under `.orchestrator/runs/<task_id>/`:

- `task.json`
- `plan.json`
- `handoff.json`
- `implementor.json`
- `review.json`
- `test.json`
- `pr-draft.json`

## Install

```bash
bun install
```

## Run

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.9. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
