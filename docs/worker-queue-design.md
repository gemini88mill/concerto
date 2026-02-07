# Worker Queue Design (SQLite, No Extra Dependencies)

## Goals
- `run` returns immediately with a `run_id`.
- A background worker processes runs through phases.
- `status <run_id>` reports current state from artifacts.
- Multiple runs can proceed concurrently without interfering.

## Non-Goals
- No changes to agent logic (planner/implementor/reviewer/tester).
- No external services (Redis, Postgres).
- No UI or HTTP API in this phase.

## Constraints
- Must use SQLite via `bun:sqlite` (no extra dependencies).
- Keep artifacts in `.orchestrator/runs/<run_id>/`.
- Keep workspaces in `.orchestrator/workspaces/<run_id>/`.
- Preserve current run artifacts (`task.json`, `handoff.json`, `plan.json`, etc.).

## Architecture Overview
### Components
- **CLI submitter**: `run` creates a run, writes initial artifacts, enqueues a job, exits.
- **Worker process**: a long-lived process that claims jobs from SQLite and executes phases.
- **Status command**: reads `handoff.json` (or `task.json`) to report state.

### Data Flow
1. `run <task>` creates `run_id`, writes `task.json`, initializes `handoff.json` with `queued`.
2. `run` enqueues a job in SQLite: `{ run_id, phase: "plan" }`.
3. Worker claims the job, runs the phase, writes artifacts, updates `handoff.json`.
4. Worker enqueues the next phase job (or marks run complete/blocked).
5. `status <run_id>` reads `handoff.json` for live status.

## SQLite Schema
### Database Location
- `.orchestrator/queue.db`

### Tables
#### `jobs`
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `run_id` TEXT NOT NULL
- `phase` TEXT NOT NULL
- `status` TEXT NOT NULL
  - values: `queued`, `in_progress`, `done`, `failed`
- `attempt` INTEGER NOT NULL DEFAULT 0
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- `last_error` TEXT

#### `run_locks`
- `run_id` TEXT PRIMARY KEY
- `locked_at` TEXT NOT NULL
- `owner` TEXT NOT NULL

### Indexes
- `jobs(status, created_at)`
- `jobs(run_id)`

## Job Claiming and Locking
### Claim Strategy
- Use a transaction:
  - Select one `jobs` row with `status = "queued"` ordered by `created_at`.
  - Update it to `in_progress`, increment `attempt`, set `updated_at`.
- If no row, sleep/backoff and retry.

### Per-Run Lock
- Before processing a job, acquire a lock in `run_locks`.
- If lock exists, release the job back to `queued` and retry later.
- After finishing the phase, release the lock.

### Stale Lock Handling
- If `locked_at` is older than a threshold (e.g., 30 min), allow override.
- Record a warning in logs and continue.

## Phase Execution Rules
### Phase Mapping
- `plan` → `runPlanner`
- `implement` → `runImplementor`
- `review` → `runReviewer`
- `test` → `runTester`
- `pr` → existing PR draft logic (if/when enabled)

### Artifacts
Each phase:
- Writes its phase artifact.
- Updates `handoff.json`:
  - `state.phase`
  - `state.status`
  - append to `state.history`
  - set `next.agent` to the next phase

### Error Handling
- If phase fails:
  - Write `*.error.json` artifact (existing pattern).
  - Update handoff with `status = "failed"`.
  - Mark job `failed` with `last_error`.
  - Do not enqueue next phase.

### Retry Policy
- Use `attempt` with a maximum (e.g., 3 per phase).
- If exceeded, mark job `failed` and stop.

## CLI Behavior Changes
### `run`
- Creates run context and `handoff.json` with `status = "queued"`.
- Enqueues `{ run_id, phase: "plan" }`.
- Prints `run_id` and exits.

### `status`
- No change required if `handoff.json` is updated by worker.

### New `worker` Command
- Long-running process that:
  - Claims jobs
  - Enforces per-run locks
  - Executes phases
  - Updates artifacts and enqueues next phase

## Concurrency Model
- Multiple workers can run simultaneously.
- Only one phase per run at a time (per-run lock).
- Different runs can be processed in parallel.

## File/Module Plan
- `core/queue.ts`: SQLite access, schema init, enqueue/claim/ack/fail, run locks.
- `command/worker.ts`: worker loop and dispatch.
- `command/run.ts`: submit job instead of blocking.
- `orchestrator/state-machine.ts`: reuse phase functions as-is.
- `command/status.ts`: already implemented.

## Operational Notes
- Worker should be run as a service (systemd, PM2, Docker).
- For local dev: `bun run worker` (new script).
- Logs should include `run_id` and `phase`.

## Open Questions
- Max retries per phase: default `3`.
- Lock timeout duration: `5 minutes`.
- Add a `cancel` command for runs to clear stuck jobs/locks.
