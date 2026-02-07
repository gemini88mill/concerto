import { resolve } from "path";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import { buildHandoffFromPlan } from "../orchestrator/state-machine";
import { runImplementor } from "../orchestrator/state-machine";
import { runPlanner } from "../orchestrator/state-machine";
import { runReviewer } from "../orchestrator/state-machine";
import { runTester } from "../orchestrator/state-machine";
import { writeJson } from "../orchestrator/artifacts";
import { updateHandoff } from "../orchestrator/handoff";
import {
  cloneRepo,
  createWorkBranch,
  resolveBaseBranch,
} from "../orchestrator/git";
import {
  LOCK_TIMEOUT_MS,
  acquireRunLock,
  claimJob,
  enqueueJob,
  isJobOverMaxAttempts,
  markJobDone,
  markJobFailed,
  recoverStaleQueueState,
  requeueJob,
  releaseRunLock,
  touchJob,
  touchRunLock,
} from "../core/queue";
import { logger } from "../core/logger";
import {
  defaultAgentRunOptions,
  errorOutput,
  readImplementorResultFile,
  readPlanFile,
  readRunHandoffFile,
} from "./shared";

interface WorkerJob {
  id: number;
  runId: string;
  phase: string;
  attempt: number;
}

const WORKER_SLEEP_MS = 1000;
const REQUEUE_SLEEP_MS = 200;
const HEARTBEAT_INTERVAL_MS = 15000;

const sleep = (ms: number) =>
  new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });

const getRunDir = (runId: string) =>
  resolve(".orchestrator", "runs", runId);

const ensureWorkspaceDir = async (repoRoot: string) => {
  await mkdir(repoRoot, { recursive: true });
};

const resolveNextPhase = (agent?: string) => {
  if (!agent) {
    return "";
  }
  if (agent === "planner") {
    return "plan";
  }
  if (agent === "implementer") {
    return "implement";
  }
  if (agent === "reviewer") {
    return "review";
  }
  if (agent === "tester") {
    return "test";
  }
  if (agent === "pr") {
    return "pr";
  }
  return "";
};

const enqueueNext = async (agent?: string, runId?: string) => {
  if (!agent || !runId) {
    return;
  }
  const phase = resolveNextPhase(agent);
  if (phase.length === 0) {
    return;
  }
  await enqueueJob(runId, phase);
};

const markRunFailed = async (
  runDir: string,
  handoffPath: string,
  phase: string,
  message: string
) => {
  const handoff = await readRunHandoffFile(handoffPath);
  const updated = updateHandoff({
    handoff,
    phase,
    status: "failed",
    artifact: "handoff.json",
    endedAt: new Date().toISOString(),
    note: message,
    next: undefined,
  });
  await writeJson(`${runDir}/handoff.json`, { ...updated, next: undefined });
};

const markRunInProgress = async (
  runDir: string,
  handoffPath: string,
  phase: string
) => {
  const handoff = await readRunHandoffFile(handoffPath);
  await writeJson(`${runDir}/handoff.json`, {
    ...handoff,
    state: {
      ...handoff.state,
      phase,
      status: "in_progress",
    },
  });
};

const handlePlan = async (job: WorkerJob) => {
  const runDir = getRunDir(job.runId);
  const handoffPath = resolve(runDir, "handoff.json");
  const handoff = await readRunHandoffFile(handoffPath);
  if (handoff.state.status === "cancelled") {
    throw new Error("Run cancelled.");
  }

  const repoUrl = handoff.run.repo.url ?? "";
  if (repoUrl.trim().length === 0) {
    throw new Error("Missing repo URL for run.");
  }

  const workspaceDir = await cloneRepo(repoUrl, handoff.run.id);
  await ensureWorkspaceDir(workspaceDir);
  const baseBranch = await resolveBaseBranch(
    workspaceDir,
    handoff.run.repo.baseBranch
  );
  const branchInfo = await createWorkBranch(
    workspaceDir,
    handoff.task.prompt
  );

  const repoUpdate = {
    ...handoff.run.repo,
    root: workspaceDir,
    branch: branchInfo.branchName,
    baseBranch,
  };
  const updatedRun = {
    ...handoff.run,
    repo: repoUpdate,
  };
  await writeJson(handoffPath, { ...handoff, run: updatedRun });

  const planResult = await runPlanner(handoff.task.prompt, defaultAgentRunOptions);
  if (!planResult.ok || !planResult.value) {
    await writeJson(`${runDir}/plan.error.json`, planResult);
    await markRunFailed(runDir, handoffPath, "plan", planResult.error ?? "Planner failed.");
    return;
  }

  await writeJson(`${runDir}/plan.json`, planResult.value);
  const requiresTests = planResult.value.tasks.some(
    (task) => task.requiresTests
  );

  const updated = updateHandoff({
    handoff: { ...handoff, run: updatedRun },
    phase: "plan",
    status: "completed",
    artifact: "plan.json",
    endedAt: new Date().toISOString(),
    next: {
      agent: "implementer",
      inputArtifacts: ["plan.json"],
      instructions: [
        "Implement the plan within allowed files.",
        "Update handoff.json for reviewer.",
      ],
    },
  });

  const constrained = {
    ...updated,
    constraints: {
      ...updated.constraints,
      estimatedFilesChangedLimit: planResult.value.scope.estimatedFilesChanged,
      noBreakingChanges: !planResult.value.scope.breakingChange,
      requireTestsForBehaviorChange: requiresTests,
    },
  };

  await writeJson(`${runDir}/handoff.json`, constrained);
  await writeJson(`${runDir}/handoff.implementor.json`, constrained);
  await enqueueNext(constrained.next?.agent, handoff.run.id);
};

