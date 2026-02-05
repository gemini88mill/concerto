import { resolve } from "path";
import type { Command } from "commander";
import {
  buildHandoffFromPlan,
  runReviewer,
} from "../orchestrator/state-machine";
import { writeJson } from "../orchestrator/artifacts";
import { updateHandoff } from "../orchestrator/handoff";
import {
  errorOutput,
  readImplementorResultFile,
  readPlanFile,
  readRunHandoffFile,
  resolveRunDir,
  stepStartOutput,
  successOutput,
  toStepOutput,
} from "./shared";

interface ReviewOptions {
  run?: string;
}

export const registerReviewCommand = (program: Command) => {
  program
    .command("review")
    .description("Run S3 only.")
    .option("--run <path>", "Path to orchestrator run directory.")
    .action(async (options: ReviewOptions) => {
      console.log(JSON.stringify(stepStartOutput("review"), null, 2));
      const runDir = await resolveRunDir(options.run);
      const handoffPath = resolve(runDir, "handoff.json");
      const runHandoff = await readRunHandoffFile(handoffPath);
      if (runHandoff.next?.agent !== "reviewer") {
        console.log(
          JSON.stringify(
            errorOutput(
              "review",
              "handoff.json does not point to reviewer as next agent."
            ),
            null,
            2
          )
        );
        return;
      }
      const planFile = runHandoff.artifacts.plan ?? "plan.json";
      const implementorFile =
        runHandoff.artifacts.implementation ?? "implementor.json";
      const planPath = resolve(runDir, planFile);
      const implementorPath = resolve(runDir, implementorFile);
      const plan = await readPlanFile(planPath);
      const implementorResult = await readImplementorResultFile(implementorPath);
      let handoff;
      try {
        handoff = await buildHandoffFromPlan(plan);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Invalid plan files.";
        console.log(JSON.stringify(errorOutput("review", message), null, 2));
        return;
      }

      const reviewResult = await runReviewer(handoff, implementorResult);
      if (!reviewResult.ok || !reviewResult.value) {
        console.log(JSON.stringify(toStepOutput("review", reviewResult), null, 2));
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
            instructions: [
              "Address review feedback and update the implementation.",
            ],
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
      console.log(
        JSON.stringify(successOutput("review", reviewResult.value), null, 2)
      );
    });
};
