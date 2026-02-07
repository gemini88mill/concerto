import { resolve } from "path";
import type { Command } from "commander";
import { cancelRunJobs, forceReleaseRunLock } from "../core/queue";
import { logger } from "../core/logger";
import { readRunHandoffFile } from "./shared";
import { updateHandoff } from "../orchestrator/handoff";
import { writeJson } from "../orchestrator/artifacts";

export const registerCancelCommand = (program: Command) => {
  program
    .command("cancel <taskId>")
    .description("Cancel a run and release any locks.")
    .action(async (taskId: string) => {
      const runId = taskId.trim();
      if (runId.length === 0) {
        logger.warn("Task id is required to cancel a run.");
        return;
      }

      await cancelRunJobs(runId);
      await forceReleaseRunLock(runId);

      const runDir = resolve(".orchestrator", "runs", runId);
      const handoffPath = resolve(runDir, "handoff.json");
      const handoffFile = Bun.file(handoffPath);
      if (await handoffFile.exists()) {
        const handoff = await readRunHandoffFile(handoffPath);
        const updated = updateHandoff({
          handoff,
          phase: handoff.state.phase,
          status: "cancelled",
          artifact: "handoff.json",
          endedAt: new Date().toISOString(),
          note: "Cancelled by user.",
          next: undefined,
        });
        await writeJson(`${runDir}/handoff.json`, { ...updated, next: undefined });
      }

      logger.info(`Cancelled run ${runId}.`);
    });
};