const handleImplement = async (job: WorkerJob) => {
  const runDir = getRunDir(job.runId);
  const handoffPath = resolve(runDir, "handoff.json");
  const runHandoff = await readRunHandoffFile(handoffPath);
  if (runHandoff.state.status === "cancelled") {
    throw new Error("Run cancelled.");
  }

  const repoRoot =
    runHandoff.run.repo.root && runHandoff.run.repo.root.length > 0
      ? runHandoff.run.repo.root
      : process.cwd();
  const planFile = runHandoff.artifacts.plan ?? "plan.json";
  const planPath = resolve(runDir, planFile);
  const plan = await readPlanFile(planPath);
  let implementorHandoff;
  try {
    implementorHandoff = await buildHandoffFromPlan(repoRoot, plan);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid plan files.";
    await writeJson(`${runDir}/implementor.error.json`, errorOutput("implement", message));
    await markRunFailed(runDir, handoffPath, "implement", message);
    return;
  }

  if (
    implementorHandoff.allowed_files.length === 0 ||
    implementorHandoff.steps.length === 0
  ) {
    const message = "Plan did not provide executable steps or allowed files.";
    await writeJson(`${runDir}/implementor.error.json`, errorOutput("implement", message));
    await markRunFailed(runDir, handoffPath, "implement", message);
    return;
  }

  const result = await runImplementor(
    implementorHandoff,
    defaultAgentRunOptions,
    repoRoot
  );

  if (!result.ok || !result.value) {
    if (result.diagnostic?.diff) {
      await writeJson(`${runDir}/implementor.failed.1.json`, {
        step: "implement",
        error: result.error ?? "Implementor failed.",
        diagnostic: result.diagnostic,
      });
    }
    await writeJson(`${runDir}/implementor.error.json`, result);
    await markRunFailed(runDir, handoffPath, "implement", result.error ?? "Implementor failed.");
    return;
  }

  await writeJson(`${runDir}/implementor.json`, result.value);
  const updated = updateHandoff({
    handoff: runHandoff,
    phase: "implement",
    status: "completed",
    artifact: "implementor.json",
    endedAt: new Date().toISOString(),
    artifacts: {
      implementation: "implementor.json",
    },
    next: {
      agent: "reviewer",
      inputArtifacts: [planFile, "implementor.json"],
      instructions: [
        "Review the implementation against the plan and project guidelines.",
        "If rejecting, provide actionable fixes only; do not implement.",
      ],
    },
  });

  await writeJson(`${runDir}/handoff.json`, updated);
  await writeJson(`${runDir}/handoff.review.json`, updated);
  await enqueueNext(updated.next?.agent, runHandoff.run.id);
};

