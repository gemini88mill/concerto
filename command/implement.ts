import { resolve } from "path";
import type { Command } from "commander";
import {
  buildHandoffFromPlan,
  runImplementor,
} from "../orchestrator/state-machine";
import { writeJson } from "../orchestrator/artifacts";
import { updateHandoff } from "../orchestrator/handoff";
import {
  defaultAgentRunOptions,
  errorOutput,
  readPlanFile,
  readRunHandoffFile,
  resolveRunDir,
  stepStartLine,
  successOutput,
  toStepOutput,
} from "./shared";
import { logger } from "../core/logger";

interface ImplementOptions {
  run?: string;
}

export const registerImplementCommand = (program: Command) => {
  program
    .command("implement")
    .description("Run implementor only; applies planned changes to the repo.")
    .option("--run <path>", "Path to orchestrator run directory.")
    .action(async (options: ImplementOptions) => {
      logger.info(stepStartLine("implementor"));
      const runDir = await resolveRunDir(options.run);
      const handoffPath = resolve(runDir, "handoff.json");
      const runHandoff = await readRunHandoffFile(handoffPath);
      if (runHandoff.next?.agent !== "implementer") {
        console.log(
          JSON.stringify(
            errorOutput(
              "implement",
              "handoff.json does not point to implementer as next agent."
            ),
            null,
            2
          )
        );
        return;
      }
      const repoRoot =
        runHandoff.run?.repo?.root && runHandoff.run.repo.root.length > 0
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
        console.log(JSON.stringify(errorOutput("implement", message), null, 2));
        return;
      }

      if (
        implementorHandoff.allowed_files.length === 0 ||
        implementorHandoff.steps.length === 0
      ) {
        console.log(
          JSON.stringify(
            errorOutput(
              "implement",
              "Plan did not provide executable steps or allowed files."
            ),
            null,
            2
          )
        );
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
        console.log(JSON.stringify(toStepOutput("implement", result), null, 2));
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
      console.log(
        JSON.stringify(successOutput("implement", result.value), null, 2)
      );
    });
};
