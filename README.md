# concerto

Concerto is a Bun-based CLI orchestrator that routes a task through a deterministic
agent pipeline: planner → implementor → reviewer → tester, with artifacts persisted
per run under `.orchestrator/runs/<task_id>/`.

## What It Does

- **Planner** produces a structured plan JSON (no code changes).
- **Implementor** applies a single plan step and emits a unified diff or proposed actions.
- **Reviewer** validates diffs against constraints and project rules and can return concrete fixes.
- **Tester** adds/updates tests only and runs the test command.
- **Orchestrator** sequences agents, enforces guardrails, and writes artifacts.
- **Repo Mode** clones a Git repo, creates a work branch, applies changes, commits, pushes, and opens a PR.

## CLI

- `orchestrator run "<task>" --repo <git_url>` queues a run and returns a `run_id`.
- `orchestrator run "<task>" --repo <git_url> --start-worker` queues a run and starts a background worker.
- `orchestrator worker` runs the queue worker loop.
- `orchestrator status [run_id]` shows the latest run state (or a specific run).
- `orchestrator plan "<task>"` runs planning only.
- `orchestrator implement --run <path>` runs implementor only.
- `orchestrator review --run <path>` runs reviewer only.
- `orchestrator test --run <path>` runs tester only.

## Artifacts

Runs are stored under `.orchestrator/runs/<task_id>/`:

- `task.json`
- `plan.json`
- `handoff.json`
- `implementor.json`
- `review.json`
- `test.json`
- `pr-draft.json`

## Repo Workflow

When using `--repo`, Concerto:

- clones the repo to `.orchestrator/workspaces/<task_id>`
- creates and checks out `concerto/<task-description>`
- applies changes in that workspace
- auto-commits, pushes, and creates a PR via the GitHub API

The workspace is deleted at the end of the run unless you pass `--keep-workspace`.

## Environment

- `GITHUB_TOKEN` is required for PR creation (token needs `repo` scope for private repos).

## Install

```bash
bun install
```

## Run

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.9. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