const handleReview = async (job: WorkerJob) => {
  const runDir = getRunDir(job.runId);
  const handoffPath = resolve(runDir, "handoff.json");
  const runHandoff = await readRunHandoffFile(handoffPath);
  if (runHandoff.state.status === "cancelled") {
    throw new Error("Run cancelled.");
  }
  const repoRoot =
    runHandoff.run.repo.root && runHandoff.run.repo.root.length > 0
      ? runHandoff.run.repo.root
      : process.cwd();
  const planFile = runHandoff.artifacts.plan ?? "plan.json";
  const implementorFile =
    runHandoff.artifacts.implementation ?? "implementor.json";
  const planPath = resolve(runDir, planFile);
  const implementorPath = resolve(runDir, implementorFile);
  const plan = await readPlanFile(planPath);
  const implementorResult = await readImplementorResultFile(implementorPath);
  let handoff;
  try {
    handoff = await buildHandoffFromPlan(repoRoot, plan);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid plan files.";
    await writeJson(`${runDir}/review.error.json`, errorOutput("review", message));
    await markRunFailed(runDir, handoffPath, "review", message);
    return;
  }

  const reviewResult = await runReviewer(handoff, implementorResult, repoRoot);
  if (!reviewResult.ok || !reviewResult.value) {
    await writeJson(`${runDir}/review.error.json`, reviewResult);
    await markRunFailed(runDir, handoffPath, "review", reviewResult.error ?? "Reviewer failed.");
    return;
  }

  const reviewApproved = reviewResult.value.decision === "approved";
  const nextAgent = reviewApproved
    ? {
        agent: "tester",
        inputArtifacts: [planFile, implementorFile, "review.json"],
        instructions: [
          "Add or update tests if required by the plan.",
          "Run the configured test command and report results.",
        ],
      }
    : {
        agent: "implementer",
        inputArtifacts: [planFile, implementorFile, "review.json"],
        instructions: ["Address review feedback and update the implementation."],
      };

  const updated = updateHandoff({
    handoff: runHandoff,
    phase: "review",
    status: "completed",
    artifact: "review.json",
    endedAt: new Date().toISOString(),
    artifacts: {
      review: "review.json",
    },
    next: nextAgent,
  });

  await writeJson(`${runDir}/review.json`, reviewResult.value);
  await writeJson(`${runDir}/handoff.json`, updated);
  if (nextAgent.agent === "tester") {
    await writeJson(`${runDir}/handoff.test.json`, updated);
  }
  await enqueueNext(updated.next?.agent, runHandoff.run.id);
};

const handleTest = async (job: WorkerJob) => {
  const runDir = getRunDir(job.runId);
  const handoffPath = resolve(runDir, "handoff.json");
  const runHandoff = await readRunHandoffFile(handoffPath);
  if (runHandoff.state.status === "cancelled") {
    throw new Error("Run cancelled.");
  }
  const repoRoot =
    runHandoff.run.repo.root && runHandoff.run.repo.root.length > 0
      ? runHandoff.run.repo.root
      : process.cwd();
  const planFile = runHandoff.artifacts.plan ?? "plan.json";
  const implementorFile =
    runHandoff.artifacts.implementation ?? "implementor.json";
  const planPath = resolve(runDir, planFile);
  const implementorPath = resolve(runDir, implementorFile);
  const plan = await readPlanFile(planPath);
  const implementorResult = await readImplementorResultFile(implementorPath);
  let handoff;
  try {
    handoff = await buildHandoffFromPlan(repoRoot, plan);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid plan files.";
    await writeJson(`${runDir}/test.error.json`, errorOutput("test", message));
    await markRunFailed(runDir, handoffPath, "test", message);
    return;
  }

  const testsRequired =
    runHandoff.constraints?.requireTestsForBehaviorChange ?? true;
  if (!testsRequired) {
    const skippedResult = {
      task_id: runHandoff.task.id,
      status: "passed",
      tests_added: [],
      test_summary: "Tests not required for this run.",
      coverage_notes: [],
      reason: "Tests skipped by policy.",
      logs: "",
    };

    const nextAgent = {
      agent: "pr",
      inputArtifacts: [planFile, implementorFile, "review.json", "test.json"],
      instructions: [
        "Prepare a PR draft based on the approved implementation and tests.",
      ],
    };

    const updated = updateHandoff({
      handoff: runHandoff,
      phase: "test",
      status: "completed",
      artifact: "test.json",
      endedAt: new Date().toISOString(),
      artifacts: {
        tests: "test.json",
      },
      next: nextAgent,
    });

    await writeJson(`${runDir}/test.json`, skippedResult);
    await writeJson(`${runDir}/handoff.json`, updated);
    await enqueueNext(updated.next?.agent, runHandoff.run.id);
    return;
  }

  const testResult = await runTester(
    handoff,
    implementorResult,
    defaultAgentRunOptions,
    repoRoot
  );

  if (!testResult.ok || !testResult.value) {
    await writeJson(`${runDir}/test.error.json`, testResult);
    await markRunFailed(runDir, handoffPath, "test", testResult.error ?? "Tester failed.");
    return;
  }

  const testsPassed = testResult.value.status === "passed";
  const nextAgent = testsPassed
    ? {
        agent: "pr",
        inputArtifacts: [planFile, implementorFile, "review.json", "test.json"],
        instructions: [
          "Prepare a PR draft based on the approved implementation and tests.",
        ],
      }
    : {
        agent: "implementer",
        inputArtifacts: [planFile, implementorFile, "review.json", "test.json"],
        instructions: ["Fix implementation issues that caused test failures."],
      };

  const updated = updateHandoff({
    handoff: runHandoff,
    phase: "test",
    status: "completed",
    artifact: "test.json",
    endedAt: new Date().toISOString(),
    artifacts: {
      tests: "test.json",
    },
    next: nextAgent,
  });
  await writeJson(`${runDir}/test.json`, testResult.value);
  await writeJson(`${runDir}/handoff.json`, updated);
  await enqueueNext(updated.next?.agent, runHandoff.run.id);
};

