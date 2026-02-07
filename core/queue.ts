import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface QueueJob {
  id: number;
  runId: string;
  phase: string;
  status: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

interface RunLock {
  runId: string;
  lockedAt: string;
  owner: string;
}

interface QueueStats {
  queued: number;
  inProgress: number;
  activeLocks: number;
}

interface QueueRecoveryResult {
  requeuedJobs: number;
  releasedLocks: number;
}

interface StringMap {
  [key: string]: unknown;
}

const isRecord = (value: unknown): value is StringMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const QUEUE_DB_PATH = resolve(".orchestrator", "queue.db");
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

let dbInstance: Database | null = null;

const ensureDb = async () => {
  if (dbInstance) {
    return dbInstance;
  }
  await mkdir(dirname(QUEUE_DB_PATH), { recursive: true });
  const db = new Database(QUEUE_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS jobs_status_created_at
      ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS jobs_run_id
      ON jobs(run_id);
    CREATE TABLE IF NOT EXISTS run_locks (
      run_id TEXT PRIMARY KEY,
      locked_at TEXT NOT NULL,
      owner TEXT NOT NULL
    );
  `);
  dbInstance = db;
  return db;
};

const mapJobRow = (row: Record<string, unknown>): QueueJob | null => {
  const id = typeof row.id === "number" ? row.id : undefined;
  const runId = typeof row.run_id === "string" ? row.run_id : "";
  const phase = typeof row.phase === "string" ? row.phase : "";
  const status = typeof row.status === "string" ? row.status : "";
  const attempt = typeof row.attempt === "number" ? row.attempt : 0;
  const createdAt = typeof row.created_at === "string" ? row.created_at : "";
  const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
  const lastError =
    typeof row.last_error === "string" && row.last_error.length > 0
      ? row.last_error
      : undefined;

  if (
    id === undefined ||
    runId.length === 0 ||
    phase.length === 0 ||
    status.length === 0 ||
    createdAt.length === 0 ||
    updatedAt.length === 0
  ) {
    return null;
  }

  return {
    id,
    runId,
    phase,
    status,
    attempt,
    createdAt,
    updatedAt,
    lastError,
  };
};

const nowIso = () => new Date().toISOString();

const enqueueJob = async (runId: string, phase: string) => {
  const db = await ensureDb();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO jobs (run_id, phase, status, attempt, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).run(runId, phase, "queued", createdAt, createdAt);
};

const claimJob = async (): Promise<QueueJob | null> => {
  const db = await ensureDb();
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id, run_id, phase, status, attempt, created_at, updated_at, last_error
         FROM jobs
         WHERE status = ?
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get("queued");

    if (!isRecord(row)) {
      return null;
    }

    const job = mapJobRow(row);
    if (!job) {
      return null;
    }

    const updatedAt = nowIso();
    db.prepare(
      `UPDATE jobs
       SET status = ?, attempt = ?, updated_at = ?
       WHERE id = ?`
    ).run("in_progress", job.attempt + 1, updatedAt, job.id);

    return {
      ...job,
      status: "in_progress",
      attempt: job.attempt + 1,
      updatedAt,
    };
  });

  return tx();
};

const requeueJob = async (jobId: number) => {
  const db = await ensureDb();
  db.prepare(
    `UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`
  ).run("queued", nowIso(), jobId);
};

const markJobDone = async (jobId: number) => {
  const db = await ensureDb();
  db.prepare(
    `UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`
  ).run("done", nowIso(), jobId);
};

const markJobFailed = async (jobId: number, message: string) => {
  const db = await ensureDb();
  db.prepare(
    `UPDATE jobs SET status = ?, updated_at = ?, last_error = ? WHERE id = ?`
  ).run("failed", nowIso(), message, jobId);
};

const touchJob = async (jobId: number) => {
  const db = await ensureDb();
  db.prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`).run(nowIso(), jobId);
};

const cancelRunJobs = async (runId: string) => {
  const db = await ensureDb();
  db.prepare(
    `UPDATE jobs SET status = ?, updated_at = ? WHERE run_id = ? AND status IN (?, ?)`
  ).run("cancelled", nowIso(), runId, "queued", "in_progress");
};

const getRunLock = async (runId: string): Promise<RunLock | null> => {
  const db = await ensureDb();
  const row = db
    .prepare(
      `SELECT run_id, locked_at, owner FROM run_locks WHERE run_id = ?`
    )
    .get(runId);
  if (!isRecord(row)) {
    return null;
  }
  const lockedAt =
    typeof row.locked_at === "string" ? row.locked_at : "";
  const owner = typeof row.owner === "string" ? row.owner : "";
  const runIdValue = typeof row.run_id === "string" ? row.run_id : "";
  if (lockedAt.length === 0 || owner.length === 0 || runIdValue.length === 0) {
    return null;
  }
  return { runId: runIdValue, lockedAt, owner };
};

const acquireRunLock = async (runId: string, owner: string) => {
  const db = await ensureDb();
  const tx = db.transaction(() => {
    const existing = db
      .prepare(
        `SELECT run_id, locked_at, owner FROM run_locks WHERE run_id = ?`
      )
      .get(runId);

    if (!isRecord(existing)) {
      db.prepare(
        `INSERT INTO run_locks (run_id, locked_at, owner) VALUES (?, ?, ?)`
      ).run(runId, nowIso(), owner);
      return true;
    }

    const lockedAt =
      typeof existing.locked_at === "string" ? existing.locked_at : "";
    const lockedAtMs = Date.parse(lockedAt);
    const isStale =
      Number.isNaN(lockedAtMs) ||
      Date.now() - lockedAtMs > LOCK_TIMEOUT_MS;
    if (isStale) {
      db.prepare(
        `UPDATE run_locks SET locked_at = ?, owner = ? WHERE run_id = ?`
      ).run(nowIso(), owner, runId);
      return true;
    }

    return false;
  });

  return tx();
};

const releaseRunLock = async (runId: string, owner: string) => {
  const db = await ensureDb();
  db.prepare(
    `DELETE FROM run_locks WHERE run_id = ? AND owner = ?`
  ).run(runId, owner);
};

const touchRunLock = async (runId: string, owner: string) => {
  const db = await ensureDb();
  db.prepare(
    `UPDATE run_locks SET locked_at = ? WHERE run_id = ? AND owner = ?`
  ).run(nowIso(), runId, owner);
};

const forceReleaseRunLock = async (runId: string) => {
  const db = await ensureDb();
  db.prepare(`DELETE FROM run_locks WHERE run_id = ?`).run(runId);
};

const isJobOverMaxAttempts = (job: QueueJob) => job.attempt > MAX_ATTEMPTS;

const getQueueStats = async (): Promise<QueueStats> => {
  const db = await ensureDb();

  const queuedRow = db
    .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status = ?`)
    .get("queued");
  const inProgressRow = db
    .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status = ?`)
    .get("in_progress");
  const lockRow = db
    .prepare(`SELECT COUNT(*) AS count FROM run_locks`)
    .get();

  const queued =
    isRecord(queuedRow) && typeof queuedRow.count === "number"
      ? queuedRow.count
      : 0;
  const inProgress =
    isRecord(inProgressRow) && typeof inProgressRow.count === "number"
      ? inProgressRow.count
      : 0;
  const activeLocks =
    isRecord(lockRow) && typeof lockRow.count === "number"
      ? lockRow.count
      : 0;

  return {
    queued,
    inProgress,
    activeLocks,
  };
};

