import type { Command } from "commander";
import { createTask } from "../orchestrator/state-machine";
import { createRunContext, writeJson } from "../orchestrator/artifacts";
import { createQueuedHandoff } from "../orchestrator/handoff";
import { logger } from "../core/logger";
import { resolveTaskInput } from "../core/task-input";
import { enqueueJob, getQueueStats } from "../core/queue";

interface RunOptions {
  repo: string;
  keepWorkspace?: boolean;
  branch?: string;
  startWorker?: boolean;
}

const startBackgroundWorker = () => {
  const child = Bun.spawn(["bun", "index.ts", "worker"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  return child.pid;
};

export const registerRunCommand = (program: Command) => {
  program
    .command("run <task>")
    .description(
      "Submit a run to the queue (returns run id for status tracking)."
    )
    .requiredOption("-r, --repo <url>", "Git repository URL to clone.")
    .option("-k, --keep-workspace", "Keep cloned repository after run.")
    .option(
      "-b, --branch <name>",
      "Base branch to run from (defaults to main/master)."
    )
    .option(
      "--start-worker",
      "Start a background worker process after queueing the run."
    )
    .action(async (task: string, options: RunOptions) => {
      const resolved = await resolveTaskInput(task);
      if (resolved.source === "file" && resolved.filePath) {
        logger.info(`Loaded task from ${resolved.filePath}`);
      }
      // Emit a human-readable progress message instead of JSON for step reporting
      logger.info(`Step: run - starting task '${resolved.task}'`);
      const taskRecord = createTask(resolved.task);
      const context = await createRunContext(taskRecord);
      const handoff = createQueuedHandoff({
        run: {
          id: context.run_id,
          createdAt: taskRecord.created_at,
          repo: {
            root: "",
            branch: "",
            baseBranch: options.branch ?? "",
            url: options.repo,
          },
          keepWorkspace: options.keepWorkspace ?? false,
        },
        task: {
          id: taskRecord.task_id,
          prompt: taskRecord.description,
          mode: "full",
        },
        artifacts: {
          task: "task.json",
          plan: "plan.json",
          implementation: "implementor.json",
          review: "review.json",
          tests: "test.json",
          prDraft: "pr-draft.json",
          handoff: "handoff.json",
          handoffImplementor: "handoff.implementor.json",
          handoffReview: "handoff.review.json",
          handoffTest: "handoff.test.json",
        },
        next: {
          agent: "planner",
          inputArtifacts: ["task.json"],
          instructions: ["Start planning based on the task prompt."],
        },
      });

      await writeJson(`${context.run_dir}/handoff.json`, handoff);
      await enqueueJob(context.run_id, "plan");
      const queueStats = await getQueueStats();

      if (options.startWorker) {
        const pid = startBackgroundWorker();
        logger.info(`Started worker process in background (pid=${pid}).`);
      } else if (
        queueStats.inProgress === 0 &&
        queueStats.activeLocks === 0 &&
        queueStats.queued > 0
      ) {
        logger.warn(
          "Run queued but no active worker detected. Start one with: bun run worker"
        );
      }

      console.log(JSON.stringify({ run_id: context.run_id }, null, 2));
    });
};