const handlePr = async (job: WorkerJob) => {
  const runDir = getRunDir(job.runId);
  const handoffPath = resolve(runDir, "handoff.json");
  const runHandoff = await readRunHandoffFile(handoffPath);
  if (runHandoff.state.status === "cancelled") {
    throw new Error("Run cancelled.");
  }

  const prDraft = {
    task_id: runHandoff.task.id,
    status: "ready_for_review",
    repo: {
      root: runHandoff.run.repo.root,
      branch: runHandoff.run.repo.branch,
      baseBranch: runHandoff.run.repo.baseBranch,
    },
  };

  await writeJson(`${runDir}/pr-draft.json`, prDraft);
  const updated = updateHandoff({
    handoff: runHandoff,
    phase: "pr",
    status: "completed",
    artifact: "pr-draft.json",
    endedAt: new Date().toISOString(),
    artifacts: {
      prDraft: "pr-draft.json",
    },
    next: undefined,
  });
  await writeJson(`${runDir}/handoff.json`, { ...updated, next: undefined });

  const keepWorkspace = runHandoff.run.keepWorkspace ?? false;
  if (!keepWorkspace && runHandoff.run.repo.root.length > 0) {
    await rm(runHandoff.run.repo.root, { recursive: true, force: true });
  }
};

const processJob = async (job: WorkerJob) => {
  if (job.phase === "plan") {
    await handlePlan(job);
    return;
  }
  if (job.phase === "implement") {
    await handleImplement(job);
    return;
  }
  if (job.phase === "review") {
    await handleReview(job);
    return;
  }
  if (job.phase === "test") {
    await handleTest(job);
    return;
  }
  if (job.phase === "pr") {
    await handlePr(job);
    return;
  }
  throw new Error(`Unsupported phase: ${job.phase}`);
};

export const registerWorkerCommand = (program: Command) => {
  program
    .command("worker")
    .description("Run the background worker loop that processes queued runs.")
    .action(async () => {
      const workerId = `worker-${randomUUID()}`;
      logger.info(`Worker started (${workerId}).`);
      logger.info(
        `Worker lock timeout is ${Math.floor(LOCK_TIMEOUT_MS / 1000)}s.`
      );

      while (true) {
        let job;
        try {
          const recovered = await recoverStaleQueueState();
          if (recovered.requeuedJobs > 0 || recovered.releasedLocks > 0) {
            logger.warn(
              `Recovered queue state: requeuedJobs=${recovered.requeuedJobs}, releasedLocks=${recovered.releasedLocks}`
            );
          }

          job = await claimJob();
          if (!job) {
            await sleep(WORKER_SLEEP_MS);
            continue;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Queue maintenance failed.";
          logger.warn(`Queue maintenance failed: ${message}`);
          await sleep(WORKER_SLEEP_MS);
          continue;
        }

        const trimmedJob: WorkerJob = {
          id: job.id,
          runId: job.runId,
          phase: job.phase,
          attempt: job.attempt,
        };

        if (isJobOverMaxAttempts(job)) {
          await markJobFailed(job.id, "Max attempts exceeded.");
          await sleep(REQUEUE_SLEEP_MS);
          continue;
        }

        const lockAcquired = await acquireRunLock(trimmedJob.runId, workerId);
        if (!lockAcquired) {
          await requeueJob(job.id);
          await sleep(REQUEUE_SLEEP_MS);
          continue;
        }

        try {
          const runDir = getRunDir(trimmedJob.runId);
          const handoffPath = resolve(runDir, "handoff.json");
          await markRunInProgress(runDir, handoffPath, trimmedJob.phase);
          const heartbeat = setInterval(() => {
            void touchJob(job.id);
            void touchRunLock(trimmedJob.runId, workerId);
          }, HEARTBEAT_INTERVAL_MS);
          try {
            await processJob(trimmedJob);
            await markJobDone(job.id);
          } finally {
            clearInterval(heartbeat);
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Worker failed.";
          await markJobFailed(job.id, message);
          if (!message.toLowerCase().includes("run cancelled")) {
            const runDir = getRunDir(trimmedJob.runId);
            const handoffPath = resolve(runDir, "handoff.json");
            try {
              await markRunFailed(
                runDir,
                handoffPath,
                trimmedJob.phase,
                message
              );
            } catch {
              // ignore handoff update errors
            }
          }
        } finally {
          await releaseRunLock(trimmedJob.runId, workerId);
        }
      }
    });
};