const recoverStaleQueueState = async (): Promise<QueueRecoveryResult> => {
  const db = await ensureDb();
  const cutoff = Date.now() - LOCK_TIMEOUT_MS;
  const updatedAt = nowIso();

  const inProgressRows = db
    .prepare(`SELECT id, run_id, updated_at FROM jobs WHERE status = ?`)
    .all("in_progress");
  const staleJobIds: number[] = [];
  const staleRunIdsFromJobs: string[] = [];

  for (const row of inProgressRows) {
    if (!isRecord(row)) {
      continue;
    }
    const id = typeof row.id === "number" ? row.id : undefined;
    const runId = typeof row.run_id === "string" ? row.run_id : "";
    const timestamp = typeof row.updated_at === "string" ? row.updated_at : "";
    if (id === undefined || runId.length === 0) {
      continue;
    }
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed) || parsed <= cutoff) {
      staleJobIds.push(id);
      staleRunIdsFromJobs.push(runId);
    }
  }

  let requeuedJobs = 0;
  for (const jobId of staleJobIds) {
    const result = db
      .prepare(
        `UPDATE jobs
         SET status = ?, updated_at = ?, last_error = COALESCE(last_error, ?)
         WHERE id = ? AND status = ?`
      )
      .run("queued", updatedAt, "Recovered stale in_progress job.", jobId, "in_progress");
    requeuedJobs += result.changes;
  }

  const lockRows = db
    .prepare(`SELECT run_id, locked_at FROM run_locks`)
    .all();
  const staleLockRunIds = new Set<string>();
  for (const runId of staleRunIdsFromJobs) {
    staleLockRunIds.add(runId);
  }
  for (const row of lockRows) {
    if (!isRecord(row)) {
      continue;
    }
    const runId = typeof row.run_id === "string" ? row.run_id : "";
    const lockedAt = typeof row.locked_at === "string" ? row.locked_at : "";
    if (runId.length === 0) {
      continue;
    }
    const parsed = Date.parse(lockedAt);
    if (Number.isNaN(parsed) || parsed <= cutoff) {
      staleLockRunIds.add(runId);
    }
  }

  let releasedLocks = 0;
  for (const runId of staleLockRunIds) {
    const result = db
      .prepare(`DELETE FROM run_locks WHERE run_id = ?`)
      .run(runId);
    releasedLocks += result.changes;
  }

  return { requeuedJobs, releasedLocks };
};

export {
  LOCK_TIMEOUT_MS,
  MAX_ATTEMPTS,
  QUEUE_DB_PATH,
  acquireRunLock,
  cancelRunJobs,
  claimJob,
  enqueueJob,
  forceReleaseRunLock,
  getQueueStats,
  getRunLock,
  isJobOverMaxAttempts,
  markJobDone,
  markJobFailed,
  recoverStaleQueueState,
  requeueJob,
  releaseRunLock,
  touchJob,
  touchRunLock,
};
